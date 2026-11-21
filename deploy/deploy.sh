#!/usr/bin/env bash
# Runs on the server as the "deploy" user, the only command its SSH key may run (authorized_keys: command="/opt/estudo/deploy.sh").
# stdin: a tar.gz from the pipeline with compose.yml, nginx/*.conf, deploy.sh, deploy.env (IMAGE, TAG, GHCR_USER, GHCR_TOKEN, DOMAIN)
# and app.env (the service's settings and secrets). It pulls the new image, brings it up and checks it answers with the new version;
# if not, it goes back to the version that was running.
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
install -m 600 "$NEXT/app.env" "$BASE/.env"
cd "$BASE"

previous=$(cat "$BASE/current.tag" 2>/dev/null || true)
echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
export API_IMAGE="$IMAGE:$TAG"
docker compose pull --quiet api

# the first time there is no certificate: nginx answers only on port 80 while certbot gets one
cp nginx/http.conf nginx/conf.d/http.conf
if ! docker compose run --rm --entrypoint sh certbot -c "test -f /etc/letsencrypt/live/$DOMAIN/fullchain.pem" >/dev/null 2>&1; then
  rm -f nginx/conf.d/https.conf
  docker compose up -d nginx
  docker compose run --rm --entrypoint certbot certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --agree-tos --register-unsafely-without-email --non-interactive
fi
cp nginx/https.conf nginx/conf.d/https.conf

docker compose up -d --remove-orphans
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
