#!/usr/bin/env bash
# AtherNull customer-sandbox network + host firewall (Phase 0, G0.1).
# Target: Ubuntu 24.04 VPS running Docker Engine (Coolify host). Run as root.
#
#   athernull-sandbox-net.sh apply    create the network (if missing) and (re)apply the rules
#   athernull-sandbox-net.sh status   show the network and rules
#   athernull-sandbox-net.sh remove   remove the rules and the marker (the network is kept)
#
# Layout (docs/runbooks/sandbox-network.md):
#   network  athernull-sandboxes  172.30.0.0/16, bridge interface br-athernull
#   platform 172.30.0.0/24        fixed addresses for AtherNull's own containers (API, worker)
#   sandboxes 172.30.128.0/17     every org sandbox (Docker assigns from this range)
#
# A sandbox may: answer the platform; reach the public internet (package
# registries, git); reach the LLM proxy (LLM_PROXY_IP:LLM_PROXY_PORT) when set.
# A sandbox may not: reach the host itself (SSH, Coolify, databases), any
# private / link-local / metadata address, other Coolify projects, or another
# sandbox. Idempotent: safe to run again; the systemd unit runs it at boot.
set -euo pipefail

NET="${SANDBOX_NETWORK:-athernull-sandboxes}"
BRIDGE="${SANDBOX_BRIDGE:-br-athernull}"
SUBNET="${SANDBOX_SUBNET:-172.30.0.0/16}"
GATEWAY="${SANDBOX_GATEWAY:-172.30.0.1}"
PLATFORM_RANGE="${SANDBOX_PLATFORM_RANGE:-172.30.0.0/24}"
SANDBOX_RANGE="${SANDBOX_RANGE:-172.30.128.0/17}"
LLM_PROXY_IP="${LLM_PROXY_IP:-}"
LLM_PROXY_PORT="${LLM_PROXY_PORT:-}"
MARKER_DIR="/run/athernull"
MARKER="${MARKER_DIR}/${NET}.firewall"

FWD_CHAIN="ATHERNULL-SBX"
IN_CHAIN="ATHERNULL-SBX-HOST"
BLOCKED_RANGES=(10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4)

IPT=(iptables -w)

die() { echo "error: $*" >&2; exit 1; }

require_root() { [[ $EUID -eq 0 ]] || die "run as root"; }

ensure_br_netfilter() {
  # Traffic between containers on one bridge only reaches DOCKER-USER when
  # bridged packets go through iptables (Docker normally enables this).
  modprobe br_netfilter 2>/dev/null || true
  if [[ "$(sysctl -n net.bridge.bridge-nf-call-iptables 2>/dev/null || echo 0)" != "1" ]]; then
    sysctl -q -w net.bridge.bridge-nf-call-iptables=1
  fi
}

ensure_network() {
  if docker network inspect "$NET" >/dev/null 2>&1; then
    local subnet bridge
    subnet="$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}{{end}}' "$NET")"
    bridge="$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' "$NET")"
    [[ "$subnet" == "$SUBNET" ]] || die "$NET exists with subnet $subnet, expected $SUBNET"
    [[ "$bridge" == "$BRIDGE" ]] || die "$NET exists with bridge '$bridge', expected $BRIDGE"
  else
    docker network create \
      --driver bridge \
      --subnet "$SUBNET" --ip-range "$SANDBOX_RANGE" --gateway "$GATEWAY" \
      --opt "com.docker.network.bridge.name=$BRIDGE" \
      --label athernull.role=sandboxes \
      "$NET" >/dev/null
    echo "created network $NET ($SUBNET, sandboxes in $SANDBOX_RANGE)"
  fi
}

ensure_chain() { "${IPT[@]}" -N "$1" 2>/dev/null || true; "${IPT[@]}" -F "$1"; }

ensure_jump() { # table-less: chain, rule...
  local chain="$1"; shift
  "${IPT[@]}" -C "$chain" "$@" 2>/dev/null || "${IPT[@]}" -I "$chain" 1 "$@"
}

