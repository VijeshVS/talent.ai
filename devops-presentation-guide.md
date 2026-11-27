# 🎤 DevOps Presentation Guide — Smart-Match (talent.ai)

> **Narrative Thread:** Walk your audience through the entire lifecycle — from a blank terminal to a fully running, monitored, production-ready microservices platform — by executing real commands one by one, explaining the DevOps concept behind each step.

---

## 🗺️ Presentation Structure (30–45 min)

| # | Section | DevOps Concept | Time |
|---|---------|---------------|------|
| 1 | Project Architecture | Microservices + Monorepo | 3 min |
| 2 | Environment & Configuration | Config-as-Code, 12-Factor App | 3 min |
| 3 | Containerisation | Docker Multi-stage Build | 5 min |
| 4 | Infrastructure Bring-up | Docker Compose, IaC | 5 min |
| 5 | Database Migrations | GitOps for Schema | 3 min |
| 6 | Application Services | Service Mesh, Health Checks | 4 min |
| 7 | Kubernetes Deployment | Container Orchestration | 5 min |
| 8 | CI/CD Pipelines | GitHub Actions | 6 min |
| 9 | Observability | Prometheus + Grafana + Jaeger | 5 min |
| 10 | Debugging Commands | Operational Runbook | 3 min |

---

## SECTION 1 — Project Architecture (Monorepo + Microservices)

> **Concept:** Instead of a single giant app, we split concerns into 9 independent services, all living in one **pnpm + Turborepo monorepo** for shared tooling.

### What to show:
```
smart-match/
├── services/
│   ├── api-gateway          ← Port 8080  (single entry point)
│   ├── auth-service         ← Port 5001  (JWT auth)
│   ├── talent-service       ← Port 5002  (candidate profiles)
│   ├── recruiter-service    ← Port 5003  (job postings)
│   ├── engagement-service   ← Port 5004  (applications)
│   ├── rewards-service      ← Port 5005  (gamification)
│   ├── ai-matching-service  ← Port 5006  (vector search / AI)
│   ├── notification-service ← Port 5007  (email/WS events)
│   └── analytics-service    ← Port 5008  (business metrics)
├── apps/
│   ├── candidate-portal     ← React frontend
│   └── recruiter-portal     ← React frontend
├── infrastructure/
│   ├── docker/              ← Docker Compose + Dockerfile
│   └── k8s/                 ← Kubernetes manifests + Helm chart
└── .github/workflows/       ← CI/CD pipelines
```

### Key talking points:
- **Turborepo** orchestrates builds across all services — builds only what changed using its task graph and cache
- Each service is independently deployable, scalable, and owns its own database schema
- The **API Gateway** is the single ingress — no service is exposed directly to clients

---

## SECTION 2 — Environment & Configuration (12-Factor App)

> **Concept:** All configuration lives outside the code — in environment variables. Never hardcode secrets. Use `.env.example` as a contract.

### Commands to run:

```bash
# Step 1 — Show what secrets are needed (the contract)
cat .env.example
```
**Say:** _"The `.env.example` is the contract — it tells any new developer or deployment pipeline exactly what variables are needed. The actual secrets never get committed."_

```bash
# Step 2 — Set up your local environment
cp .env.example .env

# Generate secure JWT secrets (never hardcode!)
openssl rand -hex 32   # → JWT_ACCESS_SECRET
openssl rand -hex 32   # → JWT_REFRESH_SECRET
```

**Key variables to highlight:**
| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | PostgreSQL connection (per service) |
| `MONGODB_URI` | MongoDB replica set |
| `RABBITMQ_URL` | Message broker |
| `JWT_ACCESS_SECRET` | Stateless auth token signing |
| `OTEL_ENABLED` | Toggle OpenTelemetry tracing |
| `QDRANT_URL` | Vector DB for AI matching |

---

## SECTION 3 — Containerisation (Multi-Stage Docker Build)

> **Concept:** Docker packages each service with ALL its dependencies into an immutable, portable image. Multi-stage builds keep the final image lean and secure.

### Show the Dockerfile stages:

```bash
cat infrastructure/docker/Dockerfile.service
```

**Explain the 3 stages:**

