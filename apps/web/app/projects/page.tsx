"use client";

import Link from "next/link";
import { FolderPlus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { IconBadge } from "@/components/icon-badge";
import { ProjectCard } from "@/components/projects/project-card";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";

export default function ProjectsPage() {
  const { data: projects, isLoading } = useRepoProjects();

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Repositories AtherNull is authorized to work on.
          </p>
        </div>
        <Button asChild>
          <Link href="/projects/new">
            <Plus /> New project
          </Link>
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : !projects || projects.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border p-10 text-center">
          <IconBadge>
            <FolderPlus />
          </IconBadge>
          <p className="text-sm text-muted-foreground">
            No projects yet. Import a repository to get started.
          </p>
          <Button asChild className="mt-1">
            <Link href="/projects/new">
              <Plus /> New project
            </Link>
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </main>
  );
}
