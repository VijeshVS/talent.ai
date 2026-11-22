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
# dev — validated shape; replace the sha256:0000… placeholders with real
# digests before applying (or use the local profile below)
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

## Local single-node profile

`overlays/local` is a laptop profile for kind. It inherits `dev` and adds
in-cluster datastores, one replica per service, and locally built images. It is
not part of `pnpm k8s:validate`.

```bash
pnpm k8s:local:up                 # build, load, deploy, migrate, seed, port-forward
pnpm k8s:local:up --with-portals  # also start the Vite portals on the host
pnpm k8s:local:status
pnpm k8s:local:logs api-gateway
pnpm k8s:local:down               # stop everything and delete the kind cluster
```

What `up` does:

1. creates (or reuses) a one-node kind cluster from `kind/kind-local.yaml`
2. builds the nine service images with `docker compose build`
3. loads them into kind as `talent-ai/<service>:local`
4. applies the namespaces and creates `Secret/talent-ai-secrets`
5. deploys Postgres, MongoDB (single-node `rs0`), Redis, RabbitMQ and Qdrant in
   `talent-ai-data`
6. runs Prisma migrations and seeds auth roles
7. seeds the deterministic synthetic demo dataset across PostgreSQL, MongoDB
   and Qdrant (RabbitMQ event publishing remains optional)
8. applies `overlays/local` (one replica per service; HPAs only for the gateway
   and auth service, pinned to 1/1; no rollout surge)
9. port-forwards `api-gateway:8080` and `notification-service:5007`

Requirements: Docker Desktop running with about 5 GB of memory, `kind`,
`kubectl` and `pnpm`. The in-cluster datastores use the local credentials
`talent` / `talent`. Datastore volumes are `emptyDir`, so data is lost when a
datastore pod restarts; rerun `pnpm k8s:local:up` to migrate and seed again.
The realistic seed uses synthetic accounts and is idempotent, so repeated starts
upsert the same demo dataset instead of duplicating it. The default dataset has
24 candidates; demo login details are in `tools/realistic-seeder/README.md`.
Local application rollouts use `maxSurge: 0` and `maxUnavailable: 1`: updates
may briefly interrupt a service, but do not need an extra pod's memory.

The two portals are not part of the Helm chart. `--with-portals` runs them on
the host with `VITE_API_GATEWAY_URL=http://localhost:8080` and
`VITE_NOTIFICATION_WS_URL=ws://localhost:5007/ws/notifications`.

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
+-- overlays/local/          # single-node laptop profile (kind)
+-- helm/talent-ai/         # workload chart (source of truth)
+-- kind/                   # kind-config.yaml (CI), kind-local.yaml (laptop)
+-- policies/rego/          # conftest policy
`-- observability/          # Phase 11 Prometheus + Grafana
```

## Things to know

- `talent-ai` enforces PSA `baseline` because Prometheus and Grafana run as
  root; the nine app pods satisfy `restricted` and are held to it by policy.
- No metrics-server, so HPAs are inert on a fresh cluster.
- kindnet does not enforce NetworkPolicy; policies are declarative locally.
- No in-cluster datastores in base/staging/production; `talent-ai-data` is
  declared and empty there. The local profile adds ephemeral datastores.
- No PVCs; `/tmp` uses `emptyDir`, and Prometheus/Grafana data is ephemeral.
  The local profile's datastores are `emptyDir` too.
- Portal ingress rules live in `base/networking/ingress-portals.pending.yaml`
  and are intentionally not referenced.
