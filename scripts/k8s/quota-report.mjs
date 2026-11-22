#!/usr/bin/env node
// Quota-capacity validation for a rendered overlay.
//
// This is the ONLY place quota capacity is validated. A Deployment can be
// created successfully and then have its managed Pods rejected by quota
// admission, because ResourceQuota is evaluated at Pod creation. Server-side
// dry-run therefore cannot prove capacity; this arithmetic test can.
//
//   node scripts/k8s/quota-report.mjs dev|staging|production
//
// Checks:
//   1. ceiling + surge + observability requests <= quota requests
//   2. ceiling + surge + observability limits   <= quota limits
//   3. quota pods >= sum(HPA max) + one surge pod per Deployment + 2 observability pods
//   4. worst-node peak at the ceiling + surge <= 0.85 * allocatable per node
//   5. quota limits/requests <= 6x CPU and <= 3x memory

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const k8sRoot = join(repoRoot, 'infrastructure', 'k8s');
const kubectlBin = process.env.KUBECTL_BIN || 'kubectl';

const env = process.argv[2];
if (!['dev', 'staging', 'production'].includes(env)) {
  console.error('usage: node scripts/k8s/quota-report.mjs dev|staging|production');
  process.exit(2);
}

// Documented capacity profiles. Raw node size; allocatable and schedulable are
// derived below. Exact allocatable is read from `kubectl describe node` during
// the later cluster check.
const capacityProfiles = {
  dev: { nodes: 3, cpuPerNode: 2, memMiPerNode: 4096 },
  staging: { nodes: 3, cpuPerNode: 4, memMiPerNode: 8192 },
  production: { nodes: 4, cpuPerNode: 4, memMiPerNode: 8192 },
};

const ALLOCATABLE_FRACTION = 0.96; // capacity - kube/system reserved - eviction
const SCHEDULABLE_FRACTION = 0.85; // leaves room for DaemonSets and system pods

function parseCpu(value) {
  if (typeof value === 'number') return value * 1000;
  const text = String(value).trim();
  if (text.endsWith('m')) return Number.parseFloat(text.slice(0, -1));
  if (text.endsWith('n')) return Number.parseFloat(text.slice(0, -1)) / 1e6;
  return Number.parseFloat(text) * 1000;
}

function parseMemMi(value) {
  if (typeof value === 'number') return value / (1024 * 1024);
  const text = String(value).trim();
  const units = [
    ['Ki', 1 / 1024],
    ['Mi', 1],
    ['Gi', 1024],
    ['Ti', 1024 * 1024],
  ];
  for (const [suffix, factor] of units) {
    if (text.endsWith(suffix)) {
      return Number.parseFloat(text.slice(0, -suffix.length)) * factor;
    }
  }
  return Number.parseFloat(text) / (1024 * 1024);
}

function loadDocs(path) {
  return YAML.parseAllDocuments(readFileSync(path, 'utf8'))
    .map((doc) => doc.toJSON())
    .filter(Boolean);
}

function podResources(deployment) {
  const container = deployment.spec.template.spec.containers[0];
  const requests = container.resources?.requests ?? {};
  const limits = container.resources?.limits ?? {};
  return {
    reqCpu: parseCpu(requests.cpu),
    reqMem: parseMemMi(requests.memory),
    limCpu: parseCpu(limits.cpu),
    limMem: parseMemMi(limits.memory),
  };
}

const overlayPath = join(k8sRoot, 'overlays', env);
const rendered = execFileSync(kubectlBin, ['kustomize', overlayPath], {
  cwd: repoRoot,
  encoding: 'utf8',
});
const docs = YAML.parseAllDocuments(rendered)
  .map((doc) => doc.toJSON())
  .filter(Boolean);

const deployments = docs.filter(
  (doc) =>
    doc.kind === 'Deployment' &&
    doc.metadata?.namespace === 'talent-ai' &&
    ['backend', 'edge'].includes(doc.metadata?.labels?.['app.kubernetes.io/component']),
);
const hpas = docs.filter((doc) => doc.kind === 'HorizontalPodAutoscaler');
const quota = docs.find(
  (doc) => doc.kind === 'ResourceQuota' && doc.metadata?.namespace === 'talent-ai',
);

