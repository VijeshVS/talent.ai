# Conftest policy set

Phase 12 rendered-manifest tests. Run with:

```bash
conftest test --policy infrastructure/k8s/policies/rego dist/k8s/dev.yaml
conftest test --policy infrastructure/k8s/policies/rego dist/k8s/staging.yaml
conftest test --policy infrastructure/k8s/policies/rego dist/k8s/production.yaml
```

The policy is deliberately **stricter than the namespace PSA setting**:

| Scope | Profile |
| :--- | :--- |
| Nine application Deployments (`component in (backend, edge)`) | `restricted` |
| Prometheus and Grafana | `baseline` (root and absent `securityContext` permitted) |

This is why `talent-ai` enforces `baseline`: the preserved Phase 11
observability pods cannot satisfy `restricted` without an image/hardening
change that is out of Phase 12 scope. The nine application pods are held to
`restricted` by this policy regardless.
