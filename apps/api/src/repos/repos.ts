import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { git, GitError, gitText } from "./git.js";

// ADR-0019 — every project's code lives in a bare repository AtherNull hosts.
// This module is the only code that reads or writes those repositories.
// Nothing here moves `main` except advanceBranch, which is a
// compare-and-swap; candidates (merges, reverts) are computed without a
// working tree and only become `main` once verified and accepted.

export const AGENT_IDENTITY = { name: "AtherNull Agent", email: "agent@athernull.io" };
export const MAIN = "main";

const ZERO = "0000000000000000000000000000000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{40}$/;

const DEFAULT_GITIGNORE = `# Added by AtherNull so dependencies, build output and secrets are never committed.
node_modules/
.venv/
venv/
__pycache__/
dist/
build/
.next/
coverage/
*.log
.env
.env.*
!.env.example
.DS_Store
`;

export function reposRoot(): string {
  return resolve(process.env.REPOS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".data", "repos"));
}

/** A project's repository path, from ids only — never from user input. */
export function repoPath(organizationId: string, projectId: string): string {
  if (!UUID.test(organizationId) || !UUID.test(projectId)) throw new Error("repository ids must be UUIDs");
  return join(reposRoot(), organizationId.toLowerCase(), `${projectId.toLowerCase()}.git`);
}

function identityEnv(who = AGENT_IDENTITY): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: who.name,
    GIT_AUTHOR_EMAIL: who.email,
    GIT_COMMITTER_NAME: who.name,
    GIT_COMMITTER_EMAIL: who.email,
  };
}

function assertSha(value: string, what: string): string {
  if (!SHA.test(value)) throw new Error(`${what} is not a full commit id`);
  return value;
}

async function initBare(repo: string): Promise<void> {
  await mkdir(dirname(repo), { recursive: true });
  await git(["init", "--quiet", "--bare", `--initial-branch=${MAIN}`, repo]);
}

async function writeBlob(repo: string, content: string): Promise<string> {
  return gitText(["hash-object", "-w", "--stdin"], { cwd: repo, input: content });
}

/** A new, empty project: README + default .gitignore as the first version. */
export async function createRepo(repo: string, title: string): Promise<string> {
  await initBare(repo);
  const readme = await writeBlob(repo, `# ${title}\n\nBuilt with AtherNull.\n`);
  const ignore = await writeBlob(repo, DEFAULT_GITIGNORE);
  const tree = await gitText(["mktree"], { cwd: repo, input: `100644 blob ${ignore}\t.gitignore\n100644 blob ${readme}\tREADME.md\n` });
  const commit = await gitText(["commit-tree", tree, "-m", "Create project"], { cwd: repo, env: identityEnv() });
  await git(["update-ref", `refs/heads/${MAIN}`, commit, ZERO], { cwd: repo });
  return commit;
}

/**
 * An existing repository's default branch becomes `main`. `https` only,
 * unless allowLocal (development: a folder on the API host).
 */
export async function importRepo(repo: string, source: string, options: { allowLocal?: boolean } = {}): Promise<string> {
  const isHttps = /^https:\/\//i.test(source);
  if (!isHttps && !options.allowLocal) throw new Error("only https repositories can be imported");
  await initBare(repo);
  try {
    await git(["fetch", "--quiet", "--no-tags", "--end-of-options", source, `+HEAD:refs/heads/${MAIN}`], {
      cwd: repo,
      env: { GIT_ALLOW_PROTOCOL: options.allowLocal ? "https:file" : "https" },
    });
  } catch (err) {
    await rm(repo, { recursive: true, force: true });
    throw err;
  }
  return headOf(repo);
}

export async function headOf(repo: string, branch = MAIN): Promise<string> {
  return gitText(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], { cwd: repo });
}

export async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repo, okCodes: [1] });
  return res.code === 0;
}

