#!/usr/bin/env bash
# Runs on the server as the "deploy" user, the only command its SSH key may run (authorized_keys: command="/opt/estudo/deploy.sh").
# stdin: a tar.gz from the pipeline with compose.yml, litestream.yml, restore.sh, nginx/*.conf, deploy.sh, deploy.env (IMAGE, TAG,
# GHCR_USER, GHCR_TOKEN, DOMAIN) and app.env (the service's settings and secrets). It pulls the new image, makes a dated copy of the
# database, brings it up and checks it answers with the new version; if not, it goes back to the version that was running. At the
# end it checks the backup to R2 (Litestream) is working.
set -euo pipefail
umask 077

BASE=/opt/estudo
NEXT=$(mktemp -d)
trap 'rm -r -f -- "$NEXT"' EXIT

tar -xzf - -C "$NEXT"
# shellcheck disable=SC1091
source "$NEXT/deploy.env"
: "${IMAGE:?}" "${TAG:?}" "${GHCR_USER:?}" "${GHCR_TOKEN:?}" "${DOMAIN:?}"

mkdir -p "$BASE/nginx/conf.d"
install -m 644 "$NEXT/compose.yml" "$BASE/compose.yml"
install -m 644 "$NEXT/nginx/http.conf" "$BASE/nginx/http.conf"
install -m 644 "$NEXT/nginx/https.conf" "$BASE/nginx/https.conf"
litestream_changed=
cmp -s "$NEXT/litestream.yml" "$BASE/litestream.yml" || litestream_changed=1
install -m 644 "$NEXT/litestream.yml" "$BASE/litestream.yml"
install -m 755 "$NEXT/restore.sh" "$BASE/restore.sh"
install -m 600 "$NEXT/app.env" "$BASE/.env"
cd "$BASE"

previous=$(cat "$BASE/current.tag" 2>/dev/null || true)
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
export API_IMAGE="$IMAGE:$TAG"
# turns on the litestream service (compose.yml)
export COMPOSE_PROFILES=backup
docker compose pull --quiet api litestream

# Before anything changes, a dated copy of the database (project rule; FR-047: every change in the data structure is preceded by a
# copy): taken with the api running (VACUUM INTO, one consistent read), checked, in the data volume under copias/, kept 30 days.
# It also comes before Litestream's first start, which adds its own tables (_litestream_seq, _litestream_lock) to the database.
# A failed copy stops the deploy here, with the running version untouched.
if [ -n "$(docker volume ls -q --filter label=com.docker.compose.volume=estudo-data)" ]; then
  docker compose run --rm --no-deps -T --entrypoint sh litestream -s <<'COPY'
set -eu
db=/data/estudo.db
if [ ! -f "$db" ]; then echo "ainda não há banco: nada a copiar"; exit 0; fi
mkdir -p /data/copias
out=/data/copias/estudo-$(date -u +%Y-%m-%d_%H%M%SZ).db
sqlite3 -bail -cmd ".timeout 15000" "$db" "VACUUM INTO '$out'"
check=$(sqlite3 "$out" "PRAGMA integrity_check")
if [ "$check" != ok ]; then echo "a cópia $out não passou na conferência: $check" >&2; exit 1; fi
find /data/copias -name 'estudo-*.db' -mtime +30 -delete
echo "cópia do banco: $out ($(du -h "$out" | cut -f1))"
COPY
fi

# the first time there is no certificate: nginx answers only on port 80 while certbot gets one
cp nginx/http.conf nginx/conf.d/http.conf
if ! docker compose run --rm --entrypoint sh certbot -c "test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1; then
  rm -f nginx/conf.d/https.conf
  docker compose up -d nginx
  docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --agree-tos --register-unsafely-without-email --non-interactive
fi
cp nginx/https.conf nginx/conf.d/https.conf

docker compose up -d --remove-orphans
# compose does not see a change inside litestream.yml
if [ -n "$litestream_changed" ]; then docker compose restart litestream; fi
docker compose exec -T nginx nginx -s reload

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/v1/health" | grep -q "\"version\":\"$1\""; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if healthy "$TAG"; then
  echo "$TAG" > "$BASE/current.tag"
  echo "estudo $TAG no ar"
else
  echo "a versão $TAG não respondeu" >&2
  if [ -n "$previous" ]; then
    API_IMAGE="$IMAGE:$previous" docker compose up -d api
    echo "voltou para $previous" >&2
  fi
  docker logout ghcr.io >/dev/null || true
  exit 1
fi

docker logout ghcr.io >/dev/null || true
docker image prune -f >/dev/null
# the next deploy uses the script that came with this one
install -m 755 "$NEXT/deploy.sh" "$BASE/deploy.sh"

# the backup must be reaching R2: Litestream lists the database's snapshot in the bucket
backup_ok() {
  local out
  for _ in $(seq 1 20); do
    out=$(docker compose exec -T litestream litestream ltx -level 9 /data/estudo.db 2>&1 || true)
    if grep -q '^9 ' <<<"$out"; then return 0; fi
    sleep 3
  done
  echo "$out" >&2
  return 1
}
if ! backup_ok; then
  echo "a cópia do banco para o R2 (Litestream) não está funcionando; veja: docker compose logs litestream" >&2
  exit 1
fi
