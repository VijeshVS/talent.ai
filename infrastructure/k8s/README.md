# Kubernetes platform

Phase 12 platform foundation for talent.ai. The full design, rationale and
verification record are in
[`docs/phase-12-kubernetes-platform.md`](../../docs/phase-12-kubernetes-platform.md).

## Layers

| Layer | Authored source | Rendered by |
| :--- | :--- | :--- |
| Workloads — 9 Deployments, 9 Services, 9 HPAs | `helm/talent-ai` | `base/workloads/workloads.generated.yaml` |
| Platform — namespaces, RBAC, config, networking, policy | `base/**` | `base/kustomization.yaml` |
| Environment differences | `overlays/<env>` | that overlay |
| Observability — Prometheus, Grafana | `observability/*.yaml` (Phase 11, unchanged) | `observability/kustomization.yaml` |

`base/workloads/workloads.generated.yaml` is **generated**. Do not edit it by
hand; change the chart and run `pnpm k8s:sync-workloads`. CI fails if the
committed file is stale.

## Apply

```bash
# local / dev — the only deployable render
kubectl apply -k infrastructure/k8s/overlays/dev

# staging / production — replace the sha256:0000… digest placeholders first
kubectl apply -k infrastructure/k8s/overlays/staging
kubectl apply -k infrastructure/k8s/overlays/production
```

Legacy entrypoints still resolve:

```bash
kubectl apply -k infrastructure/k8s   # production platform overlay
kubectl apply -k infrastructure       # production platform + observability
```

Both render the production overlay and therefore inherit its digest
placeholders. They are not deployable until the release workflow writes real
digests.

## Prerequisites

The chart and overlays depend on these existing in `talent-ai`:

- `ConfigMap/talent-ai-config` (rendered by `base/config`)
- `Secret/talent-ai-secrets` (create from the template, never committed)

```bash
cp base/config/secret.example.yaml /tmp/talent-ai-secrets.yaml
# edit every CHANGE_ME value, then:
kubectl apply -f /tmp/talent-ai-secrets.yaml
```

`base/config/secret.grafana.example.yaml` is the optional Grafana admin secret.

## Required tools

Pinned versions are in [`versions.env`](./versions.env). CI verifies the workflow env against that file.

| Tool | Purpose |
|---|---|
| `kubectl` | Kustomize render, server-side dry-run |
| `kustomize` (optional standalone) | Same render path; `kubectl kustomize` also works |
| `helm` | Chart lint/template |
| `kubeconform` | Strict schema validation against Kubernetes versions |
| `conftest` | Rego policy tests |
| `kind` | Local server-side dry-run cluster |
| `node` + `pnpm` | Validation scripts (`scripts/k8s/*`) |

## Local validation commands

```bash
# Full local pipeline (drift, helm, renders, kubeconform, conftest, quota)
pnpm k8s:validate

# Individual checks
pnpm k8s:sync-workloads --check
pnpm k8s:render
kubectl kustomize infrastructure/k8s/overlays/dev
kubectl kustomize infrastructure/k8s/overlays/staging
kubectl kustomize infrastructure/k8s/overlays/production
helm lint infrastructure/k8s/helm/talent-ai
helm template talent-ai infrastructure/k8s/helm/talent-ai --kube-version 1.35.8
helm template talent-ai infrastructure/k8s/helm/talent-ai -f infrastructure/k8s/helm/talent-ai/values-dev.yaml --kube-version 1.35.8
helm template talent-ai infrastructure/k8s/helm/talent-ai -f infrastructure/k8s/helm/talent-ai/values-staging.yaml --kube-version 1.35.8
helm template talent-ai infrastructure/k8s/helm/talent-ai -f infrastructure/k8s/helm/talent-ai/values-production.yaml --kube-version 1.35.8
node scripts/k8s/check-rendered.mjs
pnpm k8s:quota dev

# Server-side dry-run (kind)
kind create cluster --name talent-ai-dev --config infrastructure/k8s/kind/kind-config.yaml
kubectl apply --dry-run=server -k infrastructure/k8s/overlays/dev
```

