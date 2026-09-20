"use client";

import { useParams } from "next/navigation";

import { Separator } from "@/components/ui/separator";
import { StatusBadge } from "@/components/status-badge";
import { BudgetMeter } from "@/components/workspace/budget-meter";
import { ExecutionList } from "@/components/tasks/execution-list";
import { ReviewPanel } from "@/components/tasks/review-panel";
import { useTask } from "@/lib/hooks/use-task";

export default function TaskStatusPage() {
  const { taskId } = useParams<{ projectId: string; taskId: string }>();
  const { data: task, isLoading, isError } = useTask(taskId);

  if (isLoading) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </main>
    );
  }

  if (isError || !task) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="text-sm text-foreground">Task not found.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">{task.requirements}</h1>
          <p className="text-xs text-muted-foreground">
            Revision {task.repositoryRevision}
          </p>
        </div>
        <StatusBadge status={task.status} />
      </div>

      {task.acceptanceCriteria.length > 0 && (
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium text-muted-foreground">
            Acceptance criteria
          </p>
          <ul className="flex flex-col gap-1.5">
            {task.acceptanceCriteria.map((criterion) => (
              <li key={criterion} className="text-sm text-foreground">
                • {criterion}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mb-6">
        <BudgetMeter
          spentMinor={task.budgetSpentMinor}
          maxMinor={task.maxBudgetMinor}
          currency={task.currency}
        />
      </div>

      <ReviewPanel task={task} />

      <Separator className="mb-6" />

      <p className="mb-3 text-sm font-medium text-muted-foreground">
        Execution attempts
      </p>
      <ExecutionList executions={task.executions} />
    </main>
  );
}