if (deployments.length !== 9) {
  console.error(`expected 9 application Deployments, found ${deployments.length}`);
  process.exit(1);
}
if (hpas.length !== 9) {
  console.error(`expected 9 HPAs, found ${hpas.length}`);
  process.exit(1);
}
if (!quota) {
  console.error('missing ResourceQuota in namespace talent-ai');
  process.exit(1);
}

const hpaMax = new Map(hpas.map((hpa) => [hpa.metadata.name, hpa.spec.maxReplicas]));

// Observability is applied by the parent `infrastructure` kustomization, not by
// the overlay, but it consumes the same namespace quota.
const observability = [
  ...loadDocs(join(k8sRoot, 'observability', 'prometheus.yaml')),
  ...loadDocs(join(k8sRoot, 'observability', 'grafana.yaml')),
].filter((doc) => doc.kind === 'Deployment');

let ceilingReqCpu = 0;
let ceilingReqMem = 0;
let ceilingLimCpu = 0;
let ceilingLimMem = 0;
let surgeReqCpu = 0;
let surgeReqMem = 0;
let surgeLimCpu = 0;
let surgeLimMem = 0;
let sumMax = 0;
const rows = [];

for (const deployment of deployments) {
  const name = deployment.metadata.name;
  const max = hpaMax.get(name);
  if (!max) {
    console.error(`no HPA for Deployment ${name}`);
    process.exit(1);
  }
  const resources = podResources(deployment);
  ceilingReqCpu += max * resources.reqCpu;
  ceilingReqMem += max * resources.reqMem;
  ceilingLimCpu += max * resources.limCpu;
  ceilingLimMem += max * resources.limMem;
  surgeReqCpu += resources.reqCpu;
  surgeReqMem += resources.reqMem;
  surgeLimCpu += resources.limCpu;
  surgeLimMem += resources.limMem;
  sumMax += max;
  rows.push({ name, max, ...resources });
}

let obsReqCpu = 0;
let obsReqMem = 0;
let obsLimCpu = 0;
let obsLimMem = 0;
const obsRows = [];
for (const deployment of observability) {
  const resources = podResources(deployment);
  obsReqCpu += resources.reqCpu;
  obsReqMem += resources.reqMem;
  obsLimCpu += resources.limCpu;
  obsLimMem += resources.limMem;
  obsRows.push({ name: deployment.metadata.name, max: 1, ...resources });
}

const totalReqCpu = ceilingReqCpu + surgeReqCpu + obsReqCpu;
const totalReqMem = ceilingReqMem + surgeReqMem + obsReqMem;
const totalLimCpu = ceilingLimCpu + surgeLimCpu + obsLimCpu;
const totalLimMem = ceilingLimMem + surgeLimMem + obsLimMem;
const totalPods = sumMax + deployments.length + observability.length;

const hard = quota.spec.hard;
const quotaReqCpu = parseCpu(hard['requests.cpu']);
const quotaReqMem = parseMemMi(hard['requests.memory']);
const quotaLimCpu = parseCpu(hard['limits.cpu']);
const quotaLimMem = parseMemMi(hard['limits.memory']);
const quotaPods = Number.parseInt(hard.pods, 10);

const failures = [];

if (totalReqCpu > quotaReqCpu) {
  failures.push(`requests.cpu ${totalReqCpu}m exceeds quota ${quotaReqCpu}m`);
}
if (totalReqMem > quotaReqMem) {
  failures.push(
    `requests.memory ${totalReqMem.toFixed(0)}Mi exceeds quota ${quotaReqMem.toFixed(0)}Mi`,
  );
}
if (totalLimCpu > quotaLimCpu) {
  failures.push(`limits.cpu ${totalLimCpu}m exceeds quota ${quotaLimCpu}m`);
}
if (totalLimMem > quotaLimMem) {
  failures.push(
    `limits.memory ${totalLimMem.toFixed(0)}Mi exceeds quota ${quotaLimMem.toFixed(0)}Mi`,
  );
}
if (quotaPods < totalPods) {
  failures.push(`quota pods ${quotaPods} is below required ${totalPods}`);
}

