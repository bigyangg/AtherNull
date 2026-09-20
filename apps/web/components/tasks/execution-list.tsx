import { Badge } from "@/components/ui/badge";
import type { Execution } from "@/lib/types";

const STATUS_VARIANT: Record<string, "default" | "success" | "warning" | "destructive" | "muted"> = {
  PENDING: "muted",
  RUNNING: "default",
  SUCCEEDED: "success",
  FAILED: "destructive",
  LEASE_EXPIRED: "warning",
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

export function ExecutionList({ executions }: { executions: Execution[] }) {
  if (executions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No execution attempts yet — this task hasn't been picked up by a worker.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {executions.map((execution, index) => (
        <li
          key={execution.id}
          className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
        >
          <div className="flex items-center justify-between">
            <span className="font-medium">Attempt {executions.length - index}</span>
            <Badge variant={STATUS_VARIANT[execution.status] ?? "muted"}>
              {execution.status}
            </Badge>
          </div>
          {execution.resolvedModel && (
            <p className="text-xs text-muted-foreground">
              {execution.resolvedModel}
              {execution.routingTier ? ` · ${execution.routingTier} tier` : ""}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Started {formatTimestamp(execution.startedAt)} · Ended{" "}
            {formatTimestamp(execution.endedAt)}
          </p>
        </li>
      ))}
    </ul>
  );
}
