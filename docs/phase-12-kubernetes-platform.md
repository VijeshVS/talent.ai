# Phase 12 — Kubernetes Platform Foundation

Status: implemented. This document is the authoritative description of the
Kubernetes platform layer introduced in Phase 12.

Phase 12 turns the ad-hoc Phase 9.5 manifests into a layered platform:

- a **Helm chart** that owns the workload layer (Deployments, Services, HPAs),
- a **Kustomize base** that owns the platform layer (namespaces, RBAC,
  configuration, networking, policy),
- three **environment overlays** (`dev`, `staging`, `production`), and
- a **validation pipeline** that renders, schema-checks, policy-checks and
  capacity-checks every overlay.

It does not build images, deploy workloads to a real cluster, provision
databases, or install an ingress controller, metrics-server, CNI, cert-manager
or an OpenTelemetry collector. Those are later phases.

---

## 1. Scope and non-goals

In scope:

| Area                | Delivered                                                         |
| :------------------ | :---------------------------------------------------------------- |
| Directory structure | `infrastructure/k8s/{base,overlays,helm,kind,policies}`           |
| Workload packaging  | Helm chart `infrastructure/k8s/helm/talent-ai`                    |
| Generated workloads | `base/workloads/workloads.generated.yaml`                         |
| Namespaces          | `talent-ai`, `talent-ai-platform`, `talent-ai-data`               |
| RBAC                | 9 workload ServiceAccounts, 1 deployer identity, namespaced Roles |
| Configuration       | `ConfigMap/talent-ai-config`, `Secret` template                   |
| Networking          | 1 Ingress, 18 directional NetworkPolicies                         |
| Policy              | ResourceQuota, LimitRange, 9 PDBs, 2 PriorityClasses              |
| Environments        | `dev`, `staging`, `production` overlays                           |
| CI                  | `.github/workflows/kubernetes-validation.yml`                     |
| Local cluster       | `kind/kind-config.yaml` (pinned node digest)                      |

Out of scope (deferred):

- Cluster provisioning (managed Kubernetes, node pools, autoscaling groups).
- Ingress controller, cert-manager, metrics-server, CNI installation.
- Datastores in-cluster (`talent-ai-data` is declared and empty outside the
  local laptop profile).
- An OpenTelemetry collector or Jaeger deployment.
- Image build/publish changes and the release workflow that writes digests.
- Candidate/recruiter portal workloads (rules are quarantined, not active).
- GitOps controllers (Argo CD / Flux), KMS/External Secrets, service mesh.
- Cluster-scoped RBAC beyond the two PriorityClasses.

---

## 2. Directory layout

```text
infrastructure/
├── kustomization.yaml              # legacy shim: production + observability
└── k8s/
    ├── kustomization.yaml          # legacy shim: production platform overlay
    ├── versions.env                # pinned toolchain versions and checksums
    ├── README.md
    ├── base/
    │   ├── kustomization.yaml
    │   ├── namespaces/             # 3 Namespace objects
    │   ├── rbac/                   # ServiceAccounts, deployer + admin Roles
    │   ├── config/                 # ConfigMap + Secret templates (not applied)
    │   ├── workloads/              # workloads.generated.yaml (from Helm)
    │   ├── networking/             # Ingress, 18 NetworkPolicies, quarantined portal rules
    │   └── policies/               # ResourceQuota, LimitRange, PDBs, PriorityClasses
    ├── overlays/
    │   ├── dev/
    │   ├── staging/
    │   └── production/
    ├── helm/
    │   └── talent-ai/              # Chart.yaml, values.yaml, values.schema.json, templates/
    ├── kind/
    │   └── kind-config.yaml
    ├── policies/
    │   └── rego/                   # conftest policy
    └── observability/              # Phase 11 Prometheus + Grafana (unchanged)
        └── kustomization.yaml      # supplies namespace: talent-ai
```

The directory name is `production`, never `prod`.

---

## 3. Source of truth

There is exactly one authored source per layer, and one generated artefact.

