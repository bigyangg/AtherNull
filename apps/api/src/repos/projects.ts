import { existsSync } from "node:fs";

import { db } from "../db.js";
import { withRepoLock } from "./lock.js";
import { headOf, importRepo, repoPath } from "./repos.js";
import { gitText } from "./git.js";

// ADR-0019 — a project's hosted repository, imported from its
// permitted_repository the first time it is needed.

/** Local folders can be imported outside production (the demo repository). */
function allowLocalImports(): boolean {
  return process.env.REPOS_ALLOW_LOCAL === "1" || process.env.NODE_ENV !== "production";
}

export async function ensureProjectRepo(projectId: string): Promise<string> {
  const project = await db
    .selectFrom("projects")
    .select(["id", "organization_id", "permitted_repository", "repo_kind"])
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  const repo = repoPath(project.organization_id, project.id);
  if (project.repo_kind === "hosted") {
    if (!existsSync(repo)) throw new Error(`project ${project.id} is hosted but its repository is missing`);
    return repo;
  }
  return withRepoLock(project.id, async () => {
    if (!existsSync(repo)) await importRepo(repo, project.permitted_repository, { allowLocal: allowLocalImports() });
    await db.updateTable("projects").set({ repo_kind: "hosted" }).where("id", "=", project.id).execute();
    return repo;
  });
}

/**
 * The build's starting commit, pinned once on first dispatch and reused on
 * every retry. Null (with a warning) when the project's repository cannot be
 * hosted — e.g. a private repository before GitHub is linked — in which case
 * the worker falls back to cloning permitted_repository directly.
 */
export async function pinBaseCommit(
  task: { id: string; project_id: string; repository_revision: string },
  log: { warn: (obj: object, msg: string) => void },
): Promise<string | null> {
  const current = await db.selectFrom("tasks").select("base_commit").where("id", "=", task.id).executeTakeFirstOrThrow();
  if (current.base_commit) return current.base_commit;
  try {
    const repo = await ensureProjectRepo(task.project_id);
    const base = await resolveBaseCommit(repo, task.repository_revision);
    await db.updateTable("tasks").set({ base_commit: base }).where("id", "=", task.id).where("base_commit", "is", null).execute();
    const pinned = await db.selectFrom("tasks").select("base_commit").where("id", "=", task.id).executeTakeFirstOrThrow();
    return pinned.base_commit;
  } catch (err) {
    log.warn({ err, taskId: task.id }, "could not host the project's repository; dispatching without a base commit");
    return null;
  }
}

/**
 * The commit a build starts from: an explicit commit id if the task named
 * one that exists in the repository, otherwise the current `main` (an
 * imported repository's default branch is `main`).
 */
export async function resolveBaseCommit(repo: string, revision: string): Promise<string> {
  const trimmed = revision.trim();
  if (/^[0-9a-f]{7,40}$/i.test(trimmed)) {
    const full = await gitText(["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`], { cwd: repo }).catch(() => "");
    if (full) return full;
  }
  return headOf(repo);
}
