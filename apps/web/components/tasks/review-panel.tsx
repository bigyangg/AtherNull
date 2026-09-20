"use client";

import { useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useAcceptTask, useRejectTask, useVerifyTask } from "@/lib/hooks/use-tasks";
import type { TaskDetail } from "@/lib/types";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}

// Verification and acceptance stay two separate steps here, mirroring
// apps/api's FSM exactly (VERIFYING -> AWAITING_ACCEPTANCE via verify(PASS),
// then a distinct accept/reject decision) — see apps/api/src/routes/jobs.ts.
// A verify(FAIL) task lands in FAILED with no action here on purpose: the
// FAILED -> refund backend path is deliberately deferred (.memory/TODO.md).
export function ReviewPanel({ task }: { task: TaskDetail }) {
  const verifyTask = useVerifyTask(task.id);
  const acceptTask = useAcceptTask(task.id);
  const rejectTask = useRejectTask(task.id);
  const [rejectReason, setRejectReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleVerify(outcome: "PASS" | "FAIL") {
    setError(null);
    try {
      await verifyTask.mutateAsync(outcome);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleAccept() {
    setError(null);
    try {
      await acceptTask.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleReject() {
    setError(null);
    try {
      await rejectTask.mutateAsync(rejectReason.trim() || undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const isBusy = verifyTask.isPending || acceptTask.isPending || rejectTask.isPending;
  const hasHistory = task.verificationRuns.length > 0;

  if (!hasHistory && task.status !== "VERIFYING" && task.status !== "AWAITING_ACCEPTANCE") {
    return null;
  }

  return (
    <div className="mb-6 flex flex-col gap-4 rounded-xl border border-border p-4">
      {hasHistory && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">Verification history</p>
          <ul className="flex flex-col gap-2">
            {task.verificationRuns.map((run) => (
              <li key={run.id} className="flex items-center justify-between gap-3 text-sm">
                <Badge variant={run.outcome === "PASS" ? "success" : "destructive"}>
                  {run.outcome}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  {formatTimestamp(run.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {task.status === "VERIFYING" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">Record verification result</p>
          <div className="flex gap-2">
            <Button disabled={isBusy} onClick={() => handleVerify("PASS")}>
              {verifyTask.isPending ? "Recording…" : "Mark as passed"}
            </Button>
            <Button
              variant="outline"
              disabled={isBusy}
              onClick={() => handleVerify("FAIL")}
            >
              Mark as failed
            </Button>
          </div>
        </div>
      )}

      {task.status === "AWAITING_ACCEPTANCE" && (
        <div className="flex flex-col gap-3">
          <p className="text-sm font-medium text-muted-foreground">Accept or reject the result</p>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="review-reject-reason">
              Reason (optional, only used if you reject)
            </label>
            <Textarea
              id="review-reject-reason"
              rows={2}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <Button disabled={isBusy} onClick={handleAccept}>
              {acceptTask.isPending ? "Settling…" : "Accept & settle"}
            </Button>
            <Button variant="outline" disabled={isBusy} onClick={handleReject}>
              {rejectTask.isPending ? "Refunding…" : "Reject & refund"}
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