| Layer                                                   | Authored source                           | Consumed as                               |
| :------------------------------------------------------ | :---------------------------------------- | :---------------------------------------- |
| Workloads (9 Deployments, 9 Services, 9 HPAs)           | `helm/talent-ai`                          | `base/workloads/workloads.generated.yaml` |
| Platform (namespaces, RBAC, config, networking, policy) | `base/**` YAML                            | `base/kustomization.yaml`                 |
| Environment differences                                 | `overlays/<env>/kustomization.yaml`       | rendered overlay                          |
| Dashboards / alert rules                                | `scripts/generate-grafana-dashboards.mjs` | `docker/grafana/dashboards/*.json`        |

The workload file is generated, not hand-written:

```bash
pnpm k8s:sync-workloads          # regenerate
pnpm k8s:sync-workloads --check  # fail if the committed file is stale (CI)
```

This mirrors the Phase 11 dashboard generator: one authored source, one
committed build output, drift-gated in CI. Editing
`workloads.generated.yaml` by hand is always wrong — the drift gate rejects it.

**Why not Kustomize `helmCharts`?** Kustomize's Helm generator cannot resolve a
local chart path under its default load restrictor, and `kubectl apply -k` has
no `--enable-helm` flag. The generated-file pattern keeps `kubectl apply -k`
working with the stock binary while preserving the chart as the single source.

---

## 4. Toolchain pins

Recorded in `infrastructure/k8s/versions.env`; every value was verified against
the publisher's checksum.

| Tool                | Version                | Purpose                            |
| :------------------ | :--------------------- | :--------------------------------- |
| Kubernetes baseline | 1.35.8                 | API surface, kind node image       |
| kubeconform         | v0.7.0                 | schema validation                  |
| Schema matrix       | 1.35.0, 1.36.0, 1.37.0 | forward-compatibility check        |
| Helm                | v3.19.0                | `helm lint` / `helm template`      |
| kubectl             | v1.35.8                | embedded Kustomize render, dry-run |
| Kustomize           | v5.7.1                 | standalone renderer (optional)     |
| kind                | v0.33.0                | local cluster                      |
| conftest            | v0.68.2 (OPA 1.15.2)   | policy tests                       |

kind node image:
`kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0`.

kubectl v1.30.2, used by earlier phases, is five minors behind the 1.35 API
server and outside the supported ±1 skew. v1.35.8 is mandatory.

`kubeconform --ignore-missing-schemas` is **not** used. A resource with no
schema is a failure, not a skip.

---

## 5. Object inventory

Rendered by `overlays/production` (81 objects):

| Scope                |  Count | Objects                                                                                                                                                 |
| :------------------- | -----: | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `talent-ai`          |     66 | 9 Deployment, 9 Service, 9 HPA, 9 PDB, 1 ResourceQuota, 1 LimitRange, 9 ServiceAccount, 2 Role, 2 RoleBinding, 1 ConfigMap, 1 Ingress, 13 NetworkPolicy |
| `talent-ai-platform` |      4 | 1 ServiceAccount, 1 Role, 1 RoleBinding, 1 NetworkPolicy                                                                                                |
| `talent-ai-data`     |      6 | 1 Role, 1 RoleBinding, 4 NetworkPolicy                                                                                                                  |
| Cluster-scoped       |      5 | 3 Namespace, 2 PriorityClass                                                                                                                            |
| **Total**            | **81** |                                                                                                                                                         |

The **38 core namespaced objects** are the application and policy set:

```text
9 Deployment + 9 Service + 9 HPA + 9 PodDisruptionBudget
+ 1 ResourceQuota + 1 LimitRange = 38
```

The `Namespace` objects are cluster-scoped and tracked separately from that
count. Identity, configuration, ingress and network-policy objects are counted
in the table above but excluded from the "38" figure.

`dev` renders 72 objects: the 9 PDBs are removed.

---

## 6. Namespaces and Pod Security Admission

| Namespace            | Enforce      | Audit / Warn | Contents                                        |
| :------------------- | :----------- | :----------- | :---------------------------------------------- |
| `talent-ai`          | `baseline`   | `restricted` | Nine application workloads, Prometheus, Grafana |
| `talent-ai-platform` | `restricted` | `restricted` | Deployer identity, platform policy              |
| `talent-ai-data`     | `baseline`   | `restricted` | Declared only; no datastore in Phase 12         |

`talent-ai` enforces `baseline` because the preserved Phase 11 Prometheus and
Grafana pods run as root and carry no `securityContext`. Hardening those images
is out of Phase 12 scope. The nine application pods satisfy `restricted` and are
held to it by the conftest policy regardless of the namespace setting, so the
weaker namespace default cannot silently weaken the application.

