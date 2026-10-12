import { sql } from "kysely";

import { db } from "../db.js";

/**
 * ADR-0019 — one writer per project repository at a time, across every API
 * process: a Postgres session advisory lock held on one connection for the
 * duration of `fn`. Moving `main` is also a compare-and-swap
 * (advanceBranch), so the lock serializes work; it is not the only guard.
 */
export async function withRepoLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  return db.connection().execute(async (conn) => {
    const key = `athernull-repo:${projectId.toLowerCase()}`;
    await sql`select pg_advisory_lock(hashtextextended(${key}, 0))`.execute(conn);
    try {
      return await fn();
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${key}, 0))`.execute(conn);
    }
  });
}
