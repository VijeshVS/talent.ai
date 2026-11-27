# 🎤 DevOps Presentation Guide — Smart-Match (talent.ai)
### Bring it up fast → Inspect everything with kubectl

> **Narrative:** Use pnpm scripts to start the platform in one shot. Then spend the presentation walking through every layer of the running system using kubectl — pods, services, deployments, HPAs, secrets, network policies, ingress, logs, and live metrics.

---

## 🗺️ Presentation Structure

| Phase | What you do | Tool |
|-------|------------|------|
| **A — Startup** | Bring everything up | `pnpm` |
| **B — Inspect** | Walk through each DevOps concept on the live cluster | `kubectl` |
| **C — CI/CD** | Walk through the GitHub Actions pipelines | GitHub UI |
| **D — Observability** | Live metrics + traces | Grafana / Prometheus |
| **E — Debugging** | Operational runbook | `kubectl` |

---

## PHASE A — Start the Platform (pnpm)

> Run these once at the start. Everything comes up. The rest of the presentation is pure observation.

### Option 1 — Docker Compose stack (simpler, no k8s needed)

```bash
# Step 1: Copy environment config
cp .env.example .env
# (fill in JWT_ACCESS_SECRET and JWT_REFRESH_SECRET with values from:)
openssl rand -hex 32

# Step 2: Start ALL infrastructure (Postgres, MongoDB, Redis, RabbitMQ, Qdrant,
#          Jaeger, Prometheus, Grafana, MailHog + all exporters)
pnpm infra:up

# Step 3: Run database migrations across all 5 schemas
pnpm db:deploy:all

# Step 4: Seed realistic demo data
pnpm db:seed:realistic

# Step 5: Build and start all 9 application services
pnpm stack:up
```

---

### Option 2 — Full Kubernetes cluster (kind, local)

```bash
# One command — builds images, creates kind cluster, deploys everything,
# runs migrations, seeds data, port-forwards API + Grafana + Prometheus
pnpm k8s:local:up
```

> **What this does behind the scenes (9 automated steps):**
> 1. Creates a local `kind` cluster (Kubernetes in Docker)
> 2. Builds all 9 Docker images via multi-stage Dockerfile
> 3. Loads images into kind nodes (no registry needed)
> 4. Creates namespaces + secrets
> 5. Deploys datastores (Postgres, MongoDB, Redis, RabbitMQ, Qdrant) in `talent-ai-data`
> 6. Runs Prisma migrations inside the cluster
> 7. Seeds the demo dataset
> 8. Applies the full `overlays/local` Kustomize overlay (services, HPAs, NetworkPolicies)
> 9. Port-forwards API Gateway `:8080`, Grafana `:3100`, Prometheus `:9090`

---

## PHASE B — Inspect the Running System (kubectl)

> Everything is up. Now walk through each DevOps concept by **looking at** the live cluster.

---

### B1 — Cluster & Nodes

> **Concept:** Kubernetes orchestrates containers across a pool of machines called Nodes. The control plane manages them.

```bash
# What nodes are in our cluster?
kubectl get nodes

# Detailed node info (OS, container runtime, k8s version, capacity)
kubectl describe nodes

# What is the control plane running?
kubectl get pods -n kube-system

# Check cluster info
kubectl cluster-info
```

**Expected output:**
```
NAME                       STATUS   ROLES           AGE
talent-ai-control-plane    Ready    control-plane   5m
talent-ai-worker           Ready    <none>          5m
talent-ai-worker2          Ready    <none>          5m
```

---

### B2 — Namespaces (Isolation)

> **Concept:** Namespaces partition the cluster. App services, datastores, and platform ops are in separate namespaces — they cannot accidentally talk across boundaries.

```bash
# List all namespaces
kubectl get namespaces

# See the 3 namespaces we created
kubectl get namespaces | grep talent-ai

# See the security labels on the app namespace
kubectl describe namespace talent-ai

# See what's in each namespace
kubectl get all -n talent-ai
kubectl get all -n talent-ai-data
kubectl get all -n talent-ai-platform
```