```
Stage 1: pruner  (node:22-alpine)
  └─ Uses "turbo prune" to extract ONLY the files this service needs
     → Avoids shipping the entire monorepo into the image

Stage 2: installer  (node:22-alpine)
  └─ Installs only pruned dependencies (layer-cached by Docker)
  └─ Builds TypeScript → JavaScript (dist/)
  └─ Runs "pnpm deploy --prod" → production-only bundle

Stage 3: runner  (node:22-alpine, FINAL IMAGE)
  └─ Copies only the built app from installer
  └─ Runs as unprivileged "node" user (security!)
  └─ Uses "tini" as PID 1 (proper signal handling)
  └─ No build tools, no source code, no dev dependencies
```

### Build a single service image manually:
```bash
docker build \
  -f infrastructure/docker/Dockerfile.service \
  --build-arg SERVICE_NAME=auth-service \
  --build-arg SERVICE_PATH=services/auth-service \
  --build-arg APP_PORT=5001 \
  -t talent-ai/auth-service:local .
```

**Say:** _"The same Dockerfile builds ALL 9 services — just change the build args. This is DRY (Don't Repeat Yourself) applied to infrastructure."_

---

## SECTION 4 — Infrastructure Bring-up (Docker Compose, IaC)

> **Concept:** Infrastructure-as-Code — the entire backing infrastructure is declared in YAML files. One command starts everything reproducibly.

### The two-layer compose structure:

```
docker-compose.yml  (root entry point)
  ├── infrastructure/docker/docker-compose.infra.yml  (datastores + observability)
  └── infrastructure/docker/docker-compose.app.yml    (application services)
```

### Live demo — execute these commands sequentially:

#### Step 1: Start infrastructure only
```bash
pnpm infra:up
# expands to:
# docker compose -f infrastructure/docker/docker-compose.infra.yml up -d
```

**While it starts, explain what's coming up:**
| Container | Purpose | Port |
|-----------|---------|------|
| `talent-ai-postgres` | Primary relational DB | 5432 |
| `talent-ai-mongodb` | Profile/notification store | 27017 |
| `talent-ai-mongodb-init` | One-shot replica set init | — |
| `talent-ai-redis` | Cache + rate limiting | 6379 |
| `talent-ai-rabbitmq` | Async event bus | 5672, 15672 |
| `talent-ai-qdrant` | Vector DB (AI matching) | 6333 |
| `talent-ai-mailhog` | Dev email catcher | 8025 |
| `prometheus` | Metrics store | 9090 |
| `grafana` | Dashboards | 3000 |
| `jaeger` | Distributed tracing | 16686 |

#### Step 2: Verify everything is healthy
```bash
docker compose -f infrastructure/docker/docker-compose.infra.yml ps
```

**Show the healthcheck concept:**
> Every service has a `healthcheck` block — Docker probes it and only marks a container `healthy` once it passes. Downstream services use `depends_on: condition: service_healthy` — so services wait for their dependencies automatically.

```yaml
# Example from docker-compose.infra.yml:
healthcheck:
  test: ['CMD-SHELL', 'pg_isready -U talent -d talent_auth']
  interval: 5s
  timeout: 5s
  retries: 20
  start_period: 10s
```

#### Step 3: Verify MongoDB replica set
```bash
# MongoDB needs a replica set for transactions — the init container bootstraps it
docker logs talent-ai-mongodb-init
```

---

## SECTION 5 — Database Migrations (Schema-as-Code)

> **Concept:** Database schema changes are version-controlled, automated, and reproducible — just like application code. Prisma ORM manages this.

### Commands to run:
```bash
# Deploy all migrations across all services at once
pnpm db:deploy:all
```

**Break it down — this runs in sequence:**
```bash
pnpm db:auth:deploy       # auth schema  → talent_auth DB
pnpm db:recruiter:deploy  # recruiter schema → talent_recruiter DB
pnpm db:engagement:deploy # engagement schema → talent_engagement DB
pnpm db:rewards:deploy    # rewards schema → talent_rewards DB
pnpm db:analytics:deploy  # analytics schema → talent_analytics DB
```

**Key talking point:**
> Each microservice owns its own database schema (Database-per-Service pattern). No two services share tables. This enforces loose coupling.

```bash
# (Optional demo) Seed realistic test data
pnpm db:seed:realistic
```

---

## SECTION 6 — Application Services (Health Checks + Service Discovery)

> **Concept:** Services discover each other by DNS name (not IP). Health endpoints enable the orchestrator to know if a service is alive.

### Start the full stack:
```bash
pnpm stack:up
# expands to: docker compose up -d --build
```

**Verify all services are up:**
```bash
docker compose ps
```

**Show service discovery in action:**
> Inside Docker Compose, services talk to each other by container name — `http://auth-service:5001`. In Kubernetes, this becomes a ClusterIP Service — same concept, different implementation.

