#!/usr/bin/env node
// Regenerate infrastructure/k8s/base/workloads/workloads.generated.yaml from the
// talent-ai Helm chart. Mirrors scripts/generate-grafana-dashboards.mjs: one
// authored source, one committed build output, drift-gated in CI.
//
//   pnpm k8s:sync-workloads          # write
//   pnpm k8s:sync-workloads --check  # fail if the committed file is stale

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const chartDir = join(repoRoot, 'infrastructure', 'k8s', 'helm', 'talent-ai');
const outputPath = join(
  repoRoot,
  'infrastructure',
  'k8s',
  'base',
  'workloads',
  'workloads.generated.yaml',
);

const helmBin = process.env.HELM_BIN || 'helm';
const kubeVersion = process.env.KUBE_VERSION || '1.35.8';
const check = process.argv.includes('--check');

const header = [
  '# GENERATED FILE — DO NOT EDIT.',
  '# Source: infrastructure/k8s/helm/talent-ai',
  '# Regenerate: pnpm k8s:sync-workloads',
  '',
].join('\n');

function render() {
  return execFileSync(
    helmBin,
    ['template', 'talent-ai', chartDir, '--namespace', 'talent-ai', '--kube-version', kubeVersion],
    { cwd: repoRoot, encoding: 'utf8' },
  )
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .trimEnd();
}

function formatYaml(text) {
  try {
    return execFileSync(
      process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
      ['prettier', '--parser', 'yaml', '--stdin-filepath', outputPath],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        input: text,
        shell: process.platform === 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).replace(/\r\n/g, '\n');
  } catch {
    return text;
  }
}

const content = formatYaml(`${header}${render()}\n`);

if (check) {
  if (!existsSync(outputPath)) {
    console.error(`missing generated file: ${outputPath}`);
    process.exit(1);
  }
  const existing = readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n');
  if (existing !== content) {
    console.error('workloads.generated.yaml is out of date. Run: pnpm k8s:sync-workloads');
    process.exit(1);
  }
  console.log('workloads.generated.yaml is up to date');
} else {
  writeFileSync(outputPath, content, 'utf8');
  console.log(`wrote ${outputPath}`);
}
