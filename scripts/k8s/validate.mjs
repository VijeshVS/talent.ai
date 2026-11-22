#!/usr/bin/env node
// Phase 12 Kubernetes validation pipeline.
//
//   pnpm k8s:validate
//
// Runs, in order:
//   1. generated-workload drift gate   (helm template vs committed file)
//   2. helm lint + helm template
//   3. kustomize render of base, all overlays, and the parent entrypoint
//   4. kubeconform schema validation against every pinned Kubernetes version
//   5. conftest policy tests (one invocation per overlay, so environment
//      detection is not contaminated by merging renders)
//   6. quota / per-node capacity arithmetic
//
// Tools are resolved from PATH, or from the *_BIN environment variables.
// Versions are read from infrastructure/k8s/versions.env.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const k8sRoot = join(repoRoot, 'infrastructure', 'k8s');
const outDir = join(repoRoot, 'dist', 'k8s');

const bins = {
  helm: process.env.HELM_BIN || 'helm',
  kubectl: process.env.KUBECTL_BIN || 'kubectl',
  kubeconform: process.env.KUBECONFORM_BIN || 'kubeconform',
  conftest: process.env.CONFTEST_BIN || 'conftest',
  node: process.execPath,
};

function loadVersions() {
  const text = readFileSync(join(k8sRoot, 'versions.env'), 'utf8');
  const values = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index === -1) continue;
    values[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return values;
}

