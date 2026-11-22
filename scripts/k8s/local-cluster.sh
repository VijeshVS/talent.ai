#!/usr/bin/env bash
# talent.ai — one-command local Kubernetes environment.
#
#   pnpm k8s:local:up                 # build, load, deploy, migrate, port-forward
#   pnpm k8s:local:up --with-portals  # also start the Vite portals on the host
#   pnpm k8s:local:up --no-build      # reuse images already loaded into kind
#   pnpm k8s:local:status
#   pnpm k8s:local:logs [service]
#   pnpm k8s:local:down               # stop everything and delete the kind cluster
#   pnpm k8s:local:down --keep-cluster
#
# Requirements: Docker Desktop (running), kind, kubectl, pnpm.
#
# The local profile uses emptyDir for every datastore, so data is intentionally
# ephemeral. The two portals are not part of the Helm chart; --with-portals runs
# them on the host against the port-forwarded gateway.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CLUSTER_NAME="${CLUSTER_NAME:-talent-ai-local}"
KIND_CONFIG="infrastructure/k8s/kind/kind-local.yaml"
LOCAL_OVERLAY="infrastructure/k8s/overlays/local"
DATA_OVERLAY="$LOCAL_OVERLAY/datastores"
STATE_DIR="$ROOT/.k8s-local"
APP_NAMESPACE="talent-ai"
DATA_NAMESPACE="talent-ai-data"

SERVICES=(
  api-gateway
  auth-service
  talent-service
  recruiter-service
  engagement-service
  rewards-service
  ai-matching-service
  notification-service
  analytics-service
)

IMAGES=()
for service in "${SERVICES[@]}"; do
  IMAGES+=("talent-ai/${service}:local")
done

MIGRATION_PIDS=()

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31merror:\033[0m %s\n' "$*" >&2
  exit 1
}

