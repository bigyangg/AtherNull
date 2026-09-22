import type { ReactNode } from "react";
import Link from "next/link";
import { CheckCircle2, CircleDashed, ExternalLink, Loader2, XCircle } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { TimelineRow } from "@/components/timeline-row";
import type { Execution } from "@/lib/types";

const STATUS_VARIANT: Record<string, "default" | "success" | "warning" | "destructive" | "muted"> = {
  PENDING: "muted",
  RUNNING: "default",
  SUCCEEDED: "success",
  FAILED: "destructive",
  LEASE_EXPIRED: "warning",
};

const STATUS_ICON: Record<string, ReactNode> = {
  PENDING: <CircleDashed className="size-4 text-muted-foreground" />,
  RUNNING: <Loader2 className="size-4 animate-spin text-info" />,
  SUCCEEDED: <CheckCircle2 className="size-4 text-success" />,
  FAILED: <XCircle className="size-4 text-destructive" />,
  LEASE_EXPIRED: <XCircle className="size-4 text-warning" />,
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function ExecutionList({ executions, projectId }: { executions: Execution[]; projectId: string }) {
  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-8 text-center">
        <p className="text-sm text-muted-foreground">
          No execution attempts yet — this task hasn't been picked up by a
          worker.
        </p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col divide-y divide-border">
      {executions.map((execution, index) => (
        <TimelineRow
          key={execution.id}
          icon={STATUS_ICON[execution.status] ?? (
            <CircleDashed className="size-4 text-muted-foreground" />
          )}
          title={`Attempt ${executions.length - index}`}
          right={
            <Badge variant={STATUS_VARIANT[execution.status] ?? "muted"}>
              {execution.status}
            </Badge>
          }
        >
          {execution.resolvedModel && (
            <span>
              {execution.resolvedModel}
              {execution.routingTier ? ` · ${execution.routingTier} tier` : ""}
            </span>
          )}
          <span>
            Started {formatTimestamp(execution.startedAt)} · Ended{" "}
            {formatTimestamp(execution.endedAt)}
          </span>
          {execution.conversationId && (
            <Link
              href={`/projects/${projectId}/workspace?taskId=${execution.taskId}&executionId=${execution.id}`}
              className="flex w-fit items-center gap-1 text-info hover:underline"
            >
              <ExternalLink className="size-3" /> View live workspace
            </Link>
          )}
        </TimelineRow>
      ))}
    </ul>
  );
}