```yaml
# api-gateway environment (from docker-compose.app.yml):
AUTH_SERVICE_URL:         http://auth-service:5001
TALENT_SERVICE_URL:       http://talent-service:5002
RECRUITER_SERVICE_URL:    http://recruiter-service:5003
AI_MATCHING_SERVICE_URL:  http://ai-matching-service:5006
```

**Show liveness endpoint:**
```bash
curl http://localhost:8080/health/liveness   # API Gateway
curl http://localhost:5001/health/liveness   # Auth service
curl http://localhost:5006/health/liveness   # AI matching
```

---

## SECTION 7 — Kubernetes (Container Orchestration)

> **Concept:** Docker Compose is great for development. Kubernetes handles production: auto-scaling, self-healing, rolling updates, secrets management.

### Show the layered k8s structure:
```
infrastructure/k8s/
├── base/              ← Platform fundamentals (RBAC, networking, config)
│   ├── namespaces/    ← Isolation between app + data tiers
│   ├── workloads/     ← 9 Deployments + 9 Services + 9 HPAs (auto-generated)
│   ├── networking/    ← NetworkPolicy (zero-trust)
│   └── rbac/          ← Least-privilege service accounts
├── helm/talent-ai/    ← Helm chart (templating engine for k8s manifests)
│   ├── values.yaml         ← Defaults
│   ├── values-dev.yaml     ← Dev overrides
│   ├── values-staging.yaml
│   └── values-production.yaml
├── overlays/          ← Kustomize per-environment patches
│   ├── dev/
│   ├── staging/
│   └── production/
└── observability/     ← Prometheus + Grafana in-cluster
```

### Local Kubernetes cluster with kind:
```bash
# Spin up a full local k8s cluster
pnpm k8s:local
```

**What this does (9 automated steps):**
1. Creates a 1-node **kind** cluster
2. Builds all 9 Docker images
3. Loads them into kind (no registry needed locally)
4. Creates namespace + secrets
5. Deploys datastores (Postgres, MongoDB, Redis, RabbitMQ, Qdrant) in `talent-ai-data` namespace
6. Runs Prisma migrations inside the cluster
7. Seeds demo data
8. Applies `overlays/local` — HPAs, 1 replica, no surge
9. Port-forwards API Gateway, Grafana, Prometheus

### Key Kubernetes concepts to highlight:

```bash
# View running pods
kubectl get pods -n talent-ai

# View Horizontal Pod Autoscalers (auto-scale based on CPU/memory)
kubectl get hpa -n talent-ai

# View services (ClusterIP = internal DNS, LoadBalancer = external)
kubectl get svc -n talent-ai

# View configmaps & secrets
kubectl get configmap,secret -n talent-ai
```

**Show rolling update strategy:**
> When we deploy a new version, k8s replaces pods gradually with zero downtime. In production: `maxSurge: 1, maxUnavailable: 0` — always have extra capacity. In local: `maxSurge: 0, maxUnavailable: 1` — saves memory.

---

## SECTION 8 — CI/CD Pipelines (GitHub Actions)

> **Concept:** Every code change is automatically validated, built, and published. No manual releases — the pipeline is the gatekeeper.

### Show the 4 workflows:

```
.github/workflows/
├── ci.yml                   ← Main CI gate (all PRs + main pushes)
├── docker.yml               ← Publish images to GHCR on release
├── kubernetes-validation.yml ← Validate k8s manifests
└── pr-hygiene.yml           ← Enforce PR title/body standards
```

---

### Workflow 1: `ci.yml` — The Main Gate

**Trigger:** Every push to `main` + every PR

**Two parallel jobs:**

#### Job 1: `quality` — Lint + Typecheck + Test + Build
```yaml
# Pipeline steps in order:
1. actions/checkout@v4         # Get the code
2. pnpm/action-setup@v4        # Set up pnpm (exact version pinned)
3. actions/setup-node@v4       # Node 22 (pinned), pnpm cache layer
4. pnpm install --frozen-lockfile  # Reproducible install (lockfile enforced)
5. Prepare test environment    # Inject throwaway secrets (openssl rand)
6. pnpm build                  # Compile all services via Turborepo
7. pnpm lint                   # ESLint across all packages
8. pnpm typecheck               # TypeScript strict check
9. pnpm test                   # Vitest unit tests
10. docker compose config       # Verify compose files are valid YAML
```

> **Key concept:** `concurrency: cancel-in-progress: true` — if a new commit comes in, old CI runs are cancelled automatically. No wasted minutes.