No `privileged` container is permitted in any namespace.

---

## 7. RBAC

No ClusterRole or ClusterRoleBinding exists in Phase 12.

| Identity                          | Namespace            | Grants                                      |
| :-------------------------------- | :------------------- | :------------------------------------------ |
| `talent-ai-<service>` ×9          | `talent-ai`          | None. No RoleBinding, no automounted token. |
| `talent-ai-deployer`              | `talent-ai-platform` | Bound to a Role in `talent-ai` (below)      |
| Group `talent-ai-platform-admins` | all three            | Platform policy, read-only visibility       |

The deployer Role is deliberately narrow:

| Allowed                                      | Verbs                                           |
| :------------------------------------------- | :---------------------------------------------- |
| `deployments` (apps)                         | get, list, watch, create, update, patch, delete |
| `services` (core)                            | get, list, watch, create, update, patch, delete |
| `configmaps` (core)                          | get, list, watch, create, update, patch, delete |
| `horizontalpodautoscalers` (autoscaling)     | get, list, watch, create, update, patch, delete |
| `ingresses` (networking.k8s.io)              | get, list, watch, create, update, patch, delete |
| `pods`, `replicasets`, `events`, `endpoints` | get, list, watch                                |

Deliberately absent: `serviceaccounts`, `resourcequotas`, `limitranges`,
`networkpolicies`, `poddisruptionbudgets`, `secrets`, `roles`, `rolebindings`.
Write access to Secrets would allow credential injection; `roles`/`rolebindings`
write would allow privilege escalation. No wildcard verbs, no
`deletecollection`, no `cluster-admin`.

The nine services never call the Kubernetes API, so their ServiceAccounts have
no bindings and `automountServiceAccountToken: false`.

---

## 8. Configuration and secrets

`ConfigMap/talent-ai-config` carries non-secret runtime configuration for all
nine services. Two changes from Phase 9.5:

1. **`PORT` was removed.** Each service reads `PORT` and defaults to its own
   value; a shared `PORT` in the ConfigMap made every pod try to bind the same
   port. The chart sets `PORT` explicitly per service (5001–5008, gateway 8080).
2. **The OTEL endpoint was corrected.** The old value pointed at
   `jaeger-collector.observability.svc.cluster.local`, a namespace that does not
   exist. It now points at `http://jaeger-collector.talent-ai.svc.cluster.local:4318`,
   matching the `allow-egress-otlp` NetworkPolicy selector.

Telemetry strategy is explicit and paired:

```yaml
OTEL_ENABLED: 'false'
OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger-collector.talent-ai.svc.cluster.local:4318
```

Enabling export requires three edits in one change: `OTEL_ENABLED: 'true'`, a
resolvable collector endpoint, and a matching NetworkPolicy egress rule. The
conftest policy fails any render where `OTEL_ENABLED` is `'true'` while the
endpoint is still the Phase 12 placeholder.

`Secret/talent-ai-secrets` is never committed and never referenced by a
kustomization. `base/config/secret.example.yaml` and
`base/config/secret.grafana.example.yaml` are templates only.

```bash
kubectl -n talent-ai create secret generic talent-ai-secrets \
  --from-literal=DATABASE_URL='postgresql://...' \
  --from-literal=MONGODB_URI='mongodb://...' \
  --from-literal=REDIS_URL='redis://...' \
  --from-literal=RABBITMQ_URL='amqp://...' \
  --from-literal=JWT_ACCESS_SECRET='...' \
  --from-literal=JWT_REFRESH_SECRET='...'
```

---

## 9. Workloads

Nine Deployments, nine ClusterIP Services, nine HPAs. All inherit:

- `replicas: 2` (base; overlays override),
- `maxUnavailable: 0`, `maxSurge: 1`, `revisionHistoryLimit: 3`,
- `topologySpreadConstraints` on `kubernetes.io/hostname` (`ScheduleAnyway`;
  production uses `DoNotSchedule`),
- readiness `/health/readiness`, liveness `/health/liveness`,
- PSA `restricted`: `runAsNonRoot`, `runAsUser: 1000`, `fsGroup: 1000`,
  `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`,
  `readOnlyRootFilesystem: true`, `capabilities.drop: [ALL]`,
