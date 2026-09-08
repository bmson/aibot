#!/usr/bin/env bash
set -euo pipefail

# Exercise the actual shipping image: Next's standalone output omits public/.
# Running next start, or copying public/ only in CI, cannot catch that omission.
image_ref=${1:?Usage: smoke-web-image.sh IMAGE}
repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
scratch_dir=$(mktemp -d)
container_id=''
cleanup() {
  if [ -n "$container_id" ]; then docker rm --force "$container_id" >/dev/null 2>&1 || true; fi
  rm -rf "$scratch_dir"
}
trap cleanup EXIT

container_id=$(docker run --rm --detach --publish 127.0.0.1::8080 "$image_ref")
address=$(docker port "$container_id" 8080/tcp)
base_url="http://${address}"
ready=false
for _ in {1..60}; do
  if curl --fail --silent --max-time 2 --output /dev/null "$base_url/api/health"; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  docker logs "$container_id"
  echo 'Web image did not become healthy.' >&2
  exit 1
fi

for entry in \
  '/icon.svg|apps/web/app/icon.svg' \
  '/apple-icon.png|apps/web/app/apple-icon.png' \
  '/icons/assistant-192.png|apps/web/public/icons/assistant-192.png' \
  '/icons/assistant-512.png|apps/web/public/icons/assistant-512.png' \
  '/icons/assistant-mark.svg|apps/web/public/icons/assistant-mark.svg'; do
  IFS='|' read -r route source_path <<< "$entry"
  curl --fail --silent --show-error --max-time 10 "$base_url$route" --output "$scratch_dir/asset"
  cmp "$scratch_dir/asset" "$repo_root/$source_path"
  echo "$route: served correctly by the release image"
done
