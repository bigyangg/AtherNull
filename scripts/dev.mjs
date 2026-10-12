#!/usr/bin/env node
// One command for the whole local AtherNull stack (docs/runbooks/demo-stack.md):
//
//   node scripts/dev.mjs              start everything on http://localhost:8080
//   node scripts/dev.mjs --init-env   first write apps/api/.env from your local
//                                     secrets (~/.athernull-devnet, worker .env)
//   node scripts/dev.mjs --prod       the server (docs/runbooks/vps-deploy.md):
//                                     PUBLIC_ORIGIN, no file watching, no web app
//                                     (the web app is deployed on its own), the
//                                     canvas rebuilt for PUBLIC_ORIGIN, API on
//                                     127.0.0.1, ingress on INGRESS_HOST
//
// Postgres (Docker) -> migrations -> canvas build (if missing) -> demo repo ->
// API, web, ingress and worker as child processes with prefixed output.
// Ctrl-C stops them all. Org sandboxes are separate, long-lived containers:
// `pnpm --filter @athernull/api sandbox:provision -- --org <id>`.

import { execFileSync, spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const PROD = process.argv.includes("--prod");
const ORIGIN = (PROD ? process.env.PUBLIC_ORIGIN : null) ?? "http://localhost:8080";
if (PROD && !process.env.PUBLIC_ORIGIN) throw new Error("--prod needs PUBLIC_ORIGIN, e.g. https://athernull.io");
const PG_CONTAINER = "athernull-dev-postgres-1";
const DB = "postgres://athernull:athernull@localhost:5433/athernull_dev";
const isWin = process.platform === "win32";

const log = (msg) => console.log(`\x1b[36m[dev]\x1b[0m ${msg}`);
// Windows needs a shell to resolve bare commands like `pnpm` (pnpm.cmd), but
// a shell would split an absolute path such as C:/Program Files/nodejs/node.exe.
const needsShell = (cmd) => isWin && !/[\\/]/.test(cmd);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: "inherit", cwd: root, shell: needsShell(cmd), ...opts });
const capture = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", cwd: root, ...opts });

function parseEnv(file) {
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
  );
}

// --- apps/api/.env -------------------------------------------------------------

function initEnv() {
  const target = join(root, "apps/api/.env");
  if (existsSync(target)) {
    log("apps/api/.env already exists; leaving it alone");
    return;
  }
  const secrets = join(homedir(), ".athernull-devnet");
  const worker = parseEnv(join(root, "workers/coding-agent/.env"));
  const read = (f) => (existsSync(join(secrets, f)) ? readFileSync(join(secrets, f), "utf8").trim() : "");
  const lines = [
    "# Written by scripts/dev.mjs --init-env (local development only; gitignored).",
    `DATABASE_URL=${DB}`,
    `BETTER_AUTH_SECRET=${capture(process.execPath, ["-e", "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"])}`,
    `BETTER_AUTH_URL=${ORIGIN}`,
    `WEB_APP_URL=${ORIGIN}`,
    `TRUSTED_ORIGINS=${ORIGIN}`,
    `INTERNAL_API_TOKEN=${worker.INTERNAL_API_TOKEN ?? ""}`,
    `VERIFIER_API_TOKEN=${randomToken()}`,
    `NVIDIA_NIM_API_KEY=${worker.NVIDIA_NIM_API_KEY ?? ""}`,
    "SOLANA_NETWORK=devnet",
    "SOLANA_RPC_PROVIDER=helius",
    `SOLANA_RPC_URL=${read("helius-rpc-url.txt")}`,
    "SOLANA_FUNDING_PROGRAM_ID=9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv",
    `SOLANA_AUTHORITY_KEYPAIR=${read("platform-authority.json")}`,
    "SOLANA_DEMO_REQUIRED_LAMPORTS=50000000",
  ];
  writeFileSync(target, `${lines.join("\n")}\n`);
  log("wrote apps/api/.env (values not printed)");
  if (!worker.INTERNAL_API_TOKEN) log("warning: no INTERNAL_API_TOKEN in workers/coding-agent/.env; the worker cannot claim builds");
}