- an `emptyDir` mounted at `/tmp` (the services write temp files),
- `automountServiceAccountToken: false`.

| Service              | Port | Requests     | Limits       | HPA max (base) |
| :------------------- | ---: | :----------- | :----------- | -------------: |
| api-gateway          | 8080 | 100m / 128Mi | 500m / 384Mi |             12 |
| auth-service         | 5001 | 100m / 192Mi | 500m / 512Mi |             10 |
| talent-service       | 5002 | 100m / 192Mi | 500m / 512Mi |             10 |
| recruiter-service    | 5003 | 100m / 192Mi | 500m / 512Mi |             10 |
| engagement-service   | 5004 | 100m / 192Mi | 500m / 512Mi |             10 |
| rewards-service      | 5005 | 100m / 192Mi | 500m / 512Mi |             10 |
| ai-matching-service  | 5006 | 100m / 192Mi | 500m / 512Mi |             10 |
| notification-service | 5007 | 100m / 192Mi | 500m / 512Mi |              6 |
| analytics-service    | 5008 | 100m / 192Mi | 500m / 512Mi |              8 |

Nine pods at base requests consume **900m CPU / 1,664Mi memory**.

`notification-service` keeps `sessionAffinity: ClientIP` because WebSocket
upgrades must stay pinned to the pod that accepted them.

HPAs target CPU and memory utilization. There is no metrics-server in Phase 12,
so every HPA is inert on a fresh cluster and `replicas` governs.

---

## 10. Environment overlays

| Setting              | dev                                 | staging                                  | production                                                                                         |
| :------------------- | :---------------------------------- | :--------------------------------------- | :------------------------------------------------------------------------------------------------- |
| Cluster              | local kind                          | managed                                  | managed                                                                                            |
| Image reference      | `:latest` (base)                    | digest                                   | digest                                                                                             |
| Replicas             | 2 edge/auth, 1 rest                 | 2 (base)                                 | 3                                                                                                  |
| HPA maxima           | 2 each (Σ 18)                       | gateway/auth 4, others 3 (Σ 29)          | gateway/auth 6, talent/recruiter/engagement/rewards/ai-matching 4, notification/analytics 3 (Σ 38) |
| PodDisruptionBudgets | removed                             | 9 × `minAvailable: 1`                    | 9 × `minAvailable: 1`                                                                              |
| PriorityClass        | none                                | gateway/auth `critical`, rest `standard` | gateway/auth `critical`, rest `standard`                                                           |
| Topology spread      | `ScheduleAnyway`                    | `ScheduleAnyway`                         | `DoNotSchedule`                                                                                    |
| Ingress host         | `api.talent.ai.localhost`, no TLS   | `api.staging.talent.ai`                  | `api.talent.ai`                                                                                    |
| Quota                | 3 CPU / 6Gi, 15 CPU / 15Gi, 29 pods | 4 CPU / 8Gi, 21 CPU / 20Gi, 40 pods      | 5 CPU / 9Gi, 25 CPU / 25Gi, 49 pods                                                                |

**staging and production are not deployable as committed.** Every image is a
`sha256:0000…` placeholder. The release workflow that writes real digests is not
part of Phase 12. Applying either overlay before replacing the placeholders
produces `ImagePullBackOff`. `dev` is the only deployable render.

---

## 11. Networking

### 11.1 Ingress

One Ingress, class `nginx`, host `api.talent.ai`:

| Path  | Backend                     |
| :---- | :-------------------------- |
| `/ws` | `notification-service:5007` |
| `/`   | `api-gateway:8080`          |

WebSocket upgrades bypass the gateway; the 3600 s proxy read/send timeouts keep
them open. The candidate- and recruiter-portal rules are preserved in
`base/networking/ingress-portals.pending.yaml`, which no kustomization
references. They are inert: no portal Service or image exists yet.

### 11.2 NetworkPolicy matrix

Every policy is directional and uses concrete label selectors. There is no
`ipBlock` anywhere, therefore no `0.0.0.0/0` egress. Default deny applies to
ingress and egress in all three namespaces.

`talent-ai` (13 policies):

