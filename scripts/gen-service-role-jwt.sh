#!/usr/bin/env bash
# Generate a service_role JWT that PostgREST will accept.
#
# Reads SUPABASE_JWT_SECRET and POSTGRES_USER from ./.env (or the environment)
# and prints a long-lived JWT to stdout. Copy the output into your .env under
# SUPABASE_SERVICE_ROLE_KEY.
#
# Requires: openssl, python3 (both are on every Ubuntu/Debian by default).

set -euo pipefail

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
fi

: "${SUPABASE_JWT_SECRET:?Set SUPABASE_JWT_SECRET in .env first}"
ROLE="${1:-${POSTGRES_USER:-tnved}}"

python3 - "$SUPABASE_JWT_SECRET" "$ROLE" <<'PY'
import base64, hmac, hashlib, json, sys, time

secret, role = sys.argv[1], sys.argv[2]

def b64(x): return base64.urlsafe_b64encode(x).rstrip(b"=").decode()

header  = b64(json.dumps({"alg":"HS256","typ":"JWT"},separators=(",",":")).encode())
# 10-year expiry — this is a service credential you rotate manually.
payload = b64(json.dumps({
    "role": role,
    "iss":  "self-hosted",
    "iat":  int(time.time()),
    "exp":  int(time.time()) + 10 * 365 * 24 * 3600,
},separators=(",",":")).encode())
msg = f"{header}.{payload}".encode()
sig = b64(hmac.new(secret.encode(), msg, hashlib.sha256).digest())
print(f"{header}.{payload}.{sig}")
PY
