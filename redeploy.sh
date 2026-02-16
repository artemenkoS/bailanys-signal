#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "${ROOT_DIR}/docker-compose.registry.yml" ]]; then
  echo "docker-compose.registry.yml not found in ${ROOT_DIR}" >&2
  exit 1
fi

if [[ ! -f "${ROOT_DIR}/.env.registry" ]]; then
  echo ".env.registry not found in ${ROOT_DIR}" >&2
  echo "Create it first (e.g. copy from .env and add BUN_IMAGE/CLIENT_IMAGE)." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Docker Compose not found (docker compose / docker-compose)." >&2
  exit 1
fi

for name in bailanys-client webrtc-bun web-nginx; do
  if docker ps -a --format '{{.Names}}' | grep -qx "${name}"; then
    docker rm -f "${name}" >/dev/null
  fi
done

"${COMPOSE[@]}" -f "${ROOT_DIR}/docker-compose.registry.yml" --env-file "${ROOT_DIR}/.env.registry" down --remove-orphans
"${COMPOSE[@]}" -f "${ROOT_DIR}/docker-compose.registry.yml" --env-file "${ROOT_DIR}/.env.registry" pull
"${COMPOSE[@]}" -f "${ROOT_DIR}/docker-compose.registry.yml" --env-file "${ROOT_DIR}/.env.registry" up -d --remove-orphans
"${COMPOSE[@]}" -f "${ROOT_DIR}/docker-compose.registry.yml" --env-file "${ROOT_DIR}/.env.registry" ps