| Policy                                  | Direction | Selector                       | Allows                                                                                                                                                              |
| :-------------------------------------- | :-------- | :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `default-deny-ingress`                  | Ingress   | all pods                       | nothing                                                                                                                                                             |
| `default-deny-egress`                   | Egress    | all pods                       | nothing                                                                                                                                                             |
| `allow-dns-egress`                      | Egress    | all pods                       | `kube-system`/`k8s-app: kube-dns` TCP+UDP 53                                                                                                                        |
| `allow-ingress-controller-gateway`      | Ingress   | `name: api-gateway`            | `ingress-nginx` ns, TCP 8080                                                                                                                                        |
| `allow-ingress-controller-notification` | Ingress   | `name: notification-service`   | `ingress-nginx` ns, TCP 5007                                                                                                                                        |
| `allow-gateway-egress`                  | Egress    | `name: api-gateway`            | `component: backend`, TCP 5001–5008                                                                                                                                 |
| `allow-gateway-to-backends`             | Ingress   | `component: backend`           | `name: api-gateway`, TCP 5001–5008                                                                                                                                  |
| `allow-prometheus-scrape`               | Ingress   | `component in (backend, edge)` | `name: prometheus`, TCP 5001–5008 + 8080                                                                                                                            |
| `allow-prometheus-egress`               | Egress    | `name: prometheus`             | app `/metrics`; `name in (postgres-exporter, redis-exporter, mongodb-exporter, rabbitmq, qdrant)` on 9187/9121/9216/15692/6333, in `talent-ai` and `talent-ai-data` |
| `allow-grafana-egress`                  | Egress    | `name: grafana`                | `name: prometheus` 9090; `name: postgres` 5432, in `talent-ai` and `talent-ai-data`                                                                                 |
| `allow-prometheus-ingress`              | Ingress   | `name: prometheus`             | `name: grafana`, TCP 9090                                                                                                                                           |
| `allow-egress-datastores`               | Egress    | `component in (backend, edge)` | `talent-ai-data`, `name in (postgres, mongodb, redis, rabbitmq, qdrant)`, TCP 5432/27017/6379/5672/6333                                                             |
| `allow-egress-otlp`                     | Egress    | all pods                       | `name: jaeger-collector`, TCP 4318                                                                                                                                  |

`talent-ai-data` (4 policies): `data-default-deny`, `allow-from-app` (ingress
from `talent-ai` backend/edge on datastore ports), `allow-from-prometheus`
(ingress from Prometheus on exporter ports), `data-allow-dns-egress`.

`talent-ai-platform` (1 policy): `platform-default-deny`.

The datastore and OTLP egress rules are inert in Phase 12 because no such pods
exist. They are the contract that Phase 13 datastores and any future collector
must satisfy.

Prometheus's Phase 11 scrape config still uses same-namespace short names
(`postgres-exporter:9187`, `redis-exporter:9121`, `mongodb-exporter:9216`,
`rabbitmq:15692`, `qdrant:6333`), and Grafana points at `postgres.talent-ai`.
Those Phase 11 manifests are preserved unchanged, so the policies allow both the
current same-namespace names and the `talent-ai-data` landing zone. Phase 13
repoints the endpoints at `talent-ai-data` and the same-namespace peers can then
be removed.

**Enforcement caveat:** kind's default CNI (kindnet) does not enforce
NetworkPolicy. Locally the policies are declarative only. A policy-capable CNI
(Calico, Cilium) is deferred to cluster bootstrap.

---

## 12. Policy objects

### 12.1 ResourceQuota

Aggregate ceiling per namespace. Base carries the dev values; staging and
production patch `spec.hard`.

| Environment | requests.cpu | requests.memory | limits.cpu | limits.memory | pods |
| :---------- | -----------: | --------------: | ---------: | ------------: | ---: |
| dev         |            3 |             6Gi |         15 |          15Gi |   29 |
| staging     |            4 |             8Gi |         21 |          20Gi |   40 |
| production  |            5 |             9Gi |         25 |          25Gi |   49 |

Derivation (production):

```text
ceiling      Σ(HPA max × per-pod request)   = 3,800m / 6,912Mi
surge        one extra pod per Deployment   =   900m / 1,664Mi
observability Prometheus + Grafana          =   200m /   384Mi
required                                    = 4,900m / 8,960Mi
quota hard                                  = 5,000m / 9,216Mi  (headroom 100m CPU, 256Mi memory)
pods         Σ max 38 + 9 surge + 2 obs     = 49
```

