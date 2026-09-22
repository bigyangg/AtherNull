"use client";

import { useMemo } from "react";
import Link from "next/link";
import { FolderPlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { ProjectCard, ProjectCardSkeleton } from "@/components/projects/project-card";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";
import { useAllTasks } from "@/lib/hooks/use-tasks";

export default function ProjectsPage() {
  const { data: projects, isLoading } = useRepoProjects();
  const { data: tasks } = useAllTasks();

  const needsReviewByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks ?? []) {
      if (task.status !== "AWAITING_ACCEPTANCE") continue;
      counts.set(task.projectId, (counts.get(task.projectId) ?? 0) + 1);
    }
    return counts;
  }, [tasks]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        icon={<FolderPlus />}
        title="Projects"
        subtitle="Repositories AtherNull is authorized to work on."
        trailing={
          <Button asChild>
            <Link href="/projects/new/import">
              <Plus /> New project
            </Link>
          </Button>
        }
      />

      {isLoading ? (
        <div className="flex flex-col gap-3">
          {Array.from({ length: 3 }, (_, i) => (
            <ProjectCardSkeleton key={i} />
          ))}
        </div>
      ) : !projects || projects.length === 0 ? (
        <EmptyState
          icon={<FolderPlus />}
          title="No projects yet"
          description="Import a repository to get started."
          action={
            <Button asChild className="mt-1">
              <Link href="/projects/new/import">
                <Plus /> New project
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              needsReviewCount={needsReviewByProject.get(project.id) ?? 0}
            />
          ))}
        </div>
      )}
    </main>
  );
}