**Point out the Pod Security labels:**
```
pod-security.kubernetes.io/enforce: baseline    ← Any privileged pod is BLOCKED
pod-security.kubernetes.io/audit:   restricted  ← Violations are logged
pod-security.kubernetes.io/warn:    restricted  ← Warnings shown to deployers
```

---

### B3 — Docker Images & Containers

> **Concept:** Every service runs as a container built from a multi-stage Dockerfile. The image is immutable — same binary runs in dev, staging, and production.

```bash
# (If using Docker Compose) — List all running containers
docker ps --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"

# Check resource usage per container
docker stats --no-stream

# Inspect the built image layers (shows the multi-stage output)
docker inspect talent-ai/api-gateway:local

# See image size (multi-stage keeps it lean)
docker images | grep talent-ai
```

**Show the Dockerfile stages:**
```bash
cat infrastructure/docker/Dockerfile.service
```
```
Stage 1 — pruner   : turbo prune → only files THIS service needs
Stage 2 — installer: pnpm install + tsc build → production bundle
Stage 3 — runner   : copy bundle only, run as non-root "node" + tini as PID 1
```

---

### B4 — Pods

> **Concept:** A Pod is the smallest deployable unit in Kubernetes — one or more containers that share network and storage.

```bash
# List all running pods in the app namespace
kubectl get pods -n talent-ai

# List all datastore pods
kubectl get pods -n talent-ai-data

# See pods with more detail (node, IP, restarts)
kubectl get pods -n talent-ai -o wide

# See pods with their labels
kubectl get pods -n talent-ai --show-labels

# Describe a specific pod (events, volumes, env, resource limits)
kubectl describe pod -l app.kubernetes.io/name=api-gateway -n talent-ai

# Check what image a pod is actually running
kubectl get pod -l app.kubernetes.io/name=auth-service -n talent-ai -o jsonpath='{.items[0].spec.containers[0].image}'
```

**Point out in `describe` output:**
- `State: Running` — the container is healthy
- `Limits/Requests` — CPU and memory budgets
- `Mounts` — ConfigMap and Secret mounted as env
- `Events` — history of what happened to this pod

---

### B5 — Deployments (Self-Healing)

> **Concept:** A Deployment tells Kubernetes the desired state — "run 2 replicas of auth-service." If a pod dies, the Deployment controller brings it back automatically.

```bash
# List all deployments
kubectl get deployments -n talent-ai

# See replica counts, desired vs ready
kubectl get deployments -n talent-ai -o wide

# Describe a deployment (strategy, selector, pod template)
kubectl describe deployment api-gateway -n talent-ai

# See the rollout history
kubectl rollout history deployment/api-gateway -n talent-ai

# Watch a live rolling update
kubectl rollout status deployment/api-gateway -n talent-ai

# (Demo) Kill a pod — watch Deployment resurrect it immediately
kubectl delete pod -l app.kubernetes.io/name=auth-service -n talent-ai
kubectl get pods -n talent-ai -w   # watch it come back
```

**Show the rolling update strategy:**
```bash
kubectl get deployment api-gateway -n talent-ai -o jsonpath='{.spec.strategy}' | jq
```
```json
{
  "type": "RollingUpdate",
  "rollingUpdate": {
    "maxSurge": 0,
    "maxUnavailable": 1
  }
}
```
> *"Zero extra pods during update — Kubernetes takes one down, brings the new one up, moves to the next. No downtime."*

---

### B6 — Services (Internal Networking & DNS)

> **Concept:** A Service gives a stable DNS name and virtual IP to a group of pods. Services in Kubernetes are ClusterIP by default — reachable only inside the cluster by name.

```bash
# List all services
kubectl get services -n talent-ai

# List datastore services
kubectl get services -n talent-ai-data

# See all services with their ClusterIP and ports
kubectl get services -n talent-ai -o wide

# Show the full service definition (selector, ports, type)
kubectl describe service api-gateway -n talent-ai
kubectl describe service auth-service -n talent-ai

# Show endpoints — which pod IPs a service is routing to
kubectl get endpoints -n talent-ai
kubectl describe endpoints api-gateway -n talent-ai
```