Limits are set at the computed ceiling rather than with generous slack:
required limits are 25,000m / 24,704Mi against a quota of 25 CPU / 25Gi
(25,600Mi). CPU limits are exactly at the quota, so any additional pod would be
rejected on `limits.cpu`; that is intentional and is the tightest constraint in
the platform. Memory limits retain 896Mi of headroom.

Overcommit guard: `limits.cpu / requests.cpu ≤ 6` and
`limits.memory / requests.memory ≤ 3`, checked by `quota-report`.

### 12.2 LimitRange

`defaultRequest: 100m / 128Mi`, `default: 500m / 512Mi` per container. Applied
at Pod creation, so a container without resources cannot bypass quota
accounting.

### 12.3 PodDisruptionBudgets

Nine PDBs, `minAvailable: 1`, one per workload. They protect **voluntary**
disruptions only: `kubectl drain`, the eviction API, node upgrades. They are
**not** honoured during node-pressure eviction — that ordering belongs to
PriorityClass.

`dev` removes all nine because most dev Deployments run one replica, where
`minAvailable: 1` would block every drain.

### 12.4 PriorityClasses

| Class                |     Value | Assigned to                   |
| :------------------- | --------: | :---------------------------- |
| `talent-ai-critical` | 1,000,000 | `api-gateway`, `auth-service` |
| `talent-ai-standard` |   100,000 | the other seven               |

PriorityClass governs scheduler preemption and kubelet eviction ordering. It
does not protect against voluntary disruptions. PDB and PriorityClass are
complementary, not interchangeable. `dev` assigns none, so pods use the cluster
default.

---

## 13. Capacity and quota validation

`pnpm k8s:quota <env>` computes, from the rendered overlay:

1. ceiling + surge + observability requests ≤ quota `requests.*`,
2. the same for limits,
3. quota `pods` ≥ `Σ(HPA max) + one surge pod per Deployment + 2`,
4. worst-node peak ≤ 85 % of allocatable per node,
5. overcommit ratios within 6× CPU / 3× memory.

Node profiles:

| Environment | Nodes | Per node      | Allocatable (96 %)  | Schedulable (85 %)  |
| :---------- | ----: | :------------ | :------------------ | :------------------ |
| dev         |     3 | 2 vCPU / 4GiB | 1.92 vCPU / 3,932Mi | 1.63 vCPU / 3,342Mi |
| staging     |     3 | 4 vCPU / 8GiB | 3.84 vCPU / 7,864Mi | 3.26 vCPU / 6,685Mi |
| production  |     4 | 4 vCPU / 8GiB | 3.84 vCPU / 7,864Mi | 3.26 vCPU / 6,685Mi |

**Per-node peak method (corrected during implementation).** The Phase 12 plan's
per-node table was internally inconsistent: its pod-composition column did not
add up to its own pod total. This implementation replaces it with a
deterministic, deliberately conservative bound:

```text
worst_node_pods = ceil(total_pods / node_count) + 1     # +1 skew allowance
peak_cpu        = worst_node_pods × max(per-pod request)
peak_memory     = worst_node_pods × max(per-pod request)
```

Every pod is charged at the largest request in the namespace, so the result
over-estimates rather than under-estimates. Production: 14 pods × 100m /
256Mi = 1,400m / 3,584Mi against 3,260m / 6,685Mi schedulable. The bound is a
scheduling sanity check, not a bin-packing proof; a real cluster must be
verified with the scheduler itself.

**Quota is not validated by server-side dry-run.** ResourceQuota admission is
evaluated when a Pod is created. `kubectl apply --dry-run=server` on a
Deployment validates API acceptance and admission (PSA, LimitRange) but creates
no Pods, so it cannot prove quota capacity. That is why the arithmetic check
exists and is the authoritative quota test.

---

## 14. Storage

No PersistentVolumeClaim is declared in Phase 12. Every workload uses
`emptyDir` only for `/tmp`; Prometheus and Grafana keep their Phase 11
`emptyDir` volumes, so their data is lost on pod restart.

