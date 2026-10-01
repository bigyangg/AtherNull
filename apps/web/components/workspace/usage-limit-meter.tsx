"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  useCreateUsagePolicy,
  useExtendUsagePolicy,
  useResumeUsageLimit,
} from "@/lib/hooks/use-tasks";
import type { TaskStatus, TaskUsageLimit } from "@/lib/types";

// Phase 4D.2A — Operational Usage Limits + Pause/Resume.
//
// This is a SOFT, POST-RESPONSE operational token limit — never a hard
// limit, spend limit, monetary budget enforcement, dollar ceiling, or funded
// balance. Deliberately a separate component from budget-meter.tsx (which
// renders the real, monetary budgetSpentMinor/maxBudgetMinor fields): this
// component must NEVER render `$`, "Add Funds", "Spent", "Paid", "Deposit",
// or "Escrow" anywhere. See docs/adr/0012-operational-usage-limits.md.

function formatTokens(n: number): string {
  return n.toLocaleString("en-US");
}

export function UsageLimitMeter({
  projectId,
  taskId,
  taskStatus,
  usageLimit,
}: {
  projectId: string;
  taskId: string;
  taskStatus: TaskStatus;
  usageLimit: TaskUsageLimit | null;
}) {
  const createPolicy = useCreateUsagePolicy(projectId, taskId);
  const extendPolicy = useExtendUsagePolicy(projectId, taskId);
  const resume = useResumeUsageLimit(projectId, taskId);
  const [draftLimit, setDraftLimit] = useState("");
  const [error, setError] = useState<string | null>(null);

  const isPaused = taskStatus === "PAUSED_USAGE_LIMIT";
  const isBusy = createPolicy.isPending || extendPolicy.isPending || resume.isPending;

  async function handleSetOrIncreaseLimit() {
    setError(null);
    const parsed = Number(draftLimit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      setError("Enter a whole number of tokens greater than 0.");
      return;
    }
    try {
      if (usageLimit) {
        await extendPolicy.mutateAsync({ limitQuantity: parsed, expectedVersion: usageLimit.policy.version });
      } else {
        await createPolicy.mutateAsync(parsed);
      }
      setDraftLimit("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  async function handleResume() {
    setError(null);
    try {
      await resume.mutateAsync();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  // No ACTIVE usage limit exists for this task (correction 19: a fully
  // legitimate, unaffected state — offered here, never forced).
  if (!usageLimit) {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">Usage limit</span>
          <span className="text-muted-foreground">Not set</span>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            step={1}
            placeholder="Tokens (e.g. 2,000,000)"
            value={draftLimit}
            onChange={(e) => setDraftLimit(e.target.value)}
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
          />
          <Button size="sm" variant="outline" disabled={isBusy || taskStatus === "RUNNING"} onClick={handleSetOrIncreaseLimit}>
            Set Limit
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Set an initial limit before the build starts.</p>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    );
  }

  const { policy, cumulativeUsage, openPause } = usageLimit;
  const remaining = policy.limitQuantity - cumulativeUsage;
  const pct = policy.limitQuantity > 0 ? Math.min(100, (cumulativeUsage / policy.limitQuantity) * 100) : 0;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Soft token limit: the build pauses at the next safe step boundary after a response.
        An in-flight step may exceed the limit.
      </p>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-muted-foreground">Usage limit</span>
          <span className="text-foreground">
            {formatTokens(cumulativeUsage)} / {formatTokens(policy.limitQuantity)} tokens
          </span>
        </div>
        <Progress value={pct} indicatorClassName={remaining < 0 ? "bg-destructive" : undefined} />
        <div className="text-xs text-muted-foreground">
          {remaining >= 0
            ? `${formatTokens(remaining)} tokens remaining`
            : // Correction 20: the real observed usage is always shown, even
              // when it genuinely exceeds the configured limit — never
              // claim the system enforced exactly the configured number.
              `${formatTokens(Math.abs(remaining))} tokens over the configured limit`}
        </div>
      </div>

      {isPaused && openPause && (
        <div className="flex flex-col gap-2 rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="text-sm text-foreground">
            Status: Paused: usage limit reached — observed usage{" "}
            {formatTokens(openPause.observedUsage)} tokens against a configured limit of{" "}
            {formatTokens(openPause.configuredLimit)} tokens.
          </p>
          {openPause.resumeMode === "NEW_ATTEMPT" && (
            <p className="text-xs text-muted-foreground">Resuming starts a new attempt. Previous usage still counts.</p>
          )}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={policy.limitQuantity + 1}
              step={1}
              placeholder={`New limit (greater than ${formatTokens(policy.limitQuantity)})`}
              value={draftLimit}
              onChange={(e) => setDraftLimit(e.target.value)}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            />
            <Button size="sm" variant="outline" disabled={isBusy} onClick={handleSetOrIncreaseLimit}>
              Increase Limit
            </Button>
          </div>
          <Button size="sm" disabled={isBusy || policy.limitQuantity <= Math.max(cumulativeUsage, openPause.observedUsage)} onClick={handleResume}>
            {resume.isPending ? "Resuming…" : "Resume Build"}
          </Button>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
