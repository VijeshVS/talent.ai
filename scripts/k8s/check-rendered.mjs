#!/usr/bin/env node
// Rendered-manifest checks for Phase 12 Kubernetes CI validation.
// Fails on: missing required namespaces, invalid/unknown required resources,
// Deployments without resource requests/limits, :latest images, obvious plaintext
// secrets in tracked k8s files, and overly permissive RBAC.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const kubectl = process.env.KUBECTL_BIN || 'kubectl';

function kustomize(path) {
  const out = execFileSync(kubectl, ['kustomize', path], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return YAML.parseAllDocuments(out)
    .map((d) => d.toJSON())
    .filter(Boolean);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const failures = [];
const pass = (name) => console.log(`[PASS] ${name}`);
const fail = (name, detail) => {
  failures.push(name);
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
};

const overlays = ['dev', 'staging', 'production'].map((name) => ({
  name,
  path: `infrastructure/k8s/overlays/${name}`,
  docs: kustomize(`infrastructure/k8s/overlays/${name}`),
}));

// Required namespaces
const requiredNamespaces = ['talent-ai', 'talent-ai-platform', 'talent-ai-data'];
for (const ov of overlays) {
  const names = new Set(ov.docs.filter((d) => d.kind === 'Namespace').map((d) => d.metadata?.name));
  const missing = requiredNamespaces.filter((n) => !names.has(n));
  if (missing.length) fail(`${ov.name}: required namespaces`, `missing ${missing.join(', ')}`);
  else pass(`${ov.name}: required namespaces present`);
}

// Basic resource validity and required workload kinds
for (const ov of overlays) {
  const bad = ov.docs.filter((d) => !d.apiVersion || !d.kind || !d.metadata?.name);
  if (bad.length) fail(`${ov.name}: resource definitions valid`, `${bad.length} invalid object(s)`);
  else pass(`${ov.name}: resource definitions valid`);

  const deployments = ov.docs.filter((d) => d.kind === 'Deployment' && d.metadata?.namespace === 'talent-ai');
  if (deployments.length !== 9) fail(`${ov.name}: 9 app deployments`, `found ${deployments.length}`);
  else pass(`${ov.name}: 9 app deployments present`);
}

// Deployments must have requests/limits and no :latest
for (const ov of overlays) {
  const deployments = ov.docs.filter((d) => d.kind === 'Deployment');
  const missingResources = [];
  const latestImages = [];
  for (const d of deployments) {
    for (const c of d.spec?.template?.spec?.containers || []) {
      const r = c.resources || {};
      if (!r.requests?.cpu || !r.requests?.memory || !r.limits?.cpu || !r.limits?.memory) {
        missingResources.push(`${d.metadata.name}/${c.name}`);
      }
      if (typeof c.image === 'string' && /(^|\/)[^/]+:latest(@|$)?/.test(c.image)) {
        latestImages.push(`${d.metadata.name}:${c.image}`);
      }
    }
  }
  if (missingResources.length) fail(`${ov.name}: container resources`, missingResources.join(', '));
  else pass(`${ov.name}: deployments have requests/limits`);
  if (latestImages.length) fail(`${ov.name}: no :latest images`, latestImages.join(', '));
  else pass(`${ov.name}: no :latest container images`);
}

// RBAC least privilege
for (const ov of overlays) {
  const badBindings = [];
  for (const d of ov.docs.filter((d) => d.kind === 'RoleBinding' || d.kind === 'ClusterRoleBinding')) {
    const role = d.roleRef?.name || '';
    if (role === 'cluster-admin') badBindings.push(`${d.kind}/${d.metadata.name} -> cluster-admin`);
    for (const s of d.subjects || []) {
      if ((s.kind === 'ServiceAccount' && s.name === 'default') || (s.kind === 'Group' && s.name === 'system:masters')) {
        badBindings.push(`${d.kind}/${d.metadata.name} binds ${s.kind}/${s.name}`);
      }
    }
  }
  const badRules = [];
  for (const d of ov.docs.filter((d) => d.kind === 'Role' || d.kind === 'ClusterRole')) {
    for (const r of d.rules || []) {
      const apiGroups = r.apiGroups || [];
      const resources = r.resources || [];
      const verbs = r.verbs || [];
      const star = verbs.includes('*') && (resources.includes('*') || apiGroups.includes('*'));
      const secretsWildcard = resources.includes('secrets') && verbs.includes('*');
      if (star || secretsWildcard) badRules.push(`${d.kind}/${d.metadata.name}`);
    }
  }
  if (badBindings.length || badRules.length) {
    fail(`${ov.name}: RBAC least privilege`, [...badBindings, ...badRules].join('; '));
  } else {
    pass(`${ov.name}: RBAC least privilege checks`);
  }
}

// Security configs
for (const ov of overlays) {
  const deployments = ov.docs.filter((d) => d.kind === 'Deployment' && d.metadata?.namespace === 'talent-ai');
  const issues = [];
  for (const d of deployments) {
    const podSec = d.spec?.template?.spec?.securityContext || {};
    if (podSec.runAsNonRoot !== true) issues.push(`${d.metadata.name}: pod runAsNonRoot`);
    for (const c of d.spec?.template?.spec?.containers || []) {
      const sec = c.securityContext || {};
      if (sec.allowPrivilegeEscalation !== false) issues.push(`${d.metadata.name}/${c.name}: allowPrivilegeEscalation`);
      const caps = sec.capabilities?.drop || [];
      if (!caps.includes('ALL')) issues.push(`${d.metadata.name}/${c.name}: drop ALL`);
    }
  }
  if (issues.length) fail(`${ov.name}: security configs`, issues.join(', '));
  else pass(`${ov.name}: security configs`);
}

// Plaintext secret scan - tracked k8s YAML files only (excluding obvious examples)
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |)?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
];
const allowedValue = /CHANGE_ME|example|placeholder|<[^>]+>|\$\{[^}]+\}|valueFrom:|secretKeyRef:|kind: ExternalSecret|ExternalSecret/i;
const k8sFiles = walk(join(repoRoot, 'infrastructure/k8s')).filter((f) => /\.(ya?ml)$/.test(f));
const secretHits = [];
for (const file of k8sFiles) {
  const text = readFileSync(file, 'utf8');
  for (const pat of secretPatterns) {
    if (pat.test(text)) secretHits.push(`${file}: matches ${pat}`);
  }
  // Catch obvious hardcoded credentials in non-example, non-reference files.
  if (!/\.example\.ya?ml$|external-secret/i.test(file)) {
    for (const m of text.matchAll(/^\s*(?:password|secret|token|api[_-]?key|client[_-]?secret)\s*:\s*("?)([^"\n#]+)\1/gim)) {
      const value = m[2].trim();
      if (!value || allowedValue.test(value) || value.startsWith('$')) continue;
      if (/^(?:true|false|null|\d+)$/.test(value)) continue;
      secretHits.push(`${file}: suspicious literal ${m[1]}`);
    }
  }
}
if (secretHits.length) fail('plaintext secrets scan', secretHits.slice(0, 10).join(' | '));
else pass('plaintext secrets scan');

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll rendered-manifest checks passed.');