#### Job 2: `docker-build` — Build & Smoke Test all 9 Images

```yaml
# Runs in parallel (matrix strategy):
strategy:
  fail-fast: false          # If auth-service fails, still test others
  matrix:
    include:
      - { service: auth-service,       port: 5001 }
      - { service: talent-service,     port: 5002 }
      - { service: recruiter-service,  port: 5003 }
      - { service: ai-matching-service,port: 5006 }
      # ... 5 more services
```

```bash
# After build, smoke test the image:
docker run --rm --entrypoint node talent-ai/auth-service:ci --version
```

> **Why matrix strategy?** All 9 builds run simultaneously — total CI time = time for slowest service, not sum of all services.

---

### Workflow 2: `docker.yml` — Publish to Registry

**Trigger:** Push to `main` or a version tag (`v*`)

```bash
# Publishes to GitHub Container Registry (GHCR):
ghcr.io/<owner>/smart-match/auth-service:latest
ghcr.io/<owner>/smart-match/auth-service:v1.2.3   # on tag

# Key features:
# - Authenticates to GHCR using GITHUB_TOKEN (no manual secret needed)
# - Docker layer cache stored in GitHub Actions Cache (type=gha)
# - Multi-architecture builds with docker/setup-buildx-action
```

---

### Workflow 3: `kubernetes-validation.yml` — K8s Manifest Safety Net

**Two-job pipeline:**

#### Job 1: `validate`
```bash
# 1. Helm lint — catches syntax errors
helm lint infrastructure/k8s/helm/talent-ai

# 2. Helm template — render manifests for all 4 environments
helm template talent-ai infrastructure/k8s/helm/talent-ai > /tmp/helm-default.yaml
helm template talent-ai ... -f values-dev.yaml > /tmp/helm-dev.yaml
helm template talent-ai ... -f values-production.yaml > /tmp/helm-production.yaml

# 3. Kubeconform — strict schema validation against k8s API versions
kubeconform -strict -summary -kubernetes-version 1.35.8 /tmp/dev.yaml

# 4. Custom checks — node scripts
node scripts/k8s/check-rendered.mjs   # business logic checks
pnpm k8s:validate                     # conftest policy + quota checks
```

#### Job 2: `server-dry-run`
```bash
# Creates a REAL kind cluster, then:
kubectl apply --dry-run=server -k infrastructure/k8s/overlays/dev
# Sends manifests to the k8s API server for validation — catches issues
# that static linting can't (like missing CRDs or RBAC conflicts)
```

---

### Workflow 4: `pr-hygiene.yml` — Enforce Standards

> **Concept:** Automate the boring policing so code reviewers focus on logic.

```javascript
// Enforced rules:
// 1. PR title must match: release(<scope>): <description>
if (!/^release\([a-z0-9._/-]+\): .+/.test(title)) {
  core.setFailed('Title must match release(scope): description');
}
// 2. PR body must not be empty
if (body.trim().length === 0) {
  core.setFailed('PR body must not be empty');
}
```

---

## SECTION 9 — Observability (Prometheus + Grafana + Jaeger)

> **Concept:** You can't manage what you can't measure. The three pillars of observability: Metrics, Logs, Traces.

### Start the observability stack:
```bash
pnpm obs:up
# docker compose up -d jaeger prometheus grafana
```

### Open in browser:
| Tool | URL | Purpose |
|------|-----|---------|
| **Grafana** | http://localhost:3000 | Dashboards (admin/admin) |
| **Prometheus** | http://localhost:9090 | Raw metrics + alerts |
| **Jaeger** | http://localhost:16686 | Distributed traces |
| **RabbitMQ** | http://localhost:15672 | Queue management |
| **MailHog** | http://localhost:8025 | Captured dev emails |

### Prometheus scrape config (show this):
```yaml
# Every service exposes /metrics — Prometheus scrapes every 15s:
scrape_configs:
  - job_name: talent-services
    static_configs:
      - targets: ['auth-service:5001']
        labels: { service: auth-service, env: development }
      - targets: ['ai-matching-service:5006']
        labels: { service: ai-matching-service, env: development }
      # Datastore exporters too:
      - targets: ['postgres-exporter:9187']   # postgres_up, query durations
      - targets: ['redis-exporter:9121']       # redis_up, memory, commands
      - targets: ['rabbitmq:15692']            # queue depths, message rates
```