**Expected output:**
```
NAME                   TYPE        CLUSTER-IP      PORT(S)
api-gateway            ClusterIP   10.96.45.12     8080/TCP
auth-service           ClusterIP   10.96.102.33    5001/TCP
talent-service         ClusterIP   10.96.78.9      5002/TCP
recruiter-service      ClusterIP   10.96.201.44    5003/TCP
engagement-service     ClusterIP   10.96.55.21     5004/TCP
rewards-service        ClusterIP   10.96.88.16     5005/TCP
ai-matching-service    ClusterIP   10.96.119.7     5006/TCP
notification-service   ClusterIP   10.96.37.54     5007/TCP
analytics-service      ClusterIP   10.96.66.30     5008/TCP
```

> *"Each service gets a stable DNS name — `auth-service.talent-ai.svc.cluster.local`. Pods resolve this by name, never by IP. If pods restart and get new IPs, the Service absorbs that change transparently."*

```bash
# Prove DNS resolution works — spawn a debug pod and query
kubectl run debug --image=busybox --restart=Never -n talent-ai -- sleep 300
kubectl exec debug -n talent-ai -- nslookup auth-service.talent-ai.svc.cluster.local
kubectl exec debug -n talent-ai -- wget -qO- http://auth-service:5001/health/liveness
kubectl delete pod debug -n talent-ai
```

---

### B7 — ConfigMaps & Secrets

> **Concept:** Configuration lives outside the container image. ConfigMaps hold non-sensitive config. Secrets hold credentials — base64-encoded, never committed to Git.

```bash
# List all configmaps
kubectl get configmaps -n talent-ai

# View the shared app config
kubectl get configmap talent-ai-config -n talent-ai -o yaml

# List secrets (values are hidden)
kubectl get secrets -n talent-ai

# Describe the secret — shows keys but NOT values
kubectl describe secret talent-ai-secrets -n talent-ai

# See how config is mounted into a pod
kubectl describe pod -l app.kubernetes.io/name=api-gateway -n talent-ai | grep -A 20 "Environment"
```

**Point out in the ConfigMap:**
```
NODE_ENV: production
OTEL_ENABLED: 'false'            ← Toggle tracing without redeploying
AUTH_SERVICE_URL: http://auth-service:5001  ← Service DNS name
QDRANT_URL: http://qdrant:6333
```

**Point out the Secret keys (without values):**
```
DATABASE_URL           ← PostgreSQL connection string
MONGODB_URI            ← MongoDB replica set URI
REDIS_URL              ← Redis connection
RABBITMQ_URL           ← Message broker
JWT_ACCESS_SECRET      ← Token signing key
JWT_REFRESH_SECRET     ← Refresh token key
```

---

### B9 — NetworkPolicies (Zero-Trust Networking)

> **Concept:** By default all pods can talk to all pods. NetworkPolicy flips this — deny everything, then explicitly whitelist only the traffic that must flow.

```bash
# List all network policies
kubectl get networkpolicies -n talent-ai

# Show each policy name and what it covers
kubectl get networkpolicies -n talent-ai -o wide
```

**Walk through the policy list:**
```
NAME                              POD-SELECTOR
default-deny-ingress              <all pods>  → Block ALL incoming traffic
default-deny-egress               <all pods>  → Block ALL outgoing traffic
allow-dns-egress                  <all pods>  → Allow DNS on port 53 (kube-dns only)
allow-ingress-controller-gateway  api-gateway → Only nginx ingress can reach api-gateway
allow-gateway-to-backends         backends    → Only api-gateway can reach backend services
allow-backend-to-data             backends    → Backends can reach their datastores
allow-egress-otlp                 backends    → Backends can send traces to Jaeger
```

