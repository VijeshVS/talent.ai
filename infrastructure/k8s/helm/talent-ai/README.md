# talent-ai Helm chart

Phase 12 workload-layer chart for the nine talent.ai services.

## Scope

| Renders | Does **not** render |
| :--- | :--- |
| 9 Deployments | Namespaces |
| 9 Services | ServiceAccounts / RBAC |
| 9 HorizontalPodAutoscalers | ConfigMap `talent-ai-config` |
| | Secret `talent-ai-secrets` |
| | Ingress / NetworkPolicies |
| | ResourceQuota / LimitRange |
| | PodDisruptionBudgets / PriorityClasses |

## Dependency — read this first

The chart **depends on** these objects already existing in the target
namespace:

- `ConfigMap/talent-ai-config`
- `Secret/talent-ai-secrets`

A standalone `helm install` renders pods that start and then fail on missing
configuration. **It does not create a functioning application.** The chart is
a packaging and validation artefact for the workload layer, and the source of
the generated `base/workloads/workloads.generated.yaml` file.

The supported Phase 12 deployment path is the Kustomize overlay:

```bash
kubectl apply -k infrastructure/k8s/overlays/dev
kubectl apply -k infrastructure/k8s/overlays/staging
kubectl apply -k infrastructure/k8s/overlays/production
```

## Values

| Key | Purpose |
| :--- | :--- |
| `namespace` | Namespace rendered into every object. Default `talent-ai`. |
| `image.registry` | Registry path prefix. Default `ghcr.io/vijeshvs/smart-match`. |
| `image.tag` | Tag used by the base render. Overlays replace it with a digest. |
| `configMapName` / `secretName` | Names of the required pre-existing objects. |
| `podSecurityContext` / `containerSecurityContext` | PSA `restricted` profile. |
| `topologySpread` | Base spread constraint (`ScheduleAnyway`). |
| `defaults` | Replicas, resources, probes and HPA defaults. |
| `services` | Per-service port, component, env, resources, probes and HPA caps. |

## Commands

```bash
helm lint infrastructure/k8s/helm/talent-ai
helm template talent-ai infrastructure/k8s/helm/talent-ai --namespace talent-ai
```

The rendered output is committed as
`infrastructure/k8s/base/workloads/workloads.generated.yaml` and drift-gated by
`pnpm k8s:sync-workloads --check`.
