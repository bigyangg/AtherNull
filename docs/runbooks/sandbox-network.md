# Runbook: customer-sandbox network on the Coolify VPS

Phase 0, gates G0.1 and G0.3 (`docs/security/PRE_LAUNCH_SECURITY_GATES.md`).
Target: Ubuntu 24.04 VPS running Docker Engine, with Coolify managing AtherNull's web and API. **Other projects run on this VPS too**, so customer sandboxes must never reach them.

## Layout

```
VPS (Ubuntu 24.04, Docker Engine, Coolify)
├── Coolify networks (coolify, other projects …)      ← sandboxes can't reach these
├── athernull-sandboxes   172.30.0.0/16, bridge br-athernull
│   ├── 172.30.0.0/24     platform: fixed addresses for AtherNull containers
│   │     172.30.0.10  API (gateway + LLM proxy port)
│   │     172.30.0.11  coding worker
│   └── 172.30.128.0/17   one container per org: athernull-sandbox-<org8>
└── host processes (systemd): sandbox provisioner, verifier  ← these need the Docker socket
```

What a sandbox can and can't reach (enforced by `infrastructure/sandbox-network/athernull-sandbox-net.sh`):

| From a sandbox to | Result |
|---|---|
| Public internet (npm, PyPI, GitHub, …) via public DNS `1.1.1.1` / `9.9.9.9` | allowed |
| LLM proxy (`LLM_PROXY_IP:LLM_PROXY_PORT`) | allowed (once the proxy exists, Phase 0 item 0.4) |
| The host itself (SSH, Coolify UI, anything listening), by gateway or public IP | blocked |
| Private, link-local, CGNAT and metadata ranges (other Coolify projects, `169.254.169.254`) | blocked |
| Another sandbox | blocked |
| Platform containers, except the LLM proxy port | blocked |

| To a sandbox from | Result |
|---|---|
| Platform containers (`172.30.0.0/24`): API gateway, worker | allowed (by container name, port 8000) |
| Host processes (provisioner, verifier) | allowed (by container IP) |
| Anything else | blocked |

Sandboxes publish **no ports** on the host.

Verified on 2026-10-12 in a Docker-in-Docker replica: Docker 27.5, iptables 1.8.11 (nf_tables), the same backend as Ubuntu 24.04. A control run without the rules reached host SSH, Postgres and Coolify, another sandbox and the API port; with the rules, all of those were blocked, and the internet, the LLM proxy and platform→sandbox traffic still worked. **This still has to be repeated on the VPS itself** (step 5).

## 1. Install the network and firewall (once, as root)

```bash
install -d /opt/athernull /etc/athernull
install -m 0755 infrastructure/sandbox-network/athernull-sandbox-net.sh /opt/athernull/
install -m 0755 infrastructure/sandbox-network/isolation-check.sh /opt/athernull/
install -m 0644 infrastructure/sandbox-network/athernull-sandbox-firewall.service /etc/systemd/system/
cat > /etc/athernull/sandbox-net.env <<'EOF'
# Set once the LLM proxy is deployed (Phase 0 item 0.4):
# LLM_PROXY_IP=172.30.0.10
# LLM_PROXY_PORT=3002
EOF
systemctl daemon-reload
systemctl enable --now athernull-sandbox-firewall
/opt/athernull/athernull-sandbox-net.sh status
```

Before step 1, check that nothing on the VPS already uses `172.30.0.0/16`:

```bash
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
```

If it's taken, set `SANDBOX_SUBNET`, `SANDBOX_GATEWAY`, `SANDBOX_PLATFORM_RANGE` and `SANDBOX_RANGE` in `/etc/athernull/sandbox-net.env`. Use the same values everywhere below.

`ufw`: Docker-forwarded traffic doesn't go through ufw. These rules sit in `DOCKER-USER` (forwarded traffic) and at the top of `INPUT` (traffic to the host), so they apply whatever ufw is doing.

## 2. Attach the API and the worker to the network (Coolify)

The API reaches sandboxes by container name (`http://athernull-sandbox-<org8>:8000`), so it must be on `athernull-sandboxes` with a **fixed platform address**. In a Coolify *Docker Compose* resource:

```yaml
services:
  api:
    # … existing build / env …
    networks:
      default: {}
      athernull-sandboxes:
        ipv4_address: 172.30.0.10
  worker:
    networks:
      default: {}
      athernull-sandboxes:
        ipv4_address: 172.30.0.11
networks:
  athernull-sandboxes:
    external: true
```

Check this against your Coolify version: open the deployed container and confirm `docker inspect <api container>` shows `172.30.0.10` on `athernull-sandboxes`. A container on the network with a dynamic address would land in the sandbox range and be treated as a sandbox (blocked).

**Gap:** the repository has a Dockerfile for `apps/web` only. The API and the worker need deployment packaging before this step (tracked as Phase 0 item 0.11 in the migration plan).

## 3. Host services (provisioner, verifier)

These run `docker`, so they stay **outside Coolify**, as systemd services under a dedicated user in the `docker` group (that user is root-equivalent: no customer input reaches it except through the database). Environment:

```
SANDBOX_NETWORK=athernull-sandboxes
SANDBOX_NETWORK_POLICY=enforced          # refuse to start a sandbox when the firewall marker is missing
SANDBOX_IMAGE=ghcr.io/openhands/agent-server@sha256:<digest>   # default pinned in apps/api/src/sandbox/policy.ts
SANDBOX_MEMORY=4g  SANDBOX_CPUS=2  SANDBOX_PIDS_LIMIT=1024      # size to the VPS: orgs × memory must fit
# SANDBOX_RUNTIME=runsc                  # gVisor (ADR-0002), only after the canvas smoke test passes under it
VERIFIER_INSTALL_NETWORK=athernull-sandboxes
VERIFIER_INSTALL_DNS=1.1.1.1,9.9.9.9
```

Sizing: every org sandbox reserves up to `SANDBOX_MEMORY`. Check `free -g` and the other projects' usage before raising the number of orgs or the limit.

## 4. Re-provision existing sandboxes

Sandboxes created before this change have no policy label, so the next provisioning run **recreates** each one under the new policy: same named volume, so conversations and files are kept; new session key. Do it per org:

```bash
pnpm --filter @athernull/api sandbox:provision -- --org <organizationId>
```

An org's sandbox is briefly unavailable while it restarts. Don't do this while one of its builds is `RUNNING`; check first:

```sql
select t.id from tasks t where t.organization_id = '<org>' and t.status = 'RUNNING';
```

## 5. Prove it (gate evidence)

```bash
LLM_PROXY_IP=172.30.0.10 LLM_PROXY_PORT=3002 \
  /opt/athernull/isolation-check.sh --public-ip <VPS public IP> --api 172.30.0.10:3001
```

The script exits 0 only when every check passes. Save its output with the release record. Until the LLM proxy work (items 0.4/0.5) lands, the **G0.2 key check is expected to FAIL**, because provider keys are still written into sandboxes today.

## Rollback

```bash
systemctl disable --now athernull-sandbox-firewall   # removes the rules and the marker
```

With `SANDBOX_NETWORK_POLICY=enforced`, provisioning then refuses to start new sandboxes; running sandboxes keep running, unprotected. To go back to the previous behaviour completely, unset `SANDBOX_NETWORK` and `SANDBOX_NETWORK_POLICY` and re-provision. The network itself is left in place; remove it with `docker network rm athernull-sandboxes` once no container uses it.