If the dev dry-run fails with `namespaces ... not found` on a fresh cluster, apply namespace/prerequisite resources first, then rerun the dry-run (see CI workflow for the split-render pattern).

## CI workflow

`.github/workflows/kubernetes-validation.yml` runs on push/PR to `main` and on changes to `infrastructure/k8s/**`, `infrastructure/kustomization.yaml`, `scripts/k8s/**`, the workflow itself, or package manifests.

Jobs:
- **validate**: install pinned tools (checksums verified), render all overlays, run Helm lint/template (default + dev/staging/production values), run strict Kubeconform against configured Kubernetes schema versions, run rendered-manifest checks, then run `pnpm k8s:validate` (conftest/quota/drift/render checks).
- **server-dry-run**: create a pinned kind cluster, render/split dev overlay, apply namespace/PriorityClass prerequisites and dummy ConfigMap/Secret for admission, then run `kubectl apply --dry-run=server -k infrastructure/k8s/overlays/dev`.

`helm/kind-action` installs its own kubectl (v1.31.4 by default) and prepends it
to `PATH`. The workflow passes `kubectl_version` so the action installs the
pinned v1.35.8 instead, and a follow-up step asserts the client version. Without
that, the job silently renders with kustomize v5.4.2.

CI does not deploy to production and uses no production credentials. GitHub Actions permissions are `contents: read`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `workloads.generated.yaml is out of date` | Chart changed but generated file not synced | `pnpm k8s:sync-workloads`, commit result |
| Kubeconform schema errors | Invalid field/kind or wrong apiVersion | Fix manifest/chart; confirm target Kubernetes version in `versions.env` |
| Kubeconform download/network errors | Transient schema fetch failure | Rerun; validation script retries transient fetch errors |
| `:latest` / digest placeholder failures | Immutable image policy | Replace with real digest `@sha256:...` |
| `Secret ... not found` in dry-run/runtime | Secret not created | Create `talent-ai-secrets` from example via secret manager; do not commit plaintext |
| Dry-run `namespaces ... not found` | Fresh cluster, namespaced objects applied before Namespace | Apply namespaces/PriorityClasses first, or use split-render pattern |
| Helm kubeVersion error | Local Helm default version too old/new | Pass `--kube-version 1.35.8` (or pinned baseline) |
| `kubectl kustomize` panics with `nil pointer dereference` | kubectl embeds kustomize < 5.5 (e.g. kubectl v1.31 embeds v5.4.2) and a patch file has multiple `$patch: delete` docs | Use the pinned kubectl v1.35.8; in kind jobs pass `kubectl_version` so kind-action does not shadow it |
| Conftest failure | Security/RBAC/resource policy violation | Read rego message, fix manifest/chart, rerun `pnpm k8s:validate` |

## Layout

```text
k8s/
+-- versions.env            # pinned tool versions and checksums
+-- base/
|   +-- namespaces/         # talent-ai, talent-ai-platform, talent-ai-data
|   +-- rbac/               # 9 workload SAs, deployer + admin Roles
|   +-- config/             # ConfigMap + Secret templates
|   +-- workloads/          # generated from the chart
|   +-- networking/         # Ingress, 18 NetworkPolicies, quarantined portal rules
|   `-- policies/           # ResourceQuota, LimitRange, 9 PDBs, 2 PriorityClasses
+-- overlays/{dev,staging,production}/
+-- helm/talent-ai/         # workload chart (source of truth)
+-- kind/kind-config.yaml   # pinned node image
+-- policies/rego/          # conftest policy
`-- observability/          # Phase 11 Prometheus + Grafana
```

## Things to know

- `talent-ai` enforces PSA `baseline` because Prometheus and Grafana run as
  root; the nine app pods satisfy `restricted` and are held to it by policy.
- No metrics-server, so HPAs are inert on a fresh cluster.
- kindnet does not enforce NetworkPolicy; policies are declarative locally.
- No in-cluster datastores; `talent-ai-data` is declared and empty.
- No PVCs; `/tmp` uses `emptyDir`, and Prometheus/Grafana data is ephemeral.
- Portal ingress rules live in `base/networking/ingress-portals.pending.yaml`
  and are intentionally not referenced.

