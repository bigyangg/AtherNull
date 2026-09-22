"use client";

import { useState } from "react";
import { CheckCircle2, ClipboardCheck, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { IconBadge } from "@/components/icon-badge";
import { TimelineRow } from "@/components/timeline-row";
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
  const isReviewable =
    hasHistory || task.status === "VERIFYING" || task.status === "AWAITING_ACCEPTANCE";

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <IconBadge>
          <ClipboardCheck />
        </IconBadge>
        <CardTitle className="text-base">Review</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!isReviewable && (
          <p className="text-sm text-muted-foreground">
            Nothing to review yet — this task hasn&apos;t reached verification.
          </p>
        )}

        {hasHistory && (
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-muted-foreground">Verification history</p>
            <ul className="flex flex-col divide-y divide-border">
              {task.verificationRuns.map((run) => (
                <TimelineRow
                  key={run.id}
                  icon={
                    run.outcome === "PASS" ? (
                      <CheckCircle2 className="size-4 text-success" />
                    ) : (
                      <XCircle className="size-4 text-destructive" />
                    )
                  }
                  title={
                    <Badge variant={run.outcome === "PASS" ? "success" : "destructive"}>
                      {run.outcome}
                    </Badge>
                  }
                  right={
                    <span className="text-xs text-muted-foreground">
                      {formatTimestamp(run.createdAt)}
                    </span>
                  }
                />
              ))}
            </ul>
          </div>
        )}

        {hasHistory &&
          (task.status === "VERIFYING" || task.status === "AWAITING_ACCEPTANCE") && (
            <Separator />
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
      </CardContent>
    </Card>
  );
}
