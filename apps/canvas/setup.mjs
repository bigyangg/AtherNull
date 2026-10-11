#!/usr/bin/env node
// Fetches the pinned OpenHands Agent Canvas into ./upstream (gitignored),
// applies AtherNull's patches (./patches, applied in order, idempotently)
// and installs its dependencies. ADR-0015: a pinned upstream plus explicit
// patches — never a silent fork.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const upstream = join(here, "upstream");
const pin = JSON.parse(readFileSync(join(here, "UPSTREAM.json"), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: upstream, stdio: "inherit" });
const gitQuiet = (...args) => {
  try {
    execFileSync("git", args, { cwd: upstream, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

if (!existsSync(join(upstream, ".git"))) {
  execFileSync("git", ["init", "-q", upstream], { stdio: "inherit" });
  git("remote", "add", "origin", pin.repository);
  git("fetch", "--depth", "1", "origin", pin.commit);
  git("checkout", "-q", "FETCH_HEAD");
}
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: upstream, encoding: "utf8" }).trim();
if (head !== pin.commit) throw new Error(`upstream is at ${head}, expected pinned ${pin.commit}`);

for (const patch of readdirSync(join(here, "patches")).filter((f) => f.endsWith(".patch")).sort()) {
  const file = join(here, "patches", patch);
  if (gitQuiet("apply", "--check", "-R", file)) {
    console.log(`already applied: ${patch}`);
  } else {
    git("apply", file);
    console.log(`applied: ${patch}`);
  }
}

if (!existsSync(join(upstream, "node_modules"))) {
  execFileSync("npm", ["ci"], { cwd: upstream, stdio: "inherit", shell: true });
}
console.log("agent canvas ready in apps/canvas/upstream");
