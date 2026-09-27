"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, ExternalLink, ListChecks, Rocket, Wallet, Workflow } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/page-header";
import { IconBadge } from "@/components/icon-badge";
import { StatusBadge } from "@/components/status-badge";
import { BudgetMeter } from "@/components/workspace/budget-meter";
import { ExecutionList } from "@/components/tasks/execution-list";
import { ReviewPanel } from "@/components/tasks/review-panel";
import { TaskDetailSkeleton } from "@/components/tasks/task-detail-skeleton";
import { useTask } from "@/lib/hooks/use-task";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";
import { useFundTask } from "@/lib/hooks/use-tasks";
import { githubRevisionUrl } from "@/lib/utils";

// Phase 4C — "Activate Build": the only UI entry point left for moving a
// task from AWAITING_FUNDING to QUEUED (apps/api's still-real /fund
// endpoint underneath). Deliberately never labeled "Fund"/"Pay"/"Deposit"/
// "Escrow" — no real payment rail exists anywhere in this codebase yet (see
// docs/adr/0010-provenance-bound-task-creation.md).
function ActivateBuildPanel({ taskId }: { taskId: string }) {
  const fundTask = useFundTask();
  const [error, setError] = useState<string | null>(null);

  async function handleActivate() {
    setError(null);
    try {
      await fundTask.mutateAsync(taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <IconBadge>
          <Rocket />
        </IconBadge>
        <CardTitle className="text-base">Awaiting funding</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          This build is prepared but not yet active. Activating it queues the build for
          execution.
        </p>
        <div className="flex items-center justify-between">
          {error ? <p className="text-sm text-destructive">{error}</p> : <span />}
          <Button disabled={fundTask.isPending} onClick={handleActivate}>
            {fundTask.isPending ? "Activating…" : "Activate Build"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TaskStatusPage() {
  const { projectId, taskId } = useParams<{ projectId: string; taskId: string }>();
  const { data: task, isLoading, isError } = useTask(taskId);
  const { data: repoProjects } = useRepoProjects();

  if (isLoading) {
    return <TaskDetailSkeleton />;
  }

  if (isError || !task) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-foreground">Task not found.</p>
      </main>
    );
  }

  const repoProject = repoProjects?.find((p) => p.id === projectId);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        backHref={`/projects/${projectId}`}
        title={task.requirements}
        subtitle={`Revision ${task.repositoryRevision}`}
        trailing={
          <>
            {repoProject && (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={githubRevisionUrl(repoProject.permittedRepository, task.repositoryRevision)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink /> Source revision
                </a>
              </Button>
            )}
            <StatusBadge status={task.status} />
          </>
        }
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <ListChecks />
            </IconBadge>
            <CardTitle className="text-base">Acceptance criteria</CardTitle>
          </CardHeader>
          <CardContent>
            {task.acceptanceCriteria.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {task.acceptanceCriteria.map((criterion) => (
                  <li
                    key={criterion}
                    className="flex items-start gap-2 text-sm text-foreground"
                  >
                    <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    {criterion}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No acceptance criteria were specified for this task.
              </p>
            )}
          </CardContent>
        </Card>

        <Card className="sticky top-4">
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <Wallet />
            </IconBadge>
            <CardTitle className="text-base">Budget</CardTitle>
          </CardHeader>
          <CardContent>
            <BudgetMeter
              spentMinor={task.budgetSpentMinor}
              maxMinor={task.maxBudgetMinor}
              currency={task.currency}
            />
          </CardContent>
        </Card>

        {task.status === "AWAITING_FUNDING" && <ActivateBuildPanel taskId={task.id} />}

        <ReviewPanel task={task} />

        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <Workflow />
            </IconBadge>
            <CardTitle className="text-base">Execution attempts</CardTitle>
          </CardHeader>
          <CardContent>
            <ExecutionList executions={task.executions} projectId={projectId} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
