#!/usr/bin/env bash
# Backups of the Estudo database (spec 003, FR-047 and SC-014), on the server: /opt/estudo/restore.sh, installed by deploy.sh.
# Step by step: specs/003-backend-proprio/backups.md.
#
#   restore.sh [ontem | agora | "<data e hora>"]
#       Restores the copy of that moment from R2 (Litestream) to a NEW file in the data volume, /data/restauradas/, checked
#       with integrity_check; the database in use is never touched. ontem (the default) is as it was 24 hours ago; agora is
#       the latest copy; or any moment `date -d` reads: "2026-11-21 18:00" (server time) or 2026-11-21T21:00:00Z.
#   restore.sh usar /data/restauradas/<arquivo>.db
#       Puts a restored file in use: stops the api and Litestream, copies the current database to /data/copias/, puts the file
#       in its place, clears Litestream's local state (it starts over with a new snapshot in R2) and starts both again.
set -euo pipefail

cd "${ESTUDO_DIR:-/opt/estudo}"
project=$(basename "$PWD")
# compose reads the whole compose.yml: the api's image is the one running (or the last one that ran)
API_IMAGE=$(docker ps -a --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=api --format '{{.Image}}' | head -n 1)
export API_IMAGE=${API_IMAGE:-not-used}
export COMPOSE_PROFILES=backup

in_volume() { docker compose run --rm --no-deps -T --entrypoint sh litestream -s -- "$@"; }

if [ "${1:-}" = usar ]; then
  file=${2:?"diga qual arquivo restaurado usar, ex.: restore.sh usar /data/restauradas/estudo-em-2026-11-21_180000Z.db"}
  case "$file" in /data/restauradas/*.db) ;; *) echo "use um arquivo de /data/restauradas/" >&2; exit 2 ;; esac
  # shellcheck disable=SC2016 # $1 expands inside the container
  in_volume "$file" <<<'test -f "$1" || { echo "não achei $1" >&2; exit 1; }'
  echo "parando a api e o Litestream..."
  docker compose stop api litestream
  # project rule: a copy of the database in use before touching it (raw files: it may be the broken one)
  in_volume "$file" <<'SWAP'
set -eu
stamp=$(date -u +%Y-%m-%d_%H%M%SZ)
mkdir -p /data/copias
if [ -f /data/estudo.db ]; then
  cp /data/estudo.db "/data/copias/estudo-antes-de-restaurar-$stamp.db"
  if [ -f /data/estudo.db-wal ]; then cp /data/estudo.db-wal "/data/copias/estudo-antes-de-restaurar-$stamp.db-wal"; fi
  echo "o banco que estava em uso ficou em /data/copias/estudo-antes-de-restaurar-$stamp.db"
fi
rm -f /data/estudo.db-wal /data/estudo.db-shm
cp "$1" /data/estudo.db.new
mv /data/estudo.db.new /data/estudo.db
SWAP
  docker compose run --rm --no-deps -T litestream reset /data/estudo.db
  docker compose start api litestream
  echo "pronto: $file está em uso; o Litestream manda uma cópia nova inteira para o R2"
  exit 0
fi

when=${1:-ontem}
case "$when" in
  agora) at= ;;
  ontem) at=$(date -u -d '24 hours ago' +%Y-%m-%dT%H:%M:%SZ) ;;
  *) at=$(date -u -d "$when" +%Y-%m-%dT%H:%M:%SZ) || { echo "não entendi o momento: $when" >&2; exit 2; } ;;
esac
if [ -n "$at" ]; then
  out=/data/restauradas/estudo-em-$(date -u -d "$at" +%Y-%m-%d_%H%M%SZ).db
  echo "restaurando o banco como estava em $(date -d "$at" '+%d/%m/%Y %H:%M:%S %Z')..."
else
  out=/data/restauradas/estudo-agora-$(date -u +%Y-%m-%d_%H%M%SZ).db
  echo "restaurando a cópia mais recente..."
fi
in_volume <<<'mkdir -p /data/restauradas'
docker compose run --rm --no-deps -T litestream restore -integrity-check full ${at:+-timestamp "$at"} -o "$out" /data/estudo.db
in_volume "$out" <<'COUNT'
sqlite3 "file:$1?immutable=1" "SELECT 'contas: ' || count(*) FROM user; SELECT 'notas e pastas: ' || count(*) FROM library_items WHERE removed_at IS NULL;"
COUNT
echo "restaurado em $out (o banco em uso não mudou). Para usar: $0 usar $out"