| Environment                  | StorageClass       | Characteristics                                                                                                              |
| :--------------------------- | :----------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| kind (local)                 | `standard`         | `rancher.io/local-path`; `WaitForFirstConsumer`; node-local, **no replication**; pod rescheduling to another node loses data |
| managed (staging/production) | _pending decision_ | Must support `ReadWriteOnce` with zone-aware binding; a default class is assumed, not created here                           |

Datastore persistence is a Phase 13 concern. The `talent-ai-data` namespace and
its NetworkPolicies exist so that phase has a defined landing zone.

---

## 15. Validation pipeline

```bash
pnpm k8s:validate
```

Runs, in order:

1. **Drift gate** — `helm template` output must equal
   `base/workloads/workloads.generated.yaml`.
2. **Helm** — `helm lint` and `helm template --kube-version 1.35.8`.
3. **Render** — `kubectl kustomize` for `base`, `dev`, `staging`, `production`
   and the parent `infrastructure` entrypoint.
4. **Schema** — `kubeconform -strict` against 1.35.0, 1.36.0 and 1.37.0, with
   zero skipped resources.
5. **Policy** — `conftest test --combine` per overlay (one invocation per file,
   so environment detection is not contaminated).
6. **Capacity** — `quota-report` for all three environments.

`conftest` rules enforce:

- readiness and liveness probes on every application container,
- CPU/memory requests and limits on every application container,
- `runAsNonRoot`, `RuntimeDefault` seccomp, no privilege escalation, all
  capabilities dropped, read-only root filesystem,
- no privileged container anywhere,
- no `hostNetwork`/`hostPID`/`hostIPC`,
- the three namespaces exist with the expected PSA labels,
- a ResourceQuota and LimitRange in `talent-ai`,
- digest-pinned images outside `dev`, and no `:latest` outside `dev`,
- no `ipBlock` in any NetworkPolicy,
- no `cluster-admin` ClusterRoleBinding,
- `OTEL_ENABLED: 'true'` never coexists with the placeholder endpoint.

The policy is stricter than the namespace PSA setting on purpose: the nine app
pods are held to `restricted` even though the namespace enforces `baseline` for
the benefit of Prometheus and Grafana.

CI: `.github/workflows/kubernetes-validation.yml` runs `validate` on every change under
`infrastructure/`, `scripts/k8s/` or the workflow itself, then a `dry-run` job
that creates a pinned kind cluster and runs `kubectl apply --dry-run=server` on
the production overlay. Tool versions in the workflow are checked against
`versions.env`; drift fails the job.

---

## 16. Legacy entrypoints

Both historical commands still resolve:

```bash
kubectl apply -k infrastructure        # production platform + observability + generated ConfigMaps
kubectl apply -k infrastructure/k8s    # production platform overlay only
```

They are shims. `infrastructure/k8s/kustomization.yaml` points at
`overlays/production`; `infrastructure/kustomization.yaml` points at
`k8s/overlays/production` plus `k8s/observability` and the two generated
ConfigMaps.

The global `namespace: talent-ai` transformer was removed. Namespaces are now
explicit on every object, because the platform has three namespaces and a
global transformer would force every object into one. The two generated
ConfigMaps receive their namespace through JSON6902 patches.

The global `images:` transformer was also removed: image references are owned by
the overlays, not by the entrypoint.

Because the shims render the production overlay, they inherit its digest
placeholders and are not deployable until the release workflow writes real
digests. Use `kubectl apply -k infrastructure/k8s/overlays/dev` for a
deployable local render.

---

## 17. Local cluster

```bash
kind create cluster --config infrastructure/k8s/kind/kind-config.yaml
```

One control-plane and two workers, all pinned to the node digest above. kindnet
does not enforce NetworkPolicy (see §11.2).

### 17.1 Laptop profile (`overlays/local`)

`kind/kind-config.yaml` is sized for the CI server-side dry-run, not for running
the whole stack. `overlays/local` is an additive, local-only profile for a
single-node kind cluster on a laptop:

```bash
pnpm k8s:local:up                 # one command: build, load, deploy, migrate
pnpm k8s:local:up --with-portals  # also run the Vite portals on the host
pnpm k8s:local:status
pnpm k8s:local:down
```

The overlay inherits `dev` and changes only what a laptop needs:

