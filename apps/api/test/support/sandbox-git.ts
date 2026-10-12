// What the build worker does in a sandbox (ADR-0019), with plain git:
// clone the base bundle, apply edits, commit once on builds/<task id> as
// the AtherNull Agent, and bundle that branch on top of its base.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const sh = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "core.autocrlf=false", "-c", "user.name=AtherNull Agent", "-c", "user.email=agent@athernull.io", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

export function buildInSandbox(
  scratch: string,
  base: Buffer,
  baseCommit: string,
  taskId: string,
  edits: Record<string, string | null>,
  extraCommit = false,
): Buffer {
  const dir = join(scratch, randomUUID());
  const bundleIn = `${dir}.in.bundle`;
  writeFileSync(bundleIn, base);
  execFileSync("git", ["-c", "core.autocrlf=false", "clone", "--quiet", bundleIn, dir], { stdio: "ignore" });
  sh(dir, "checkout", "--quiet", "-B", `builds/${taskId}`, baseCommit);
  for (const [file, content] of Object.entries(edits)) {
    if (content === null) rmSync(join(dir, file));
    else writeFileSync(join(dir, file), content);
  }
  sh(dir, "add", "-A");
  sh(dir, "commit", "--quiet", "-m", `Build ${taskId}`, "-m", `Build-Id: ${taskId}`);
  if (extraCommit) {
    writeFileSync(join(dir, "extra.txt"), "x\n");
    sh(dir, "add", "-A");
    sh(dir, "commit", "--quiet", "-m", "second");
  }
  const out = `${dir}.out.bundle`;
  sh(dir, "bundle", "create", "--quiet", out, `builds/${taskId}`, `^${baseCommit}`);
  return readFileSync(out);
}

/** A plain local repository with one commit on `trunk`; returns its path and head. */
export function sourceRepo(scratch: string, files: Record<string, string>): { path: string; head: string } {
  const path = join(scratch, randomUUID());
  execFileSync("git", ["init", "--quiet", "--initial-branch=trunk", path]);
  for (const [file, content] of Object.entries(files)) writeFileSync(join(path, file), content);
  sh(path, "add", "-A");
  sh(path, "commit", "--quiet", "-m", "start");
  return { path, head: sh(path, "rev-parse", "HEAD") };
}