function randomToken() {
  return capture(process.execPath, ["-e", "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"]);
}

// ADR-0017: the verifier needs its own credential, distinct from the worker's.
function ensureVerifierToken() {
  const target = join(root, "apps/api/.env");
  if (parseEnv(target).VERIFIER_API_TOKEN) return;
  const current = readFileSync(target, "utf8");
  const separator = current.endsWith("\n") ? "" : "\n";
  writeFileSync(target, `${current}${separator}VERIFIER_API_TOKEN=${randomToken()}\n`);
  log("added VERIFIER_API_TOKEN to apps/api/.env");
}

// --- Postgres + migrations --------------------------------------------------------

function psql(sql, file) {
  const args = ["exec", "-i", PG_CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-q", "-U", "athernull", "-d", "athernull_dev"];
  return execFileSync("docker", file ? [...args, "-1"] : [...args, "-tAc", sql], {
    encoding: "utf8",
    input: file ? readFileSync(file) : undefined,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function startPostgres() {
  run("docker", ["compose", "-f", "infrastructure/docker-compose.yml", "up", "-d", "postgres"]);
  for (let i = 0; i < 60; i++) {
    try {
      execFileSync("docker", ["exec", PG_CONTAINER, "pg_isready", "-U", "athernull"], { stdio: "ignore" });
      return;
    } catch {
      execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1000)"]);
    }
  }
  throw new Error("Postgres did not become ready");
}

// Applies packages/database/migrations in order, once each. A database set up
// by hand before this runner existed has no record of what ran: a migration
// that fails only because its objects already exist is recorded as applied
// (each file runs in one transaction, so it either fully ran before or not).
function migrate() {
  psql("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const applied = new Set(psql("select name from schema_migrations").split(/\r?\n/).filter(Boolean));
  const dir = join(root, "packages/database/migrations");
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(name)) continue;
    try {
      psql(null, join(dir, name));
      log(`migrated ${name}`);
    } catch (err) {
      const stderr = String(err.stderr ?? err.message);
      if (!/already exists/.test(stderr)) throw new Error(`migration ${name} failed:\n${stderr}`);
      log(`recorded ${name} (already applied)`);
    }
    psql(`insert into schema_migrations (name) values ('${name}') on conflict do nothing`);
  }
}

// --- canvas + demo repo -------------------------------------------------------------

function ensureCanvas() {
  if (PROD) {
    // Always rebuilt on the server: the build bakes in the public origin.
    log(`building the Agent Canvas for ${ORIGIN}`);
    run(process.execPath, ["apps/canvas/setup.mjs"]);
    run(process.execPath, ["apps/canvas/build.mjs"], { env: { ...process.env, CANVAS_PUBLIC_ORIGIN: ORIGIN } });
    return;
  }
  if (existsSync(join(root, "apps/canvas/upstream/build/index.html"))) return;
  log("building the Agent Canvas (first run takes a few minutes)");
  run(process.execPath, ["apps/canvas/setup.mjs"]);
  run(process.execPath, ["apps/canvas/build.mjs"]);
}

// examples/demo-api as a standalone git repository a project can point at.
function ensureDemoRepo() {
  const dest = join(homedir(), ".athernull", "demo-api");
  if (existsSync(join(dest, ".git"))) return dest;
  mkdirSync(join(homedir(), ".athernull"), { recursive: true });
  rmSync(dest, { recursive: true, force: true });
  cpSync(join(root, "examples/demo-api"), dest, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: dest, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("-c", "user.name=AtherNull", "-c", "user.email=demo@athernull.local", "commit", "-q", "-m", "Initial demo API");
  log(`demo repository ready at ${dest}`);
  return dest;
}

// --- processes ----------------------------------------------------------------------

const children = [];
function start(name, color, cmd, args, opts) {
  const child = spawn(cmd, args, { cwd: root, shell: needsShell(cmd), stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) process.stdout.write(prefix + line + "\n");
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  child.on("exit", (code) => log(`${name} exited (${code})`));
  children.push(child);
}

function stopAll() {
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWin) {
      try {
        execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } else {
      child.kill("SIGTERM");
    }
  }
}

// A service that finds its port taken would silently move to another one and
// break the single-origin routing, so refuse to start instead.
function assertPortsFree(ports) {
  return Promise.all(
    ports.map(
      (port) =>
        new Promise((resolve, reject) => {
          const probe = net.createServer();
          probe.once("error", () => reject(new Error(`port ${port} is already in use; stop whatever is running there first`)));
          probe.listen(port, "127.0.0.1", () => probe.close(resolve));
        }),
    ),
  );
}

// --- main ---------------------------------------------------------------------------

if (process.argv.includes("--init-env")) initEnv();
if (!existsSync(join(root, "apps/api/.env"))) {
  console.error("apps/api/.env is missing. Run `node scripts/dev.mjs --init-env` or copy apps/api/.env.example.");
  process.exit(1);
}

ensureVerifierToken();
await assertPortsFree(PROD ? [3001, 8080] : [3000, 3001, 8080]);
startPostgres();
migrate();
ensureCanvas();
const demoRepo = PROD ? null : ensureDemoRepo();

const worker = parseEnv(join(root, "workers/coding-agent/.env"));
const python = join(root, "workers/coding-agent", isWin ? ".venv/Scripts/python.exe" : ".venv/bin/python");

if (PROD) {
  start("api", "32", "pnpm", ["--filter", "@athernull/api", "exec", "tsx", "--env-file-if-exists=.env", "src/index.ts"], {
    env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1" },
  });
} else {
  start("api", "32", "pnpm", ["--filter", "@athernull/api", "dev"]);
  start("web", "35", "pnpm", ["--filter", "@athernull/web", "dev"], { env: { ...process.env, NEXT_PUBLIC_API_URL: ORIGIN } });
}
start("ingress", "34", process.execPath, ["infrastructure/ingress/dev-ingress.mjs"], {
  env: { ...process.env, CANVAS_DIST: join(root, "apps/canvas/upstream/build") },
});
if (existsSync(python)) {
  start("worker", "33", python, ["-u", "-m", "coding_agent.worker"], {
    cwd: join(root, "workers/coding-agent"),
    shell: false,
    env: {
      ...process.env,
      ...worker,
      ATHERNULL_API_URL: "http://localhost:3001",
      EXECUTION_ADAPTER: "org_sandbox",
      OPENHANDS_SUPPRESS_BANNER: "1",
      PYTHONPATH: "src",
    },
  });
} else {
  log("worker venv not found (workers/coding-agent/.venv); builds will stay queued");
}

// Sandbox provisioner (ADR-0018): creates org workspaces on demand.
start("provisioner", "36", "pnpm", ["--filter", "@athernull/api", "sandbox:provisioner"]);

// Independent verifier (ADR-0017): stdlib-only Python, its own token.
const apiEnv = parseEnv(join(root, "apps/api/.env"));
start("verifier", "31", existsSync(python) ? python : "python", ["-u", "-m", "verifier.service"], {
  cwd: join(root, "services/verifier"),
  shell: false,
  env: {
    ...process.env,
    PYTHONPATH: "src",
    ATHERNULL_API_URL: "http://localhost:3001",
    VERIFIER_API_TOKEN: apiEnv.VERIFIER_API_TOKEN,
  },
});

log(`AtherNull on ${ORIGIN}  (sign in, then provision your org's sandbox once)`);
if (demoRepo) log(`demo repository for projects: ${demoRepo}`);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stopAll();
    process.exit(0);
  });
}
