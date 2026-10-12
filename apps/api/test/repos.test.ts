// ADR-0019 hosted repositories: the git module on real temporary
// repositories. A "sandbox" here is a plain clone of a bundle, edited and
// committed the way the build worker does it.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgres://athernull:athernull@localhost:5433/athernull_test";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

process.env.REPOS_ROOT = mkdtempSync(join(tmpdir(), "athernull-repos-"));

const repos = await import("../src/repos/index.js");
const { db } = await import("../src/db.js");

const { buildInSandbox: sandboxBuild, sh, sourceRepo } = await import("./support/sandbox-git.js");

const scratch = mkdtempSync(join(tmpdir(), "athernull-sandbox-"));
const buildInSandbox = (base: Buffer, baseCommit: string, taskId: string, edits: Record<string, string | null>, extraCommit = false) =>
  sandboxBuild(scratch, base, baseCommit, taskId, edits, extraCommit);

const show = (repo: string, commit: string, file: string) => sh(repo, "show", `${commit}:${file}`);

after(async () => {
  await db.destroy();
  rmSync(process.env.REPOS_ROOT!, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

describe("hosted repositories", () => {
  const org = randomUUID();
  let repo: string;
  let first: string;

  before(async () => {
    repo = repos.repoPath(org, randomUUID());
    first = await repos.createRepo(repo, "Booking site");
  });

  test("paths come from ids only, under REPOS_ROOT", () => {
    assert.ok(repo.startsWith(process.env.REPOS_ROOT!));
    assert.throws(() => repos.repoPath("../etc", randomUUID()));
    assert.throws(() => repos.repoPath(org, "x/../../y"));
  });

  test("a new project starts with one version: README and a protective .gitignore", async () => {
    assert.equal(await repos.headOf(repo), first);
    assert.match(show(repo, first, "README.md"), /Booking site/);
    const ignore = show(repo, first, ".gitignore");
    for (const entry of ["node_modules/", ".env", ".venv/"]) assert.ok(ignore.includes(entry), entry);
    const versions = await repos.versionsOf(repo);
    assert.equal(versions.length, 1);
    assert.equal(versions[0]!.number, 1);
    assert.equal(versions[0]!.author, "AtherNull Agent");
  });

  test("a bundle of a commit clones into a working copy, leaving no stray branches", async () => {
    const bundle = await repos.bundleOf(repo, first);
    const dir = join(scratch, randomUUID());
    writeFileSync(`${dir}.bundle`, bundle);
    execFileSync("git", ["clone", "--quiet", `${dir}.bundle`, dir], { stdio: "ignore" });
    sh(dir, "checkout", "--quiet", first);
    assert.equal(sh(dir, "rev-parse", "HEAD"), first);
    assert.equal(sh(repo, "for-each-ref", "--format=%(refname)"), "refs/heads/main");
  });

  let buildA: string;
  const taskA = randomUUID();

  test("a build comes back as exactly one commit on its base, and its diff is derived", async () => {
    const bundle = buildInSandbox(await repos.bundleOf(repo, first), first, taskA, { "index.html": "<h1>Book</h1>\n" });
    buildA = await repos.receiveBuildBundle(repo, bundle, `builds/${taskA}`, first);
    assert.equal(await repos.headOf(repo, `builds/${taskA}`), buildA);
    assert.equal(await repos.headOf(repo), first, "main does not move on receive");
    const diff = await repos.diffOf(repo, first, buildA);
    assert.deepEqual([diff.filesChanged, diff.insertions, diff.deletions], [1, 1, 0]);
    assert.match(diff.patch, /\+<h1>Book<\/h1>/);
    assert.ok(!sh(repo, "for-each-ref", "--format=%(refname)").includes("incoming"), "quarantine refs are cleaned up");
  });

  test("a result bundle is rejected unless it is one commit on the right base and branch", async () => {
    const base = await repos.bundleOf(repo, first);
    const taskB = randomUUID();
    const twoCommits = buildInSandbox(base, first, taskB, { "a.txt": "a\n" }, true);
    await assert.rejects(repos.receiveBuildBundle(repo, twoCommits, `builds/${taskB}`, first), repos.BundleRejected);
    const ok = buildInSandbox(base, first, taskB, { "a.txt": "a\n" });
    await assert.rejects(repos.receiveBuildBundle(repo, ok, `builds/${randomUUID()}`, first), repos.BundleRejected, "wrong branch");
    await assert.rejects(repos.receiveBuildBundle(repo, ok, `builds/${taskB}`, buildA), repos.BundleRejected, "wrong base");
    await assert.rejects(repos.receiveBuildBundle(repo, Buffer.from("not a bundle"), `builds/${taskB}`, first), repos.BundleRejected);
    await assert.rejects(repos.receiveBuildBundle(repo, ok, "main", first), repos.BundleRejected, "never main");
    assert.equal(await repos.headOf(repo), first);
  });

  test("accepting onto an unchanged main is a fast-forward to the verified commit", async () => {
    const candidate = await repos.mergeCandidate(repo, first, buildA, "unused");
    assert.deepEqual(candidate, { kind: "fast-forward", commit: buildA });
    assert.equal(await repos.advanceBranch(repo, repos.MAIN, buildA, first), true);
    assert.equal(await repos.headOf(repo), buildA);
  });

  test("moving main is a compare-and-swap: a stale expectation changes nothing", async () => {
    assert.equal(await repos.advanceBranch(repo, repos.MAIN, first, first), false);
    assert.equal(await repos.headOf(repo), buildA);
  });

  let merged: string;
  let taskC: string;

  test("a build based on an older main merges cleanly into a new commit with both changes", async () => {
    taskC = randomUUID();
    const c = buildInSandbox(await repos.bundleOf(repo, first), first, taskC, { "about.html": "<p>About</p>\n" });
    const buildC = await repos.receiveBuildBundle(repo, c, `builds/${taskC}`, first);
    const candidate = await repos.mergeCandidate(repo, buildA, buildC, `Accept build ${taskC}\n\nBuild-Id: ${taskC}`);
    assert.equal(candidate.kind, "merge");
    merged = (candidate as { commit: string }).commit;
    assert.equal(sh(repo, "rev-list", "--parents", "-n", "1", merged), `${merged} ${buildA} ${buildC}`);
    assert.equal(show(repo, merged, "index.html"), "<h1>Book</h1>");
    assert.equal(show(repo, merged, "about.html"), "<p>About</p>");
    assert.equal(await repos.headOf(repo), buildA, "a candidate never moves main by itself");
    assert.equal(await repos.advanceBranch(repo, repos.MAIN, merged, buildA), true);
  });

  test("two builds that change the same lines conflict instead of guessing", async () => {
    const t1 = randomUUID();
    const t2 = randomUUID();
    const base = await repos.bundleOf(repo, merged);
    const b1 = await repos.receiveBuildBundle(repo, buildInSandbox(base, merged, t1, { "index.html": "<h1>One</h1>\n" }), `builds/${t1}`, merged);
    const b2 = await repos.receiveBuildBundle(repo, buildInSandbox(base, merged, t2, { "index.html": "<h1>Two</h1>\n" }), `builds/${t2}`, merged);
    assert.equal(await repos.advanceBranch(repo, repos.MAIN, b1, merged), true);
    const candidate = await repos.mergeCandidate(repo, b1, b2, "conflict");
    assert.equal(candidate.kind, "conflict");
    assert.deepEqual((candidate as { files: string[] }).files, ["index.html"]);
    assert.equal(await repos.advanceBranch(repo, repos.MAIN, merged, b1), true, "put main back for the next tests");
  });

  test("undo is a new commit that reverses one version, for plain and merged builds", async () => {
    const undoMerge = await repos.revertCandidate(repo, merged, merged, "Undo about page");
    assert.equal(undoMerge.kind, "merge");
    const u1 = (undoMerge as { commit: string }).commit;
    assert.throws(() => show(repo, u1, "about.html"));
    assert.equal(show(repo, u1, "index.html"), "<h1>Book</h1>");
    const undoA = await repos.revertCandidate(repo, merged, buildA, "Undo booking page");
    const u2 = (undoA as { commit: string }).commit;
    assert.throws(() => show(repo, u2, "index.html"));
    assert.equal(show(repo, u2, "about.html"), "<p>About</p>");
    await assert.rejects(repos.revertCandidate(repo, merged, first, "x"), /first version/);
  });

  test("versions list main's history newest first, with the build each came from", async () => {
    const versions = await repos.versionsOf(repo);
    assert.deepEqual(versions.map((v) => v.number), [3, 2, 1]);
    assert.equal(versions[0]!.commit, merged);
    assert.equal(versions[0]!.buildId, taskC);
    assert.equal(versions[1]!.buildId, taskA);
    assert.equal(versions[2]!.buildId, null);
  });

  test("any version downloads as a zip", async () => {
    const zip = await repos.archiveOf(repo, merged);
    assert.equal(zip.subarray(0, 2).toString("latin1"), "PK");
    assert.ok(zip.includes(Buffer.from("about.html")));
  });

  test("line endings are stored exactly as written", async () => {
    const t = randomUUID();
    const crlf = "line one\r\nline two\r\n";
    const b = await repos.receiveBuildBundle(repo, buildInSandbox(await repos.bundleOf(repo, merged), merged, t, { "win.txt": crlf }), `builds/${t}`, merged);
    const raw = execFileSync("git", ["cat-file", "blob", `${b}:win.txt`], { cwd: repo });
    assert.equal(raw.toString("latin1"), crlf);
  });
});

describe("importing an existing repository", () => {
  test("its default branch becomes main; only https unless local is allowed", async () => {
    const { path: src, head } = sourceRepo(scratch, { "app.js": "console.log(1)\n" });

    const repo = repos.repoPath(randomUUID(), randomUUID());
    await assert.rejects(repos.importRepo(repo, src), /only https/);
    assert.equal(await repos.importRepo(repo, src, { allowLocal: true }), head);
    assert.equal(await repos.headOf(repo), head);
    await assert.rejects(repos.importRepo(repos.repoPath(randomUUID(), randomUUID()), "--upload-pack=evil", { allowLocal: true }));
  });
});

describe("repository lock", () => {
  test("work on one project's repository never overlaps", async () => {
    const project = randomUUID();
    let active = 0;
    let peak = 0;
    const work = () =>
      repos.withRepoLock(project, async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 60));
        active--;
      });
    await Promise.all([work(), work(), work(), work()]);
    assert.equal(peak, 1);
  });

  test("different projects do not wait for each other", async () => {
    const order: string[] = [];
    const slow = repos.withRepoLock(randomUUID(), async () => {
      await new Promise((r) => setTimeout(r, 150));
      order.push("slow");
    });
    await new Promise((r) => setTimeout(r, 20));
    await repos.withRepoLock(randomUUID(), async () => {
      order.push("other");
    });
    await slow;
    assert.deepEqual(order, ["other", "slow"]);
  });
});
