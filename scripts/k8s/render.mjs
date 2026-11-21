#!/usr/bin/env node
// Render the Kustomize base and all three overlays to dist/k8s/<name>.yaml.
//
//   pnpm k8s:render

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const k8sRoot = join(repoRoot, 'infrastructure', 'k8s');
const outDir = join(repoRoot, 'dist', 'k8s');
const kubectlBin = process.env.KUBECTL_BIN || 'kubectl';

const targets = [
  { name: 'base', path: join(k8sRoot, 'base') },
  { name: 'dev', path: join(k8sRoot, 'overlays', 'dev') },
  { name: 'staging', path: join(k8sRoot, 'overlays', 'staging') },
  { name: 'production', path: join(k8sRoot, 'overlays', 'production') },
];

mkdirSync(outDir, { recursive: true });

for (const target of targets) {
  const rendered = execFileSync(kubectlBin, ['kustomize', target.path], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const outPath = join(outDir, `${target.name}.yaml`);
  writeFileSync(outPath, rendered.replace(/\r\n/g, '\n'), 'utf8');
  console.log(`rendered ${target.name} -> ${outPath}`);
}