```bash
# Describe the default deny — shows it covers all pods
kubectl describe networkpolicy default-deny-ingress -n talent-ai

# Describe the DNS allow — shows kube-dns is the only allowed destination
kubectl describe networkpolicy allow-dns-egress -n talent-ai

# Describe gateway-to-backends — shows selector-based allow
kubectl describe networkpolicy allow-gateway-to-backends -n talent-ai
```

---

### B10 — Ingress (External Traffic Routing)

> **Concept:** Ingress is the front door — it maps external HTTP/HTTPS traffic into internal ClusterIP Services via an nginx Ingress Controller.

```bash
# List ingress rules
kubectl get ingress -n talent-ai

# See the full routing config
kubectl describe ingress talent-ai -n talent-ai
```

**Show what it does:**
```
Host: api.talent.ai (with TLS)
  /ws/*  ──→  notification-service:5007   (WebSocket — long-lived connections)
  /*     ──→  api-gateway:8080            (all HTTP traffic)
```

> *"WebSocket connections go directly to notification-service — bypassing the API gateway — because they're long-lived. The gateway would have to hold thousands of open connections otherwise. The Ingress annotation `proxy-read-timeout: 3600` keeps WebSockets alive for 1 hour."*

```bash
# In local kind (no nginx installed) — port-forward does the same job:
kubectl port-forward svc/api-gateway 8080:8080 -n talent-ai &
kubectl port-forward svc/notification-service 5007:5007 -n talent-ai &

# Test the API
curl http://localhost:8080/health/liveness
curl http://localhost:8080/health/readiness
```

---

### B11 — Horizontal Pod Autoscaler (Auto-Scaling)

> **Concept:** HPA watches CPU/memory and scales pod replicas up and down automatically. Scale out under load, scale in to save cost.

```bash
# List all HPAs
kubectl get hpa -n talent-ai

# Describe api-gateway HPA — see current utilisation vs target
kubectl describe hpa api-gateway -n talent-ai
kubectl describe hpa auth-service -n talent-ai
```

**Show the HPA config (production values):**
```
Name:          api-gateway
Min replicas:  2        ← Always at least 2 pods
Max replicas:  10       ← Never more than 10
Target CPU:    70%      ← Scale up when avg CPU exceeds 70%
Current:       1 replica, 12% CPU utilisation
```

```bash
# Watch HPA decisions in real time
kubectl get hpa -n talent-ai -w

# Manually scale to test (outside HPA control)
kubectl scale deployment/talent-service --replicas=3 -n talent-ai
kubectl get pods -n talent-ai | grep talent-service
# → 3 pods running

# Scale back down
kubectl scale deployment/talent-service --replicas=1 -n talent-ai
```

---

### B12 — ResourceQuota & LimitRange (Resource Governance)

> **Concept:** ResourceQuota caps the total resources the entire namespace can consume. LimitRange sets default limits per pod so no single pod can starve others.

```bash
# Check namespace quota — how much is used vs allowed
kubectl describe resourcequota talent-ai-quota -n talent-ai
```

**Expected output:**
```
Resource          Used    Hard
--------          ----    ----
limits.cpu        2600m   15
limits.memory     2560Mi  15Gi
pods              9       29
requests.cpu      900m    3
requests.memory   896Mi   6Gi
```

```bash
# Check default limits applied to every pod
kubectl describe limitrange -n talent-ai

# Check resource usage right now (requires metrics-server)
kubectl top pods -n talent-ai
kubectl top pods -n talent-ai-data
kubectl top nodes
```

---

### B13 — PodDisruptionBudgets (High Availability)

> **Concept:** PDBs prevent Kubernetes from taking down too many pods at once during voluntary disruptions like node drains or cluster upgrades.

```bash
# List PDBs (only in staging/production — dev removes them)
kubectl get pdb -n talent-ai

# See a specific PDB
kubectl describe pdb api-gateway -n talent-ai
```

**Output shows:**
```
Min available: 1    ← At least 1 api-gateway pod must stay up
Allowed disruptions: 1   ← At most 1 pod can be taken down at a time
```