// Per-node peak. This is a conservative bound: the worst node receives the
// rounded-up average pod count plus one skew allowance, and every pod is
// charged at the largest per-pod request in the namespace.
const profile = capacityProfiles[env];
const allocCpuPerNode = profile.cpuPerNode * ALLOCATABLE_FRACTION;
const allocMemPerNode = profile.memMiPerNode * ALLOCATABLE_FRACTION;
const schedCpuPerNode = allocCpuPerNode * SCHEDULABLE_FRACTION;
const schedMemPerNode = allocMemPerNode * SCHEDULABLE_FRACTION;
const worstNodePods = Math.ceil(totalPods / profile.nodes) + 1;
const maxPodCpu = Math.max(...[...rows, ...obsRows].map((row) => row.reqCpu));
const maxPodMem = Math.max(...[...rows, ...obsRows].map((row) => row.reqMem));
const peakCpu = worstNodePods * maxPodCpu;
const peakMem = worstNodePods * maxPodMem;
const schedCpuPerNodeMilli = schedCpuPerNode * 1000;

if (peakCpu > schedCpuPerNodeMilli) {
  failures.push(
    `worst-node CPU ${peakCpu}m exceeds schedulable ${schedCpuPerNodeMilli.toFixed(0)}m`,
  );
}
if (peakMem > schedMemPerNode) {
  failures.push(
    `worst-node memory ${peakMem.toFixed(0)}Mi exceeds schedulable ${schedMemPerNode.toFixed(0)}Mi`,
  );
}
if (quotaLimCpu / quotaReqCpu > 6) {
  failures.push(`CPU overcommit ${(quotaLimCpu / quotaReqCpu).toFixed(2)}x exceeds 6x`);
}
if (quotaLimMem / quotaReqMem > 3) {
  failures.push(`memory overcommit ${(quotaLimMem / quotaReqMem).toFixed(2)}x exceeds 3x`);
}

const pad = (value, width) => String(value).padStart(width);
const padEnd = (value, width) => String(value).padEnd(width);

console.log(`\nQuota report — ${env}\n`);
console.log('Per-workload inputs (requests / limits per pod):');
console.log(
  `  ${padEnd('workload', 26)}${pad('HPA max', 9)}${pad('req CPU', 10)}${pad('req mem', 10)}${pad('lim CPU', 10)}${pad('lim mem', 10)}`,
);
for (const row of [...rows, ...obsRows]) {
  console.log(
    `  ${padEnd(row.name, 26)}${pad(row.max, 9)}${pad(`${row.reqCpu}m`, 10)}${pad(`${row.reqMem.toFixed(0)}Mi`, 10)}${pad(`${row.limCpu}m`, 10)}${pad(`${row.limMem.toFixed(0)}Mi`, 10)}`,
  );
}

console.log('\nQuota derivation:');
console.log(
  `  ceiling (Σ max × pod)      req ${ceilingReqCpu}m / ${ceilingReqMem.toFixed(0)}Mi   lim ${ceilingLimCpu}m / ${ceilingLimMem.toFixed(0)}Mi`,
);
console.log(
  `  surge (1 per Deployment)   req ${surgeReqCpu}m / ${surgeReqMem.toFixed(0)}Mi   lim ${surgeLimCpu}m / ${surgeLimMem.toFixed(0)}Mi`,
);
console.log(
  `  observability (1 each)     req ${obsReqCpu}m / ${obsReqMem.toFixed(0)}Mi   lim ${obsLimCpu}m / ${obsLimMem.toFixed(0)}Mi`,
);
console.log(
  `  required                   req ${totalReqCpu}m / ${totalReqMem.toFixed(0)}Mi   lim ${totalLimCpu}m / ${totalLimMem.toFixed(0)}Mi   pods ${totalPods}`,
);
console.log(
  `  quota hard                 req ${quotaReqCpu}m / ${quotaReqMem.toFixed(0)}Mi   lim ${quotaLimCpu}m / ${quotaLimMem.toFixed(0)}Mi   pods ${quotaPods}`,
);

console.log('\nPer-node peak (conservative bound):');
console.log(
  `  nodes ${profile.nodes} × ${profile.cpuPerNode} vCPU / ${profile.memMiPerNode}Mi raw`,
);
console.log(
  `  allocatable/node ${allocCpuPerNode.toFixed(2)} vCPU / ${allocMemPerNode.toFixed(0)}Mi; schedulable/node ${schedCpuPerNode.toFixed(2)} vCPU / ${schedMemPerNode.toFixed(0)}Mi`,
);
console.log(
  `  worst node ${worstNodePods} pods × ${maxPodCpu}m / ${maxPodMem.toFixed(0)}Mi = ${peakCpu}m / ${peakMem.toFixed(0)}Mi`,
);

if (failures.length > 0) {
  console.error('\nFAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nPASS: quota and per-node capacity checks are satisfied.\n');