async function withTempFile<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const file = join(tmpdir(), `athernull-${randomUUID()}.bundle`);
  try {
    return await fn(file);
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * A bundle of `commit` and its history, for a sandbox or the verifier.
 * Bundles need a branch name, so a short-lived uniquely named branch is
 * created and removed around it; a plain `git clone` of the bundle then
 * holds the commit.
 */
export async function bundleOf(repo: string, commit: string): Promise<Buffer> {
  assertSha(commit, "commit");
  const ref = `refs/heads/athernull-out-${randomUUID()}`;
  await git(["update-ref", ref, commit, ZERO], { cwd: repo });
  try {
    return await withTempFile(async (file) => {
      await git(["bundle", "create", "--quiet", file, ref], { cwd: repo });
      return readFile(file);
    });
  } finally {
    await git(["update-ref", "-d", ref], { cwd: repo });
  }
}

export class BundleRejected extends Error {}

/**
 * A build's result, as a bundle from the worker. Accepted only if it holds
 * exactly `refs/heads/<branch>` and that branch is ONE commit whose only
 * parent is `base`. It is fetched into quarantine first and only then
 * becomes the branch. Returns the result commit.
 */
export async function receiveBuildBundle(repo: string, bundle: Buffer, branch: string, base: string): Promise<string> {
  assertSha(base, "base");
  if (!/^builds\/[0-9a-f-]{36}$/i.test(branch)) throw new BundleRejected("unexpected build branch name");
  return withTempFile(async (file) => {
    await writeFile(file, bundle);
    try {
      await git(["bundle", "verify", "--quiet", file], { cwd: repo });
    } catch (err) {
      throw new BundleRejected(`the result bundle does not verify: ${err instanceof GitError ? err.stderr.trim().slice(-200) : err}`);
    }
    const heads = (await gitText(["bundle", "list-heads", file], { cwd: repo })).split("\n").filter(Boolean);
    if (heads.length !== 1 || heads[0]!.split(/\s+/)[1] !== `refs/heads/${branch}`) {
      throw new BundleRejected(`the result bundle must hold exactly refs/heads/${branch}`);
    }
    const quarantine = `refs/athernull/incoming/${randomUUID()}`;
    await git(["fetch", "--quiet", "--no-tags", file, `+refs/heads/${branch}:${quarantine}`], { cwd: repo });
    try {
      const [head, ...parents] = (await gitText(["rev-list", "--parents", "-n", "1", quarantine], { cwd: repo })).split(" ");
      if (parents.length !== 1 || parents[0] !== base) {
        throw new BundleRejected("the build must be exactly one commit on top of its base");
      }
      await git(["update-ref", `refs/heads/${branch}`, head!], { cwd: repo });
      return head!;
    } finally {
      await git(["update-ref", "-d", quarantine], { cwd: repo });
    }
  });
}

export interface DiffResult {
  patch: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** The change between two commits, as a binary-safe patch plus stats. */
export async function diffOf(repo: string, base: string, head: string): Promise<DiffResult> {
  const patch = (await git(["diff", "--binary", "--full-index", "--no-color", base, head], { cwd: repo })).stdout.toString("utf8");
  const numstat = await gitText(["diff", "--numstat", base, head], { cwd: repo });
  let insertions = 0;
  let deletions = 0;
  const lines = numstat ? numstat.split("\n") : [];
  for (const line of lines) {
    const [added, removed] = line.split("\t");
    insertions += Number(added) || 0; // "-" for binary files
    deletions += Number(removed) || 0;
  }
  return { patch, filesChanged: lines.length, insertions, deletions };
}

export type Candidate =
  | { kind: "fast-forward"; commit: string }
  | { kind: "merge"; commit: string }
  | { kind: "conflict"; files: string[] };

/**
 * What `main` would become if `from` were accepted onto `onto` — computed
 * without touching any branch. A fast-forward is the commit already
 * verified; a merge is a new commit that needs verifying.
 */
export async function mergeCandidate(repo: string, onto: string, from: string, message: string): Promise<Candidate> {
  assertSha(onto, "onto");
  assertSha(from, "from");
  if (await isAncestor(repo, onto, from)) return { kind: "fast-forward", commit: from };
  const res = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", onto, from], { cwd: repo, okCodes: [1] });
  const out = res.stdout.toString("utf8").trim().split("\n");
  if (res.code === 1) return { kind: "conflict", files: out.slice(1).filter(Boolean) };
  const commit = await gitText(["commit-tree", out[0]!, "-p", onto, "-p", from, "-m", message], { cwd: repo, env: identityEnv() });
  return { kind: "merge", commit };
}

/** A commit that undoes `commit` on top of `onto` (its first-parent change). */
export async function revertCandidate(repo: string, onto: string, commit: string, message: string): Promise<Candidate> {
  assertSha(onto, "onto");
  assertSha(commit, "commit");
  const parent = await gitText(["rev-parse", "--verify", "--quiet", `${commit}^1`], { cwd: repo }).catch(() => "");
  if (!parent) throw new Error("the first version of a project cannot be undone");
  const res = await git(["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${commit}`, onto, parent], {
    cwd: repo,
    okCodes: [1],
  });
  const out = res.stdout.toString("utf8").trim().split("\n");
  if (res.code === 1) return { kind: "conflict", files: out.slice(1).filter(Boolean) };
  const reverted = await gitText(["commit-tree", out[0]!, "-p", onto, "-m", message], { cwd: repo, env: identityEnv() });
  return { kind: "merge", commit: reverted };
}

/**
 * Moves a branch from `expected` to `next` only if it is still at
 * `expected` (compare-and-swap). False when someone else moved it first.
 */
export async function advanceBranch(repo: string, branch: string, next: string, expected: string): Promise<boolean> {
  assertSha(next, "next");
  assertSha(expected, "expected");
  try {
    await git(["update-ref", `refs/heads/${branch}`, next, expected], { cwd: repo });
    return true;
  } catch (err) {
    if (err instanceof GitError && (await headOf(repo, branch).catch(() => "")) !== expected) return false;
    throw err;
  }
}

export interface Version {
  number: number;
  commit: string;
  title: string;
  date: string;
  author: string;
  buildId: string | null;
}

/** The project's versions: `main`'s first-parent history, newest first. */
export async function versionsOf(repo: string): Promise<Version[]> {
  const raw = await gitText(
    ["log", "--first-parent", "--format=%H%x1f%s%x1f%aI%x1f%an%x1f%(trailers:key=Build-Id,valueonly,separator=%x2c)%x1e", `refs/heads/${MAIN}`],
    { cwd: repo },
  );
  const rows = raw.split("\x1e").map((r) => r.trim()).filter(Boolean);
  return rows.map((row, i) => {
    const [commit, title, date, author, buildId] = row.split("\x1f");
    return { number: rows.length - i, commit: commit!, title: title!, date: date!, author: author!, buildId: buildId?.trim() || null };
  });
}

/** Any version as a zip. */
export async function archiveOf(repo: string, commit: string): Promise<Buffer> {
  assertSha(commit, "commit");
  return (await git(["archive", "--format=zip", commit], { cwd: repo })).stdout;
}
