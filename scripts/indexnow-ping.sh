#!/usr/bin/env bash
# Notify IndexNow that the Uni-CLI docs sitemap has been updated.
# IndexNow is an open protocol supported by Bing, Yandex, and Seznam.
#
# Usage:
#   scripts/indexnow-ping.sh                      # ping the sitemap root
#   scripts/indexnow-ping.sh <url> [<url>...]     # ping specific URLs
#
# Run after a docs deploy. Safe to run multiple times.

set -euo pipefail

KEY="c11eab99d46c5d109e11595745c46c47"
HOST="olo-dot-io.github.io"
KEY_LOCATION="https://${HOST}/Uni-CLI/${KEY}.txt"

if [ "$#" -eq 0 ]; then
  URLS=("https://${HOST}/Uni-CLI/sitemap.xml")
else
  URLS=("$@")
fi

JSON_URL_LIST=$(printf '"%s",' "${URLS[@]}")
JSON_URL_LIST="[${JSON_URL_LIST%,}]"

PAYLOAD=$(cat <<JSON
{
  "host": "${HOST}",
  "key": "${KEY}",
  "keyLocation": "${KEY_LOCATION}",
  "urlList": ${JSON_URL_LIST}
}
JSON
)

echo "Pinging IndexNow with ${#URLS[@]} URL(s)..."
HTTP_CODE=$(curl -s -o /tmp/indexnow-response -w "%{http_code}" \
  -X POST "https://api.indexnow.org/indexnow" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data "${PAYLOAD}")

case "${HTTP_CODE}" in
  200|202)
    echo "IndexNow accepted (HTTP ${HTTP_CODE})."
    ;;
  *)
    echo "IndexNow rejected (HTTP ${HTTP_CODE})."
    cat /tmp/indexnow-response
    exit 1
    ;;
esac
