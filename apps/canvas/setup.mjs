#!/usr/bin/env node
// Fetches the pinned OpenHands Agent Canvas into ./upstream (gitignored),
// applies AtherNull's patches (./patches, applied in order, idempotently)
// and installs its dependencies. ADR-0015: a pinned upstream plus explicit
// patches — never a silent fork.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Which set of patches the working tree carries. A patch whose content
// changed cannot be applied on top of its older version, so whenever the set
// differs from what was last applied (or is unknown), the tree goes back to
// the pinned commit and every patch is applied again, in order. node_modules
// and build/ are git-ignored, so `git clean -fd` keeps them.
const patches = readdirSync(join(here, "patches")).filter((f) => f.endsWith(".patch")).sort();
const fingerprint = createHash("sha256");
for (const patch of patches) {
  fingerprint.update(patch);
  fingerprint.update(readFileSync(join(here, "patches", patch), "utf8").replace(/\r\n/g, "\n"));
}
const wanted = fingerprint.digest("hex");
const marker = join(upstream, ".athernull-patches");
const applied = existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;

if (applied === wanted) {
  console.log(`patches up to date (${patches.length})`);
} else {
  if (applied !== null || gitQuiet("diff", "--quiet") === false) {
    console.log(applied === null ? "patch state unknown: resetting to the pinned commit" : "patches changed: resetting to the pinned commit");
  }
  git("checkout", "--", ".");
  git("clean", "-fdq");
  for (const patch of patches) {
    git("apply", join(here, "patches", patch));
    console.log(`applied: ${patch}`);
  }
  writeFileSync(marker, `${wanted}\n`);
}

if (!existsSync(join(upstream, "node_modules"))) {
  execFileSync("npm", ["ci"], { cwd: upstream, stdio: "inherit", shell: true });
}
console.log("agent canvas ready in apps/canvas/upstream");
