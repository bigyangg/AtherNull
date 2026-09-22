"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { FolderGit2, ListChecks, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { AddTaskForm } from "@/components/projects/add-task-form";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";
import { useTasks } from "@/lib/hooks/use-tasks";
import { formatMinor } from "@/lib/types";

export default function ProjectDetailPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading: projectLoading } = useRepoProjects();
  const { data: tasks, isLoading: tasksLoading } = useTasks(projectId);
  const [addingTask, setAddingTask] = useState(false);

  const project = projects?.find((p) => p.id === projectId);

  const sortedTasks = useMemo(() => {
    if (!tasks) return tasks;
    return [...tasks].sort(
      (a, b) =>
        Number(b.status === "AWAITING_ACCEPTANCE") -
        Number(a.status === "AWAITING_ACCEPTANCE"),
    );
  }, [tasks]);
  const needsReviewCount =
    sortedTasks?.filter((t) => t.status === "AWAITING_ACCEPTANCE").length ?? 0;

  if (projectLoading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <div className="mb-8 flex items-center gap-3">
          <Skeleton className="size-11 rounded-xl" />
          <div className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-32" />
          </div>
        </div>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      </main>
    );
  }

  if (!project) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-foreground">Project not found.</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        backHref="/projects"
        icon={<FolderGit2 />}
        title={project.permittedRepository}
        subtitle={
          <>
            {project.revision ? `Pinned at ${project.revision}` : "Tracks default branch"}
            {project.scope ? ` · ${project.scope}` : ""}
          </>
        }
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">Tasks</h2>
        <Button size="sm" variant="outline" onClick={() => setAddingTask((v) => !v)}>
          <Plus /> New task
        </Button>
      </div>

      {addingTask && (
        <div className="mb-4">
          <AddTaskForm
            projectId={project.id}
            defaultRevision={project.revision ?? ""}
          />
        </div>
      )}

      {tasksLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Card key={i}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-5 w-20 rounded-full" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-3 w-24" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !sortedTasks || sortedTasks.length === 0 ? (
        <EmptyState
          icon={<ListChecks />}
          title="No tasks yet"
          description="Add a task to get this project started."
          action={
            <Button className="mt-1" onClick={() => setAddingTask(true)}>
              <Plus /> New task
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {needsReviewCount > 0 && (
            <p className="text-xs font-medium text-warning">Needs your review</p>
          )}
          {sortedTasks.map((task) => (
            <Link key={task.id} href={`/projects/${project.id}/tasks/${task.id}`}>
              <Card className="transition-colors hover:border-primary/50">
                <CardHeader className="flex-row items-start justify-between space-y-0">
                  <CardTitle className="text-base line-clamp-1">{task.requirements}</CardTitle>
                  <StatusBadge status={task.status} />
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  Budget {formatMinor(task.maxBudgetMinor, task.currency)}
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