### Grafana dashboards (6 pre-built):
1. **Platform Overview** — global health, request rates
2. **Service Health** — per-service RED metrics (Rate, Errors, Duration)
3. **Conversion Funnels** — business KPIs
4. **AI/TalentLens** — vector search performance
5. **Events/RabbitMQ** — message queue depths, consumer lag
6. **Rewards/Analytics** — gamification metrics

### Distributed tracing with OpenTelemetry:
```yaml
# Every service sends traces to Jaeger:
OTEL_ENABLED: true
OTEL_EXPORTER_OTLP_ENDPOINT: http://jaeger:4318
```
> A single request to `POST /api/matches` becomes a trace spanning: API Gateway → AI Matching → Qdrant → PostgreSQL. You can see exactly where latency lives.

---

## SECTION 10 — Debugging & Operational Commands

> **Concept:** When things go wrong in production, you need to know the right commands fast. This is your operational runbook.

### Docker debugging:
```bash
# Check all container statuses
docker compose ps

# Follow logs for a specific service
docker compose logs -f auth-service
docker compose logs -f api-gateway --tail=100

# Tail logs across the whole stack
pnpm stack:logs

# Check resource usage (CPU/memory per container)
docker stats

# Exec into a running container for live debugging
docker exec -it talent-ai-postgres psql -U talent -d talent_auth
docker exec -it talent-ai-redis redis-cli ping
docker exec -it talent-ai-mongodb mongosh --quiet
```

### Kubernetes debugging:
```bash
# Check pod health
kubectl get pods -n talent-ai
kubectl get pods -n talent-ai-data

# See why a pod is crashing (CrashLoopBackOff diagnosis)
kubectl describe pod <pod-name> -n talent-ai
kubectl logs <pod-name> -n talent-ai --previous   # logs from crashed container

# Live log streaming
kubectl logs -f deployment/api-gateway -n talent-ai

# Port-forward a service locally (without changing k8s config)
kubectl port-forward svc/api-gateway 8080:8080 -n talent-ai

# Check HPA scaling decisions
kubectl describe hpa -n talent-ai

# Check events (recent cluster events = first stop when debugging)
kubectl get events -n talent-ai --sort-by=.lastTimestamp
```

### Database debugging:
```bash
# Check pending migrations
pnpm db:auth:migrate --preview

# Connect to PostgreSQL directly
psql postgresql://talent:talent@localhost:5432/talent_auth

# Verify MongoDB replica set status
docker exec -it talent-ai-mongodb mongosh --eval "rs.status()"

# Check Redis keys / memory
docker exec -it talent-ai-redis redis-cli info memory
docker exec -it talent-ai-redis redis-cli DBSIZE
```

### Health check all services at once:
```bash
# Quick health check loop
for port in 5001 5002 5003 5004 5005 5006 5007 5008 8080; do
  status=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health/liveness)
  echo "Port $port: HTTP $status"
done
```

### Prometheus queries for debugging:
```promql
# Is a service up?
up{service="auth-service"}

# Request error rate (last 5m)
rate(http_requests_total{status=~"5.."}[5m])

# P95 response time
histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))

# RabbitMQ queue depth
rabbitmq_queue_messages{queue="talent.events.dlq"}
```

---

## 🎯 Presentation Tips

1. **Start with the architecture diagram** — draw the boxes first (API Gateway → Services → Databases)
2. **Execute commands in order** — the audience sees the system come alive
3. **Show the terminal + browser side by side** — when you run `pnpm infra:up`, immediately open Grafana
4. **Link each command to a concept** — "This is Infrastructure-as-Code", "This is the 12-Factor App config principle"
5. **Use the GitHub Actions UI** — show a live/recent workflow run on github.com to demonstrate the CI pipeline visually
6. **End with Grafana** — a live dashboard with metrics flowing in is the most impressive visual

---

## 🚀 Quick "Full Stack From Zero" Script

> Execute this sequentially — it's your live demo:

```bash
# 1. Prepare environment
cp .env.example .env
# (edit .env — add JWT secrets)

# 2. Start infrastructure
pnpm infra:up

# 3. Wait for healthy, then run migrations
sleep 30
pnpm db:deploy:all

# 4. Seed demo data
pnpm db:seed:realistic

# 5. Build & start all application services
pnpm stack:up

# 6. Verify everything is healthy
docker compose ps

# 7. Hit the API
curl http://localhost:8080/health/liveness

# 8. Open observability
open http://localhost:3000  # Grafana
open http://localhost:9090  # Prometheus
open http://localhost:16686 # Jaeger

# 🎉 Platform is fully running!
```
