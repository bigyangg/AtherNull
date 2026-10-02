import {
  PrepareFundingRequestSchema,
  VerifyFundingRequestSchema,
  type ProjectFundingView,
} from "@athernull/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { HttpError, requireOrgSession, requirePrivilegedRole, sendHttpError } from "../session.js";
import { FundingError, toHttpError } from "../solana/errors.js";
import {
  createFundingAccount,
  loadFundingByTask,
  prepareFunding,
  toFundingView,
  verifyFunding,
} from "../solana/funding-service.js";
import { getFundingRuntime } from "../solana/runtime.js";

// Phase 4E.1 — Solana devnet Project Funding (ADR-0013). Deliberately its own
// route file, like estimates/budget-authorizations/task-provenance: NOTHING
// here references executions, claim, dispatch, or a QUEUED transition (see
// apps/api/test/project-funding-no-execution-path.test.ts). Only
// POST /v1/jobs/:id/fund (the activation gate in routes/jobs.ts) can queue a
// task, and only after verified, finalized devnet funding.
//
// Tenant/provenance are derived server-side from the task row; the client
// supplies only the task id (URL) and, for prepare, its connected wallet.
// Mutations require an owner/admin like /fund; reads need org membership.
export async function projectFundingRoutes(app: FastifyInstance) {
  const handle = async (reply: Parameters<typeof sendHttpError>[0], err: unknown) => {
    const mapped = toHttpError(err);
    if (sendHttpError(reply, mapped)) return;
    if (err instanceof z.ZodError) {
      reply.status(400).send({ error: err.message });
      return;
    }
    throw err;
  };

  app.get("/v1/jobs/:id/funding", async (request, reply) => {
    try {
      const { organizationId } = await requireOrgSession(request);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const row = await loadFundingByTask(id, organizationId);
      if (!row) throw new HttpError(404, "No funding account for this task");
      const view: ProjectFundingView = await toFundingView(row);
      reply.send(view);
    } catch (err) {
      await handle(reply, err);
    }
  });

  // Create (or return the existing) Project Account for this exact task.
  // No chain access, no signing, zero executions.
  app.post("/v1/jobs/:id/funding", async (request, reply) => {
    try {
      const { organizationId, role, userId } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const rt = getFundingRuntime();
      const { row, created } = await createFundingAccount(rt, { taskId: id, organizationId, userId });
      reply.status(created ? 201 : 200).send(await toFundingView(row));
    } catch (err) {
      await handle(reply, err);
    }
  });

  // Binds the connected wallet (once, immutably), ensures the on-chain
  // account exists (authority-signed initialize), and returns an UNSIGNED
  // deposit transaction for the user's wallet to sign. No private keys are
  // ever collected.
  app.post("/v1/jobs/:id/funding/prepare", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = PrepareFundingRequestSchema.parse(request.body);
      const rt = getFundingRuntime();
      reply.send(
        await prepareFunding(rt, {
          taskId: id,
          organizationId,
          customerWallet: body.customerWallet,
          amountLamports: body.amountLamports,
        }),
      );
    } catch (err) {
      await handle(reply, err);
    }
  });

  // Independently verifies through the RPC provider. Credits only FINALIZED,
  // decoded deposit_project_funding instructions. Never trusts the browser's
  // "it succeeded". Safe to call repeatedly (idempotent per signature).
  app.post("/v1/jobs/:id/funding/verify", async (request, reply) => {
    try {
      const { organizationId, role } = await requireOrgSession(request);
      requirePrivilegedRole(role);
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = VerifyFundingRequestSchema.parse(request.body ?? {});
      const rt = getFundingRuntime();
      reply.send(await verifyFunding(rt, { taskId: id, organizationId, signature: body.signature }));
    } catch (err) {
      await handle(reply, err);
    }
  });
}

export { FundingError };