> *"During a Kubernetes node upgrade, the control plane drains the node — evicting its pods. Without a PDB, it could evict all api-gateway pods simultaneously, causing downtime. The PDB blocks the drain until a replacement pod is Running elsewhere."*

---

## PHASE C — CI/CD Pipelines (GitHub Actions)

> **Concept:** Every code change is automatically validated, built, and published. The pipeline is the gatekeeper — no manual releases.

```bash
# Show the 4 workflow files
ls .github/workflows/
```

---

### Workflow 1: `ci.yml` — The Main Quality Gate

**Triggers:** every push to `main` and every PR

**Job 1 — `quality` (sequential gates):**

```
1. Checkout code (full depth — Turborepo needs git history)
2. pnpm install --frozen-lockfile   (lockfile enforced — no surprise upgrades)
3. Inject throwaway secrets         (openssl rand -hex 32 — no real secrets in CI)
4. pnpm build                       (Turborepo compiles only what changed)
5. pnpm lint                        (ESLint across all packages)
6. pnpm typecheck                   (TypeScript strict check)
7. pnpm test                        (Vitest unit tests)
8. docker compose config --quiet    (validate compose YAML syntax)
```

> **`concurrency: cancel-in-progress: true`** — if a new commit arrives, old CI runs are cancelled automatically. No wasted runner minutes.

**Job 2 — `docker-build` (9 services built in parallel via matrix):**

```yaml
strategy:
  fail-fast: false      # one service failing doesn't cancel others
  matrix:
    include:
      - { service: auth-service,       port: 5001 }
      - { service: talent-service,     port: 5002 }
      - { service: recruiter-service,  port: 5003 }
      - { service: engagement-service, port: 5004 }
      - { service: rewards-service,    port: 5005 }
      - { service: ai-matching-service,port: 5006 }
      - { service: notification-service,port: 5007 }
      - { service: analytics-service,  port: 5008 }
      - { service: api-gateway,        port: 8080 }
```

For each service:
```bash
docker/setup-buildx-action          # multi-platform builder
docker/build-push-action            # build only, don't push
  --cache-from type=gha,scope=$SERVICE   # restore layer cache from GitHub Cache
  --cache-to   type=gha,mode=max         # save new layers back

# Smoke test — just verify the image boots:
docker run --rm --entrypoint node talent-ai/auth-service:ci --version
```

---

### Workflow 2: `docker.yml` — Publish Images to Registry

**Triggers:** push to `main` or a version tag (`v1.2.3`)

```bash
# Authenticates to GitHub Container Registry (GHCR) using GITHUB_TOKEN
# No manual secret needed — GitHub provides this automatically

# Published image tags:
ghcr.io/vijeshvs/smart-match/api-gateway:latest
ghcr.io/vijeshvs/smart-match/api-gateway:v1.2.3     # on git tag
ghcr.io/vijeshvs/smart-match/api-gateway:sha-abc123  # commit SHA (immutable)
```

> *"Three tags — `latest` for convenience, the semantic version for pinning, and the commit SHA for immutability. In production, Kubernetes manifests pin images by SHA digest — never `latest`."*

---

### Workflow 3: `kubernetes-validation.yml` — K8s Safety Net

**Two-job pipeline:**

**Job 1 — `validate` (static analysis, no cluster needed):**

```bash
# 1. Helm lint — catches syntax errors in the chart
helm lint infrastructure/k8s/helm/talent-ai

# 2. Helm template — render manifests for all 4 environments
helm template talent-ai infrastructure/k8s/helm/talent-ai \
  -f infrastructure/k8s/helm/talent-ai/values-dev.yaml \
  > /tmp/helm-dev.yaml
# (also renders staging + production)

# 3. Kubeconform — strict schema validation against k8s API versions
kubeconform -strict -summary \
  -kubernetes-version 1.35.8 \
  /tmp/helm-dev.yaml /tmp/helm-staging.yaml /tmp/helm-production.yaml

# 4. Custom checks
node scripts/k8s/check-rendered.mjs   # security/resource policy checks
node scripts/k8s/validate.mjs         # conftest policy + quota validation
```