cleanup_migrations() {
  local pid
  if (( ${#MIGRATION_PIDS[@]} > 0 )); then
    for pid in "${MIGRATION_PIDS[@]}"; do
      kill "$pid" 2>/dev/null || true
    done
  fi
}
trap cleanup_migrations EXIT

require_tools() {
  local missing=()
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
  done
  if (( ${#missing[@]} > 0 )); then
    die "missing required tools: ${missing[*]} (install with: brew install ${missing[*]})"
  fi
}

env_value() {
  local key="$1"
  [[ -f .env ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' .env |
    sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//"
}

port_open() {
  nc -z 127.0.0.1 "$1" >/dev/null 2>&1
}

require_free_port() {
  local port="$1" label="$2"
  if port_open "$port"; then
    die "port $port ($label) is already in use. Stop the Compose stack first (pnpm stack:down)."
  fi
}

wait_for_port() {
  local host="$1" port="$2" timeout="${3:-60}"
  local start
  start="$(date +%s)"
  while ! nc -z "$host" "$port" >/dev/null 2>&1; do
    if (($(date +%s) - start > timeout)); then
      die "timed out waiting for $host:$port"
    fi
    sleep 1
  done
}

kill_tree() {
  local pid="$1" child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

stop_pidfile() {
  local name="$1" tree="${2:-no}"
  local file="$STATE_DIR/$name.pids"
  [[ -f "$file" ]] || return 0
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    if [[ "$tree" == "yes" ]]; then
      kill_tree "$pid"
    else
      kill "$pid" 2>/dev/null || true
    fi
  done <"$file"
  rm -f "$file"
}

start_pidfile_entry() {
  local name="$1" pid="$2"
  printf '%s\n' "$pid" >>"$STATE_DIR/$name.pids"
}

ensure_cluster() {
  if kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    log "kind cluster '$CLUSTER_NAME' already exists"
  else
    log "creating kind cluster '$CLUSTER_NAME'"
    kind create cluster --name "$CLUSTER_NAME" --config "$KIND_CONFIG"
  fi
  kubectl config use-context "kind-$CLUSTER_NAME" >/dev/null
}

build_images() {
  log "building service images with docker compose"
  docker compose build
}

load_images() {
  log "loading images into kind"
  kind load docker-image --name "$CLUSTER_NAME" "${IMAGES[@]}"
}

ensure_secret() {
  local access refresh openai
  access="$(env_value JWT_ACCESS_SECRET)"
  refresh="$(env_value JWT_REFRESH_SECRET)"
  openai="$(env_value OPENAI_API_KEY)"
  access="${access:-dev-access-secret-change-me-please-32chars-min}"
  refresh="${refresh:-dev-refresh-secret-change-me-please-32chars-min}"

  local pg="postgresql://talent:talent@postgres.${DATA_NAMESPACE}.svc.cluster.local:5432"
  local mongo="mongodb://mongodb.${DATA_NAMESPACE}.svc.cluster.local:27017"

  local args=(
    --from-literal=DATABASE_URL="${pg}/talent_auth"
    --from-literal=RECRUITER_DATABASE_URL="${pg}/talent_recruiter"
    --from-literal=ENGAGEMENT_DATABASE_URL="${pg}/talent_engagement"
    --from-literal=REWARDS_DATABASE_URL="${pg}/talent_rewards"
    --from-literal=ANALYTICS_DATABASE_URL="${pg}/talent_analytics?schema=public"
    --from-literal=MONGODB_URI="${mongo}/talent_profiles?replicaSet=rs0"
    --from-literal=NOTIFICATION_MONGODB_URI="${mongo}/talent_notif?replicaSet=rs0"
    --from-literal=REDIS_URL="redis://redis.${DATA_NAMESPACE}.svc.cluster.local:6379"
    --from-literal=RABBITMQ_URL="amqp://talent:talent@rabbitmq.${DATA_NAMESPACE}.svc.cluster.local:5672"
    --from-literal=JWT_ACCESS_SECRET="$access"
    --from-literal=JWT_REFRESH_SECRET="$refresh"
  )
  if [[ -n "$openai" ]]; then
    args+=(--from-literal=OPENAI_API_KEY="$openai")
  fi

  log "creating/updating Secret/talent-ai-secrets"
  kubectl -n "$APP_NAMESPACE" create secret generic talent-ai-secrets \
    "${args[@]}" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}

wait_for_datastores() {
  local name
  for name in postgres mongodb redis rabbitmq qdrant; do
    log "waiting for $name"
    kubectl -n "$DATA_NAMESPACE" rollout status "deploy/$name" --timeout=240s
  done
  log "waiting for the MongoDB replica set"
  kubectl -n "$DATA_NAMESPACE" wait --for=condition=complete job/mongodb-init --timeout=240s
}

run_migrations() {
  require_free_port 5432 "postgres (migrations)"
  require_free_port 27017 "mongodb (migrations)"

  log "port-forwarding Postgres and MongoDB for migrations"
  kubectl -n "$DATA_NAMESPACE" port-forward svc/postgres 5432:5432 >"$STATE_DIR/migrate-postgres.log" 2>&1 &
  local pg_pid=$!
  MIGRATION_PIDS+=("$pg_pid")
  kubectl -n "$DATA_NAMESPACE" port-forward svc/mongodb 27017:27017 >"$STATE_DIR/migrate-mongodb.log" 2>&1 &
  local mongo_pid=$!
  MIGRATION_PIDS+=("$mongo_pid")

  wait_for_port 127.0.0.1 5432 60
  wait_for_port 127.0.0.1 27017 60

  local pg="postgresql://talent:talent@127.0.0.1:5432"
  local mongo="mongodb://127.0.0.1:27017"

  log "running Prisma migrations"
  DATABASE_URL="${pg}/talent_auth" \
    RECRUITER_DATABASE_URL="${pg}/talent_recruiter" \
    ENGAGEMENT_DATABASE_URL="${pg}/talent_engagement" \
    REWARDS_DATABASE_URL="${pg}/talent_rewards" \
    ANALYTICS_DATABASE_URL="${pg}/talent_analytics?schema=public" \
    MONGODB_URI="${mongo}/talent_profiles?replicaSet=rs0" \
    NOTIFICATION_MONGODB_URI="${mongo}/talent_notif?replicaSet=rs0" \
    pnpm db:auth:generate

  DATABASE_URL="${pg}/talent_auth" \
    RECRUITER_DATABASE_URL="${pg}/talent_recruiter" \
    ENGAGEMENT_DATABASE_URL="${pg}/talent_engagement" \
    REWARDS_DATABASE_URL="${pg}/talent_rewards" \
    ANALYTICS_DATABASE_URL="${pg}/talent_analytics?schema=public" \
    pnpm db:deploy:all

  log "seeding the auth database"
  DATABASE_URL="${pg}/talent_auth" pnpm db:auth:seed

  kill "$pg_pid" "$mongo_pid" 2>/dev/null || true
  MIGRATION_PIDS=()
}

apply_app() {
  log "applying the local application overlay"
  # `kubectl apply` does not remove resources that disappeared from a Kustomize
  # render. Clean up HPAs from the previous nine-HPA local profile explicitly.
  kubectl -n "$APP_NAMESPACE" delete hpa \
    talent-service recruiter-service engagement-service rewards-service \
    ai-matching-service notification-service analytics-service \
    --ignore-not-found >/dev/null
  kubectl apply -k "$LOCAL_OVERLAY"
}

wait_for_app() {
  local service
  for service in "${SERVICES[@]}"; do
    log "waiting for $service"
    if ! kubectl -n "$APP_NAMESPACE" rollout status "deploy/$service" --timeout=300s; then
      kubectl -n "$APP_NAMESPACE" get pods -o wide || true
      kubectl -n "$APP_NAMESPACE" describe "deploy/$service" | tail -40 || true
      die "$service did not become ready"
    fi
  done
}

start_port_forwards() {
  stop_pidfile port-forwards
  : >"$STATE_DIR/port-forwards.pids"
  sleep 1

  require_free_port 8080 "api-gateway"
  require_free_port 5007 "notification-service"

  log "port-forwarding api-gateway:8080 and notification-service:5007"
  kubectl -n "$APP_NAMESPACE" port-forward svc/api-gateway 8080:8080 >"$STATE_DIR/port-forward-api-gateway.log" 2>&1 &
  start_pidfile_entry port-forwards $!
  kubectl -n "$APP_NAMESPACE" port-forward svc/notification-service 5007:5007 >"$STATE_DIR/port-forward-notification.log" 2>&1 &
  start_pidfile_entry port-forwards $!

  wait_for_port 127.0.0.1 8080 30
  wait_for_port 127.0.0.1 5007 30
}

start_portals() {
  stop_pidfile portals yes
  : >"$STATE_DIR/portals.pids"
  sleep 1

  require_free_port 3000 "candidate portal"
  require_free_port 3001 "recruiter portal"

  log "starting the Vite portals on the host"
  nohup env \
    VITE_API_GATEWAY_URL="http://localhost:8080" \
    VITE_NOTIFICATION_WS_URL="ws://localhost:5007/ws/notifications" \
    pnpm dev:apps >"$STATE_DIR/portals.log" 2>&1 &
  start_pidfile_entry portals $!

  wait_for_port 127.0.0.1 3000 90
  wait_for_port 127.0.0.1 3001 90
}

print_summary() {
  local with_portals="$1"
  cat <<EOF

Local Kubernetes environment is ready.

  API gateway    http://localhost:8080
  Notification   ws://localhost:5007/ws/notifications
EOF
  if [[ "$with_portals" == "yes" ]]; then
    cat <<EOF
  Candidate      http://localhost:3000
  Recruiter      http://localhost:3001
EOF
  else
    cat <<EOF

Portals are host-only (not part of the Helm chart). Start them with:

  VITE_API_GATEWAY_URL=http://localhost:8080 \\
  VITE_NOTIFICATION_WS_URL=ws://localhost:5007/ws/notifications \\
  pnpm dev:apps
EOF
  fi
  cat <<EOF

Useful commands:
  pnpm k8s:local:status
  pnpm k8s:local:logs api-gateway
  pnpm k8s:local:down
EOF
}

cmd_up() {
  local with_portals="no" no_build="no"
  while (($# > 0)); do
    case "$1" in
      --with-portals) with_portals="yes" ;;
      --no-build) no_build="yes" ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  require_tools docker kind kubectl pnpm nc
  docker info >/dev/null 2>&1 || die "Docker is not running. Start Docker Desktop and retry."
  if [[ ! -f .env ]]; then
    log "creating .env from .env.example"
    cp .env.example .env
  fi
  if [[ ! -d node_modules ]]; then
    log "installing workspace dependencies"
    pnpm install
  fi

  mkdir -p "$STATE_DIR"
  ensure_cluster
  if [[ "$no_build" == "no" ]]; then build_images; fi
  load_images

  log "applying namespaces"
  kubectl apply -k infrastructure/k8s/base/namespaces >/dev/null

  ensure_secret

  log "resetting the MongoDB init job"
  kubectl -n "$DATA_NAMESPACE" delete job mongodb-init --ignore-not-found >/dev/null

  log "applying the datastore tier"
  kubectl apply -k "$DATA_OVERLAY"

  wait_for_datastores
  run_migrations
  apply_app
  wait_for_app
  start_port_forwards
  if [[ "$with_portals" == "yes" ]]; then start_portals; fi

  print_summary "$with_portals"
}

cmd_down() {
  local keep_cluster="no"
  while (($# > 0)); do
    case "$1" in
      --keep-cluster) keep_cluster="yes" ;;
      *) die "unknown option: $1" ;;
    esac
    shift
  done

  stop_pidfile portals yes
  stop_pidfile port-forwards

  if [[ "$keep_cluster" == "yes" ]]; then
    log "keeping kind cluster '$CLUSTER_NAME'"
  elif command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
    log "deleting kind cluster '$CLUSTER_NAME'"
    kind delete cluster --name "$CLUSTER_NAME"
  else
    log "kind cluster '$CLUSTER_NAME' is not running"
  fi
}

cmd_status() {
  echo "kind clusters:"
  if command -v kind >/dev/null 2>&1; then
    kind get clusters || true
  else
    echo "  kind is not installed"
  fi

  echo
  echo "application pods ($APP_NAMESPACE):"
  kubectl -n "$APP_NAMESPACE" get pods -o wide 2>/dev/null || echo "  cluster is not reachable"

  echo
  echo "datastore pods ($DATA_NAMESPACE):"
  kubectl -n "$DATA_NAMESPACE" get pods -o wide 2>/dev/null || true

  echo
  echo "local endpoints:"
  echo "  api-gateway        http://localhost:8080"
  echo "  notification (ws)  ws://localhost:5007/ws/notifications"
  echo "  candidate portal   http://localhost:3000"
  echo "  recruiter portal   http://localhost:3001"
}

cmd_logs() {
  local target="${1:-}"
  if [[ -n "$target" ]]; then
    kubectl -n "$APP_NAMESPACE" logs -f "deploy/$target"
  else
    kubectl -n "$APP_NAMESPACE" logs -f -l app.kubernetes.io/part-of=talent-ai --all-containers --max-log-requests 20
  fi
}

usage() {
  cat <<'EOF'
talent.ai local Kubernetes environment

Usage:
  pnpm k8s:local:up [--with-portals] [--no-build]
  pnpm k8s:local:status
  pnpm k8s:local:logs [service]
  pnpm k8s:local:down [--keep-cluster]

What `up` does:
  1. creates (or reuses) the single-node kind cluster
  2. builds the nine service images with docker compose
  3. loads the images into kind
  4. applies namespaces and the local Secret
  5. deploys Postgres, MongoDB, Redis, RabbitMQ and Qdrant in talent-ai-data
  6. runs Prisma migrations and the auth seed against port-forwarded datastores
  7. applies the local overlay (one replica per service, HPAs only for gateway/auth,
     no rollout surge)
  8. port-forwards api-gateway:8080 and notification-service:5007
  9. optionally starts the Vite portals on the host (--with-portals)

Requirements: Docker Desktop (running), kind, kubectl, pnpm.
EOF
}

command="${1:-up}"
if (($# > 0)); then shift; fi
case "$command" in
  up) cmd_up "$@" ;;
  down) cmd_down "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs "$@" ;;
  help | -h | --help) usage ;;
  *)
    usage
    exit 1
    ;;
esac
