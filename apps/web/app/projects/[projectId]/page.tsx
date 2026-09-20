"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  if (projectLoading) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Loading…</p>
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
      <div className="mb-8">
        <h1 className="text-xl font-semibold">{project.permittedRepository}</h1>
        <p className="text-sm text-muted-foreground">
          {project.revision ? `Pinned at ${project.revision}` : "Tracks default branch"}
          {project.scope ? ` · ${project.scope}` : ""}
        </p>
      </div>

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
        <p className="text-sm text-muted-foreground">Loading tasks…</p>
      ) : !tasks || tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks yet on this project.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tasks.map((task) => (
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
