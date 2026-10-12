# Runbook: AtherNull on the shared Coolify VPS (athernull.io)

Target: the Ubuntu 24.04 VPS that already serves the athernull.io web app through Coolify, and also runs other private projects. Devnet only.

```
Internet ─► Coolify Traefik (443, athernull.io)
             ├─ /v1 /oh /api/auth /canvas /health ─► 10.0.0.1:8091  ingress (host)   ─► API 127.0.0.1:3001
             └─ everything else ─────────────────────► web app container (Coolify, as today)
Host (systemd: athernull-backend, user athernull):
   Postgres (Docker, 127.0.0.1:5433) · API · ingress + canvas · worker · provisioner · verifier
Docker network athernull-sandboxes (firewalled): one sandbox container per organization
```

Sandboxes can reach the internet only. They can't reach the host (SSH, Coolify, Postgres), other Coolify projects, private ranges or each other (`docs/runbooks/sandbox-network.md`). The AtherNull processes run as their own `athernull` user, never root; that user is in the `docker` group because it starts sandboxes.

**Known gaps accepted for the devnet submission:** the sandbox LLM key is written into each sandbox (use a dedicated, spend-capped key, step 4); Postgres uses the dev compose password (bound to 127.0.0.1, unreachable from sandboxes); all tenants share one host.

Run everything below as root unless the step says `sudo -iu athernull`.

## 1. Prerequisites

```bash
apt-get update && apt-get install -y git python3.12-venv curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
corepack enable
# Nothing else may use these:
ss -ltnp | grep -E ':(3001|5433|8091)\b' || echo "ports free"   # 8080 is Coolify's proxy: AtherNull uses 8091
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}' | grep 172.30. || echo "172.30.0.0/16 free"
ip -4 addr show docker0 | grep inet        # this VPS: 10.0.0.1 (set in athernull-backend.service and the Traefik file)
```

## 2. User and code

```bash
useradd --system --create-home --home-dir /opt/athernull --shell /bin/bash athernull
usermod -aG docker athernull
sudo -iu athernull git clone --branch main https://github.com/bigyangg/AtherNull.git /opt/athernull/app
sudo -iu athernull bash -c 'cd /opt/athernull/app && corepack pnpm install --frozen-lockfile'
sudo -iu athernull bash -c 'cd /opt/athernull/app/workers/coding-agent && python3.12 -m venv .venv && .venv/bin/pip install -q -e .'
```

## 3. Sandbox network + firewall (protects your other projects)

```bash
cd /opt/athernull/app
# Root-owned location: the firewall runs as root, so the athernull user must not be able to edit it.
install -d -o root -g root /usr/local/lib/athernull /etc/athernull
install -m 0755 infrastructure/sandbox-network/athernull-sandbox-net.sh /usr/local/lib/athernull/
install -m 0755 infrastructure/sandbox-network/isolation-check.sh /usr/local/lib/athernull/
sed 's#/opt/athernull/athernull-sandbox-net.sh#/usr/local/lib/athernull/athernull-sandbox-net.sh#g' \
  infrastructure/sandbox-network/athernull-sandbox-firewall.service > /etc/systemd/system/athernull-sandbox-firewall.service
touch /etc/athernull/sandbox-net.env
systemctl daemon-reload && systemctl enable --now athernull-sandbox-firewall
/usr/local/lib/athernull/athernull-sandbox-net.sh status
```

## 4. Secrets

`/opt/athernull/app/apps/api/.env` (owner `athernull`, mode 600). Generate each secret with `openssl rand -hex 32`.

```ini
DATABASE_URL=postgres://athernull:athernull@localhost:5433/athernull_dev
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://athernull.io
WEB_APP_URL=https://athernull.io
TRUSTED_ORIGINS=https://athernull.io,https://www.athernull.io
RESEND_API_KEY=<resend key>
EMAIL_FROM=AtherNull <noreply@athernull.io>
INTERNAL_API_TOKEN=<openssl rand -hex 32>
VERIFIER_API_TOKEN=<openssl rand -hex 32, different>
# A NIM key used ONLY for this deployment, with a spend/rate cap: sandboxes can read it.
NVIDIA_NIM_API_KEY=<dedicated key>
SOLANA_NETWORK=devnet
SOLANA_RPC_PROVIDER=helius
SOLANA_RPC_URL=<helius devnet url>
SOLANA_FUNDING_PROGRAM_ID=9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv
SOLANA_AUTHORITY_KEYPAIR=<devnet authority JSON array>
SOLANA_DEMO_REQUIRED_LAMPORTS=50000000
# Sandboxes: isolated network, firewall required, reached by IP from the host.
SANDBOX_NETWORK=athernull-sandboxes
SANDBOX_NETWORK_POLICY=enforced
SANDBOX_REACH=ip
SANDBOX_MEMORY=2g
SANDBOX_CPUS=1
CHAT_BUILD_DEFAULT_BUDGET_MINOR=2000
```

`/opt/athernull/app/workers/coding-agent/.env` (same owner, mode 600):

```ini
NVIDIA_NIM_API_KEY=<same dedicated key>
INTERNAL_API_TOKEN=<same as the API's>
```

Size check: every active organization can take up to `SANDBOX_MEMORY`. `free -g` minus what your other projects use, divided by 2, is roughly how many judges can work at once.

## 5. Start the backend

```bash
cp /opt/athernull/app/infrastructure/vps/athernull-backend.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now athernull-backend
journalctl -u athernull-backend -f      # first start builds the canvas: a few minutes
curl -s http://10.0.0.1:8091/health    # {"status":"ok"}-style answer once up
```

If `ufw` is active, let Coolify's proxy (not the internet) reach the ingress:

```bash
ufw status | grep -q "Status: active" && ufw allow from 10.0.0.0/8 to 10.0.0.1 port 8091 proto tcp
```

## 6. Route athernull.io to it (Coolify)

1. Coolify → Servers → this server → Proxy → Dynamic Configurations → new file `athernull-backend.yaml` with `infrastructure/vps/athernull-backend.traefik.yaml`.
2. The web app resource in Coolify:
   - Git branch: `main`; Base Directory `/`; Dockerfile `apps/web/Dockerfile`.
   - Environment: `NEXT_PUBLIC_API_URL=https://athernull.io` (tick **Build Variable**). Remove `LANDING_ONLY_MODE` (or set it to `false`).
   - Redeploy.

## 7. Check it

```bash
curl -sI https://athernull.io/canvas/ | head -1        # 200
curl -s  https://athernull.io/health
# Isolation evidence (G0.1/G0.3). G0.2 (key check) is expected to fail until the LLM proxy exists.
/usr/local/lib/athernull/isolation-check.sh --public-ip <VPS public IP> --api 172.30.0.1:3001
```

Then in a browser: sign up at https://athernull.io (verification email via Resend) → canvas opens and provisions the org sandbox → "lets build a calculator app" → Draft plan → Approve → Pay now with Phantom on Devnet (fund the wallet at https://faucet.solana.com) → build → review → Accept.

## Update / roll back

```bash
sudo -iu athernull bash -c 'cd /opt/athernull/app && git pull && corepack pnpm install --frozen-lockfile'
systemctl restart athernull-backend
# Stop everything (sandboxes keep running; remove with docker rm -f $(docker ps -aq --filter name=athernull-sandbox-)):
systemctl disable --now athernull-backend
# Remove the Traefik file in Coolify to send all traffic back to the web app.
```
