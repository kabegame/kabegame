#!/usr/bin/env bash
# Certificate generation helper for local development
# Usage:
#   ./gen.sh ca               — generate CA
#   ./gen.sh server <domain>  — sign server cert (e.g. app.local)
#   ./gen.sh client <name>    — sign client cert (e.g. cmtheit)
#   ./gen.sh all              — generate CA + default server + default client
# 输出文件命名规则：
# local-ca.key / local-ca.crt — CA
# local-server-<domain>.key / .crt — 服务端
# local-client-<name>.key / .crt / .pem / .p12 — 客户端


set -e

CA_KEY="local-ca.key"
CA_CRT="local-ca.crt"
CA_SUBJECT="/C=JP/ST=Osaka/O=Kabegame Team/CN=Kabegame Local CA"
DAYS=3650

cmd="${1:-}"
arg="${2:-}"

require_ca() {
  if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CRT" ]; then
    echo "CA not found. Run: ./gen.sh ca" >&2
    exit 1
  fi
}

gen_ca() {
  echo "Generating CA..."
  openssl genrsa -out "$CA_KEY" 4096
  openssl req -new -x509 -days $DAYS \
    -key "$CA_KEY" -out "$CA_CRT" \
    -subj "$CA_SUBJECT"
  echo "Done: $CA_KEY  $CA_CRT"
}

gen_server() {
  local domain="${arg:-app.local}"
  local base="local-server-${domain}"
  require_ca
  echo "Generating server cert for: $domain"
  openssl genrsa -out "${base}.key" 4096
  openssl req -new \
    -key "${base}.key" -out "${base}.csr" \
    -subj "/C=JP/ST=Osaka/O=Kabegame Team/CN=${domain}" \
    -addext "subjectAltName=DNS:${domain},IP:127.0.0.1"
  openssl x509 -req -days $DAYS \
    -in "${base}.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "${base}.crt" \
    -copy_extensions copyall
  rm "${base}.csr"
  echo "Done: ${base}.key  ${base}.crt"
  echo "  -> SAN: DNS:${domain}, IP:127.0.0.1"
}

gen_client() {
  local name="${arg:-client}"
  local base="local-client-${name}"
  require_ca
  echo "Generating client cert for: $name"
  openssl genrsa -out "${base}.key" 4096
  openssl req -new \
    -key "${base}.key" -out "${base}.csr" \
    -subj "/C=JP/ST=Osaka/O=Kabegame Team/CN=${name}"
  openssl x509 -req -days $DAYS \
    -in "${base}.csr" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "${base}.crt"
  # PEM bundle (for curl)
  cat "${base}.crt" "${base}.key" > "${base}.pem"
  # P12 (for Windows/browser import, no password)
  openssl pkcs12 -export \
    -out "${base}.p12" \
    -in "${base}.crt" -inkey "${base}.key" \
    -name "Kabegame ${name}" \
    -passout pass:
  rm "${base}.csr"
  echo "Done: ${base}.key  ${base}.crt  ${base}.pem  ${base}.p12"
}

case "$cmd" in
  ca)     gen_ca ;;
  server) gen_server ;;
  client) gen_client ;;
  all)
    gen_ca
    arg="app.local" gen_server
    arg="cmtheit"   gen_client
    ;;
  *)
    echo "Usage: ./gen.sh <ca|server|client|all> [domain|name]"
    echo "  ca               Generate root CA"
    echo "  server <domain>  Sign server cert with SAN (default: app.local)"
    echo "  client <name>    Sign client cert + export .pem and .p12 (default: client)"
    echo "  all              Generate CA + app.local server + cmtheit client"
    ;;
esac