apply_rules() {
  "${IPT[@]}" -L DOCKER-USER -n >/dev/null 2>&1 || die "DOCKER-USER chain missing: is Docker Engine running with iptables enabled?"

  # Forwarded traffic from sandboxes.
  ensure_chain "$FWD_CHAIN"
  "${IPT[@]}" -A "$FWD_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  if [[ -n "$LLM_PROXY_IP" && -n "$LLM_PROXY_PORT" ]]; then
    "${IPT[@]}" -A "$FWD_CHAIN" -d "$LLM_PROXY_IP" -p tcp --dport "$LLM_PROXY_PORT" -j RETURN
  fi
  for range in "${BLOCKED_RANGES[@]}"; do
    "${IPT[@]}" -A "$FWD_CHAIN" -d "$range" -j DROP
  done
  "${IPT[@]}" -A "$FWD_CHAIN" -j RETURN   # public internet

  # New connections INTO a sandbox only from the platform range (the API and
  # worker on this network). Covers sandbox -> sandbox as well.
  ensure_jump DOCKER-USER -d "$SANDBOX_RANGE" ! -s "$PLATFORM_RANGE" -m conntrack --ctstate NEW -j DROP
  ensure_jump DOCKER-USER -s "$SANDBOX_RANGE" -j "$FWD_CHAIN"

  # Traffic from the sandbox bridge to the host itself (SSH, Coolify,
  # anything listening on the host) never goes through FORWARD.
  ensure_chain "$IN_CHAIN"
  "${IPT[@]}" -A "$IN_CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  "${IPT[@]}" -A "$IN_CHAIN" -s "$PLATFORM_RANGE" -j RETURN
  if [[ -n "$LLM_PROXY_IP" && -n "$LLM_PROXY_PORT" && "$LLM_PROXY_IP" == "$GATEWAY" ]]; then
    "${IPT[@]}" -A "$IN_CHAIN" -p tcp --dport "$LLM_PROXY_PORT" -j RETURN
  fi
  "${IPT[@]}" -A "$IN_CHAIN" -j DROP
  ensure_jump INPUT -i "$BRIDGE" -j "$IN_CHAIN"

  mkdir -p "$MARKER_DIR"
  printf 'network=%s subnet=%s sandboxes=%s platform=%s llm_proxy=%s:%s applied=%s\n' \
    "$NET" "$SUBNET" "$SANDBOX_RANGE" "$PLATFORM_RANGE" "${LLM_PROXY_IP:-none}" "${LLM_PROXY_PORT:-none}" "$(date -u +%FT%TZ)" > "$MARKER"
  chmod 644 "$MARKER"
  echo "rules applied; marker $MARKER"
}

remove_rules() {
  "${IPT[@]}" -D DOCKER-USER -s "$SANDBOX_RANGE" -j "$FWD_CHAIN" 2>/dev/null || true
  "${IPT[@]}" -D DOCKER-USER -d "$SANDBOX_RANGE" ! -s "$PLATFORM_RANGE" -m conntrack --ctstate NEW -j DROP 2>/dev/null || true
  "${IPT[@]}" -D INPUT -i "$BRIDGE" -j "$IN_CHAIN" 2>/dev/null || true
  for chain in "$FWD_CHAIN" "$IN_CHAIN"; do
    "${IPT[@]}" -F "$chain" 2>/dev/null || true
    "${IPT[@]}" -X "$chain" 2>/dev/null || true
  done
  rm -f "$MARKER"
  echo "rules removed (network $NET kept). Provisioning with SANDBOX_NETWORK_POLICY=enforced now refuses to start sandboxes."
}

status() {
  docker network inspect -f 'network {{.Name}} {{range .IPAM.Config}}{{.Subnet}} range {{.IPRange}}{{end}}' "$NET" 2>/dev/null || echo "network $NET: missing"
  echo "--- DOCKER-USER"; "${IPT[@]}" -S DOCKER-USER
  echo "--- $FWD_CHAIN"; "${IPT[@]}" -S "$FWD_CHAIN" 2>/dev/null || echo "(missing)"
  echo "--- $IN_CHAIN"; "${IPT[@]}" -S "$IN_CHAIN" 2>/dev/null || echo "(missing)"
  echo "--- marker"; cat "$MARKER" 2>/dev/null || echo "(missing)"
}

case "${1:-}" in
  apply) require_root; ensure_br_netfilter; ensure_network; apply_rules ;;
  remove) require_root; remove_rules ;;
  status) require_root; status ;;
  *) echo "usage: $0 apply|status|remove" >&2; exit 2 ;;
esac