**Job 2 — `server-dry-run` (live k8s API validation):**

```bash
# Creates a real kind cluster in CI, then:
kubectl apply --dry-run=server -k infrastructure/k8s/overlays/dev
```
> *"Server-side dry-run sends the manifests to the actual k8s API server — it validates against live state. Catches what static linting can't: missing CRDs, quota violations, RBAC conflicts."*

---

### Workflow 4: `pr-hygiene.yml` — Enforce Standards

**Triggers:** every PR open/edit

```javascript
// Rule 1: title must be: release(<scope>): <description>
if (!/^release\([a-z0-9._/-]+\): .+/.test(title)) {
  core.setFailed('Title must match release(scope): description');
}

// Rule 2: body must not be empty
if (body.trim().length === 0) {
  core.setFailed('PR body must not be empty');
}
```

> *"Code reviewers focus on logic — the machine polices the format every time, consistently, with no effort."*

---

## PHASE D — Observability

> **Concept:** Three pillars — Metrics (Prometheus), Dashboards (Grafana), Traces (Jaeger).

```bash
# Port-forwards already running after pnpm k8s:local:up — open:
# Grafana:    http://localhost:3100  (admin / admin)
# Prometheus: http://localhost:9090
# Jaeger:     http://localhost:16686  (if started)
```

### Live Prometheus queries (run at http://localhost:9090):

```promql
# Is every service up?
up{job="talent-services"}

# Request rate per service (last 5 min)
rate(http_requests_total[5m])

# Error rate — are we seeing 5xx responses?
rate(http_requests_total{status=~"5.."}[5m])

# P95 latency by service
histogram_quantile(0.95,
  rate(http_request_duration_seconds_bucket[5m])
)

# RabbitMQ dead-letter queue depth (failed messages)
rabbitmq_queue_messages{queue="talent.events.dlq"}

# PostgreSQL active connections
pg_stat_activity_count

# Redis memory usage
redis_memory_used_bytes
```

### Grafana dashboards (6 pre-built):

| Dashboard | What it shows |
|-----------|--------------|
| **Platform Overview** | Global health, total request rate |
| **Service Health** | Per-service: Rate, Errors, Duration (RED) |
| **Conversion Funnels** | Business KPIs — signups, applications, hires |
| **AI/TalentLens** | Vector search latency, match score distribution |
| **Events/RabbitMQ** | Queue depths, consumer lag, DLQ growth |
| **Rewards/Analytics** | Gamification metrics, points issued |

### Distributed tracing (Jaeger):

```bash
# Make an API call that spans multiple services
curl http://localhost:8080/api/v1/matches

# In Jaeger UI — search for service: api-gateway
# See the full trace:
# api-gateway (2ms) → ai-matching-service (45ms) → qdrant (38ms)
#                   → talent-service (12ms)       → postgres (8ms)
```

> *"One request = one trace ID. Every service stamps the same ID on its span. You can see exactly where latency lives across the entire system."*

---

## PHASE E — Debugging Runbook

> **Concept:** When things break, you need the right commands instantly.

### Cluster state at a glance:

```bash
# Everything in the app namespace
kubectl get all -n talent-ai

# Everything in the data namespace
kubectl get all -n talent-ai-data

# Recent warnings/errors (first stop for debugging)
kubectl get events -n talent-ai --sort-by=.lastTimestamp
kubectl get events -n talent-ai --field-selector type=Warning
```

### Pod diagnostics:

