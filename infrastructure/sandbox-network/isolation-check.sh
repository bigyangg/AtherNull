#!/usr/bin/env bash
# Proves the sandbox isolation gates on the real host (G0.1, G0.2 in
# docs/security/PRE_LAUNCH_SECURITY_GATES.md). Run as root on the VPS after
# `athernull-sandbox-net.sh apply`. Read-only apart from two throwaway probe
# containers, which are removed on exit.
#
#   isolation-check.sh [--public-ip <VPS public IP>] [--api <platform API ip:port>]
#
# Exit 0 only when every check passes. Output is the evidence for the gate.
set -uo pipefail

NET="${SANDBOX_NETWORK:-athernull-sandboxes}"
GATEWAY="${SANDBOX_GATEWAY:-172.30.0.1}"
LLM_PROXY_IP="${LLM_PROXY_IP:-}"
LLM_PROXY_PORT="${LLM_PROXY_PORT:-}"
PROBE_IMAGE="${PROBE_IMAGE:-alpine:3.20}"
# Same resolvers the provisioner gives sandboxes (SANDBOX_DNS, sandbox/policy.ts).
IFS=',' read -r -a DNS <<< "${SANDBOX_DNS:-1.1.1.1,9.9.9.9}"
DNS_ARGS=(); for d in "${DNS[@]}"; do DNS_ARGS+=(--dns "$d"); done
PUBLIC_IP=""
API=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --public-ip) PUBLIC_IP="$2"; shift 2 ;;
    --api) API="$2"; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done

failures=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; failures=$((failures + 1)); }

PEER="athernull-isolation-peer-$$"
PROBE="athernull-isolation-probe-$$"
cleanup() { docker rm -f "$PEER" "$PROBE" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker network inspect "$NET" >/dev/null 2>&1 || { echo "network $NET missing"; exit 1; }
docker run -d --rm --name "$PEER" --network "$NET" "${DNS_ARGS[@]}" "$PROBE_IMAGE" nc -lk -p 9000 >/dev/null
docker run -d --rm --name "$PROBE" --network "$NET" "${DNS_ARGS[@]}" "$PROBE_IMAGE" sleep 300 >/dev/null
PEER_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" "$PEER")"

# tcp HOST PORT -> 0 when a TCP connection opens from inside the probe sandbox
tcp() { docker exec "$PROBE" nc -z -w 3 "$1" "$2" >/dev/null 2>&1; }
must_block() { if tcp "$1" "$2"; then fail "sandbox reached $3 ($1:$2)"; else pass "blocked: $3 ($1:$2)"; fi; }
must_allow_https() {
  if docker exec "$PROBE" wget -q -T 8 --spider "$1" >/dev/null 2>&1; then pass "allowed: $1"; else fail "sandbox cannot reach $1"; fi
}

echo "== G0.1 network isolation (probe in $NET)"
for port in 22 80 443 3000 3001 5432 6379 8000; do must_block "$GATEWAY" "$port" "host via sandbox gateway"; done
must_block 172.17.0.1 22 "host via default docker bridge"
must_block 169.254.169.254 80 "cloud metadata"
must_block 10.0.0.1 22 "private range 10/8"
must_block 192.168.0.1 22 "private range 192.168/16"
must_block "$PEER_IP" 9000 "another sandbox"
if [[ -n "$PUBLIC_IP" ]]; then
  for port in 22 80 443 3000 5432 6001 8000; do must_block "$PUBLIC_IP" "$port" "host via its public IP"; done
else
  echo "SKIP  host public IP (pass --public-ip)"
fi
if [[ -n "$API" ]]; then must_block "${API%:*}" "${API##*:}" "platform API (non-proxy port)"; fi
if [[ -n "$LLM_PROXY_IP" && -n "$LLM_PROXY_PORT" ]]; then
  if tcp "$LLM_PROXY_IP" "$LLM_PROXY_PORT"; then pass "allowed: LLM proxy"; else fail "sandbox cannot reach the LLM proxy"; fi
else
  echo "SKIP  LLM proxy (LLM_PROXY_IP/LLM_PROXY_PORT not set)"
fi
must_allow_https https://registry.npmjs.org/
must_allow_https https://pypi.org/simple/
must_allow_https https://github.com/

echo "== G0.2 platform credentials inside customer sandboxes"
mapfile -t sandboxes < <(docker ps --format '{{.Names}}' | grep '^athernull-sandbox-' || true)
if [[ ${#sandboxes[@]} -eq 0 ]]; then
  echo "SKIP  no athernull-sandbox-* containers running"
fi
for c in "${sandboxes[@]}"; do
  # Provider key shapes only; values are never printed.
  hits="$(docker exec "$c" sh -c 'grep -rlsE "nvapi-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}" /workspace /root /home 2>/dev/null | head -5; env | grep -cE "nvapi-|sk-ant-|sk-proj-"' 2>/dev/null)"
  files="$(printf '%s\n' "$hits" | grep -v '^[0-9]*$' | grep -c . || true)"
  envs="$(printf '%s\n' "$hits" | grep -E '^[0-9]+$' | tail -1)"
  if [[ "${files:-0}" == "0" && "${envs:-0}" == "0" ]]; then
    pass "$c: no provider keys found"
  else
    fail "$c: provider key material found (files: ${files:-0}, env vars: ${envs:-0})"
  fi
done

echo "== G0.3 limits"
for c in "${sandboxes[@]}"; do
  read -r mem pids cpus < <(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.PidsLimit}} {{.HostConfig.NanoCpus}}' "$c")
  if [[ "$mem" != "0" && "${pids:-0}" != "0" && "${pids:-0}" != "<nil>" && "$cpus" != "0" ]]; then
    pass "$c: memory=$mem pids=$pids nanocpus=$cpus"
  else
    fail "$c: missing limits (memory=$mem pids=$pids nanocpus=$cpus) — re-provision it"
  fi
done

echo
if [[ $failures -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "$failures CHECK(S) FAILED"; fi
exit $((failures > 0))