const versions = loadVersions();
const kubeVersions = (versions.KUBECONFORM_VERSIONS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const baseline = versions.KUBERNETES_BASELINE || '1.35.8';

const failures = [];
const results = [];

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function run(name, command, args, options = {}) {
  try {
    const output = execFileSync(command, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    record(name, true);
    return { ok: true, output: output || '' };
  } catch (error) {
    const detail =
      (error.stdout || '').toString().trim() ||
      (error.stderr || '').toString().trim() ||
      error.message;
    record(name, false, detail.split('\n').slice(-6).join(' / '));
    return { ok: false, output: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

function renderKustomization(target) {
  return execFileSync(bins.kubectl, ['kustomize', target], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).replace(/\r\n/g, '\n');
}

mkdirSync(outDir, { recursive: true });

console.log('\n== 1. generated workload drift gate ==');
run('workloads.generated.yaml is current', bins.node, [
  join(repoRoot, 'scripts', 'k8s', 'sync-workloads.mjs'),
  '--check',
]);

console.log('\n== 2. helm lint / template ==');
const chartDir = join(k8sRoot, 'helm', 'talent-ai');
run('helm lint', bins.helm, ['lint', chartDir]);
const helmRender = run('helm template', bins.helm, [
  'template',
  'talent-ai',
  chartDir,
  '--namespace',
  'talent-ai',
  '--kube-version',
  baseline,
]);

console.log('\n== 3. kustomize render ==');
const targets = [
  ['base', join(k8sRoot, 'base')],
  ['dev', join(k8sRoot, 'overlays', 'dev')],
  ['staging', join(k8sRoot, 'overlays', 'staging')],
  ['production', join(k8sRoot, 'overlays', 'production')],
  ['parent', join(repoRoot, 'infrastructure')],
];
const rendered = new Map();
for (const [name, target] of targets) {
  try {
    const output = renderKustomization(target);
    writeFileSync(join(outDir, `${name}.yaml`), output, 'utf8');
    rendered.set(name, join(outDir, `${name}.yaml`));
    record(`kustomize render ${name}`, true, `${output.split('\n').length} lines`);
  } catch (error) {
    record(
      `kustomize render ${name}`,
      false,
      (error.stderr || error.message).toString().trim().split('\n').slice(-4).join(' / '),
    );
  }
}

// The committed chart output must match the committed generated file.
if (helmRender.ok && existsSync(join(k8sRoot, 'base', 'workloads', 'workloads.generated.yaml'))) {
  const committed = readFileSync(
    join(k8sRoot, 'base', 'workloads', 'workloads.generated.yaml'),
    'utf8',
  ).replace(/\r\n/g, '\n');
  const body = helmRender.output
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .trimEnd();
  const norm = (text) =>
    JSON.stringify(
      YAML.parseAllDocuments(text)
        .map((d) => d.toJSON())
        .filter(Boolean),
    );
  record(
    'helm template output is contained in workloads.generated.yaml',
    norm(committed) === norm(body),
  );
}

console.log('\n== 4. kubeconform schema validation ==');
if (kubeVersions.length === 0) {
  record('kubeconform version matrix', false, 'KUBECONFORM_VERSIONS is empty');
}

function tryKubeconform(version, paths) {
  try {
    return {
      ok: true,
      output: execFileSync(
        bins.kubeconform,
        ['-strict', '-summary', '-kubernetes-version', version, ...paths],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          maxBuffer: 64 * 1024 * 1024,
        },
      ),
    };
  } catch (error) {
    return {
      ok: false,
      output: `${error.stdout || ''}${error.stderr || ''}` || error.message,
    };
  }
}

function summaryCount(text, label) {
  return Number.parseInt((text.match(new RegExp(`${label}:\\s*(\\d+)`)) || [])[1] ?? '0', 10);
}

// One invocation per Kubernetes version covering every render. kubeconform
// fetches each resource schema once per process, so this is several times
// faster than one invocation per file and far less exposed to a flaky
// connection. A failure is then re-run per file to attribute it.
const allPaths = [...rendered.values()];
for (const version of kubeVersions) {
  let output;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    output = tryKubeconform(version, allPaths);
    if (output.ok) break;
    if (!/failed parsing schema|Errors: [1-9]/i.test(output.output)) break;
  }

  const invalid = summaryCount(output.output, 'Invalid');
  const errors = summaryCount(output.output, 'Errors');
  const skipped = summaryCount(output.output, 'Skipped');
  const detail = output.ok
    ? `invalid ${invalid}, errors ${errors}, skipped ${skipped}`
    : output.output.trim().split('\n').slice(-3).join(' / ');
  record(
    `kubeconform all renders @ k8s ${version}`,
    output.ok && invalid === 0 && errors === 0 && skipped === 0,
    detail,
  );

  if (!output.ok || invalid > 0 || errors > 0 || skipped > 0) {
    for (const [name, path] of rendered) {
      const single = tryKubeconform(version, [path]);
      const bad =
        !single.ok ||
        summaryCount(single.output, 'Invalid') > 0 ||
        summaryCount(single.output, 'Errors') > 0 ||
        summaryCount(single.output, 'Skipped') > 0;
      if (bad) {
        record(
          `kubeconform ${name} @ k8s ${version}`,
          false,
          single.output.trim().split('\n').slice(-3).join(' / '),
        );
      }
    }
  }
}

console.log('\n== 5. conftest policy tests ==');
const policyDir = join(k8sRoot, 'policies', 'rego');
for (const name of ['dev', 'staging', 'production']) {
  const path = rendered.get(name);
  if (!path) {
    record(`conftest ${name}`, false, 'render missing');
    continue;
  }
  run(`conftest ${name}`, bins.conftest, ['test', '--combine', '--policy', policyDir, path]);
}

console.log('\n== 6. quota / per-node capacity ==');
for (const name of ['dev', 'staging', 'production']) {
  run(`quota-report ${name}`, bins.node, [
    join(repoRoot, 'scripts', 'k8s', 'quota-report.mjs'),
    name,
  ]);
}

const passed = results.filter((entry) => entry.ok).length;
console.log(`\n== summary ==\n  ${passed}/${results.length} checks passed`);
if (failures.length > 0) {
  console.error('\nFAILED checks:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\nAll Phase 12 Kubernetes checks passed.\n');