| Change         | Local value                                                          | Reason                         |
| :------------- | :------------------------------------------------------------------- | :----------------------------- |
| Replicas       | 1 per service                                                        | memory                         |
| HPA min/max    | 1/1                                                                  | no metrics-server              |
| Images         | `talent-ai/<service>:local` via `kind load`                          | no registry/digests            |
| Datastores     | Postgres, MongoDB `rs0`, Redis, RabbitMQ, Qdrant in `talent-ai-data` | no external Compose dependency |
| Storage        | `emptyDir`                                                           | no PVCs; data is ephemeral     |
| CORS / cookies | `http://localhost:3000,3001`, `COOKIE_SECURE=false`                  | host-run portals over HTTP     |
| Ingress        | left inert; `port-forward` instead                                   | no ingress controller          |
| Cluster        | one control-plane node (`kind/kind-local.yaml`)                      | 8 GB laptops                   |

The local profile is intentionally **not** part of `pnpm k8s:validate`; the
three environment overlays remain the validated artefacts. Because kindnet does
not enforce NetworkPolicy, `kubectl port-forward` reaches the pods even though
the Ingress path is not installed.

---

## 18. Known limitations and follow-ups

| Limitation                                         | Consequence                            | Follow-up                       |
| :------------------------------------------------- | :------------------------------------- | :------------------------------ |
| No metrics-server                                  | HPAs inert; `replicas` governs         | Cluster bootstrap               |
| kindnet does not enforce NetworkPolicy             | Policies declarative locally           | Install Calico/Cilium           |
| staging/production digests are placeholders        | Not deployable as committed            | Release workflow writes digests |
| No in-cluster datastores (except `overlays/local`) | Pods fail on connection at runtime     | Phase 13                        |
| No ingress controller / cert-manager               | Ingress is inert                       | Cluster bootstrap               |
| Prometheus/Grafana use `emptyDir`                  | Metrics and dashboards lost on restart | Phase 13+                       |
| Portal ingress rules quarantined                   | Portals have no route                  | Portal deployment phase         |
| Registry path still `ghcr.io/vijeshvs/smart-match` | Legacy naming                          | Rename with image pipeline      |
| `talent-ai-data` empty outside `overlays/local`    | Namespace exists for Phase 13          | Phase 13                        |

---

## 19. Verification record

Every claim in this document was produced by the commands below on
2026-11-20, against the committed tree.

| Check                                                          | Result                                          |
| :------------------------------------------------------------- | :---------------------------------------------- |
| `helm lint`                                                    | 1 chart linted, 0 failed                        |
| `helm template`                                                | 9 Deployments, 9 Services, 9 HPAs               |
| `pnpm k8s:sync-workloads --check`                              | up to date                                      |
| `kubectl kustomize` base / dev / staging / production / parent | all render                                      |
| `kubeconform -strict` all renders × 1.35.0 / 1.36.0 / 1.37.0   | invalid 0, errors 0, skipped 0 for each version |
| `conftest --combine` dev / staging / production                | 28/28 rules pass each                           |
| negative conftest fixture (11 injected violations)             | all 11 detected                                 |
| `quota-report` dev / staging / production                      | all pass                                        |
| legacy `kubectl apply -k` entrypoints                          | both render                                     |
| `pnpm k8s:validate`                                            | 18/18 checks passed                             |
| kind server-side dry-run                                       | see §19.1                                       |

### 19.1 Server-side dry-run

The dry-run requires a running container runtime. The local Docker engine was
started and the pinned kind cluster created, then `kubectl apply
--dry-run=server` was run against the production overlay's 76 non-cluster-scoped
objects after the namespaces and PriorityClasses were applied for real.

`--dry-run=server` validates API acceptance and admission (PSA, LimitRange,
schema, RBAC) but creates no Pods, so it cannot validate ResourceQuota
capacity. That is why §13's arithmetic check exists and is authoritative for
quota.

The same procedure runs in `.github/workflows/kubernetes-validation.yml` on every change.

The negative fixture deliberately injected: a missing readiness probe, a
stripped pod security context, `hostNetwork`, a privileged container, an
`ipBlock: 0.0.0.0/0` egress peer, a missing Namespace, a missing ResourceQuota,
an unpinned `:latest` image outside dev, and `OTEL_ENABLED: 'true'` against the
placeholder endpoint. Each produced a policy failure.