```bash
# Why is a pod not starting?
kubectl describe pod <pod-name> -n talent-ai
# Look at: Events section → ImagePullBackOff, CrashLoopBackOff, OOMKilled

# Logs from a running pod
kubectl logs deployment/api-gateway -n talent-ai

# Logs from a crashed pod (previous container)
kubectl logs <pod-name> -n talent-ai --previous

# Tail live logs
kubectl logs -f deployment/auth-service -n talent-ai

# Tail logs from ALL pods of a service
kubectl logs -f -l app.kubernetes.io/name=api-gateway -n talent-ai

# Exec into a running pod
kubectl exec -it deployment/api-gateway -n talent-ai -- /bin/sh
```

### Database debugging:

```bash
# Connect to PostgreSQL
kubectl exec -it -n talent-ai-data deployment/postgres -- \
  psql -U talent -d talent_auth

# List tables
kubectl exec -n talent-ai-data deployment/postgres -- \
  psql -U talent -d talent_auth -c "\dt"

# Check active DB connections
kubectl exec -n talent-ai-data deployment/postgres -- \
  psql -U talent -c "SELECT count(*) FROM pg_stat_activity;"

# MongoDB replica set status
kubectl exec -n talent-ai-data deployment/mongodb -- \
  mongosh --quiet --eval "rs.status().members.map(m => ({name: m.name, state: m.stateStr}))"

# Redis health + memory
kubectl exec -n talent-ai-data deployment/redis -- redis-cli ping
kubectl exec -n talent-ai-data deployment/redis -- redis-cli info memory
kubectl exec -n talent-ai-data deployment/redis -- redis-cli DBSIZE

# RabbitMQ queue depths
kubectl exec -n talent-ai-data deployment/rabbitmq -- \
  rabbitmqctl list_queues name messages consumers
```

### Scaling & resource debugging:

```bash
# Resource usage right now
kubectl top pods -n talent-ai
kubectl top pods -n talent-ai-data
kubectl top nodes

# Check HPA decisions
kubectl describe hpa api-gateway -n talent-ai
kubectl describe hpa auth-service -n talent-ai

# Check if quota is exhausted
kubectl describe resourcequota talent-ai-quota -n talent-ai

# Check pod scheduling failures
kubectl describe pod <pending-pod> -n talent-ai
# Look for: Insufficient cpu / Insufficient memory / No nodes available

# Roll back a bad deployment
kubectl rollout undo deployment/api-gateway -n talent-ai
kubectl rollout status deployment/api-gateway -n talent-ai
```

---

## 🚀 Quick Reference — Full Inspection Sequence

> Copy-paste sequence to run after `pnpm k8s:local:up`:

```bash
# ── Cluster ──────────────────────────────────────────────
kubectl get nodes
kubectl get namespaces | grep talent-ai

# ── Pods ─────────────────────────────────────────────────
kubectl get pods -n talent-ai
kubectl get pods -n talent-ai-data
kubectl get pods -n talent-ai -o wide

# ── Deployments ──────────────────────────────────────────
kubectl get deployments -n talent-ai
kubectl rollout history deployment/api-gateway -n talent-ai

# ── Services ─────────────────────────────────────────────
kubectl get services -n talent-ai
kubectl get services -n talent-ai-data
kubectl get endpoints -n talent-ai

# ── Ingress ──────────────────────────────────────────────
kubectl get ingress -n talent-ai
kubectl describe ingress talent-ai -n talent-ai

# ── Config & Secrets ─────────────────────────────────────
kubectl get configmaps -n talent-ai
kubectl get secrets -n talent-ai
kubectl describe secret talent-ai-secrets -n talent-ai

# ── Network Policies ─────────────────────────────────────
kubectl get networkpolicies -n talent-ai

# ── Autoscaling ──────────────────────────────────────────
kubectl get hpa -n talent-ai

# ── Resource Governance ──────────────────────────────────
kubectl describe resourcequota talent-ai-quota -n talent-ai
kubectl get pdb -n talent-ai

# ── Logs ─────────────────────────────────────────────────
kubectl logs -f deployment/api-gateway -n talent-ai

# ── Health Check ─────────────────────────────────────────
kubectl port-forward svc/api-gateway 8080:8080 -n talent-ai &
curl http://localhost:8080/health/liveness
```
