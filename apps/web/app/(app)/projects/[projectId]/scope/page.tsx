"use client";

import { useParams } from "next/navigation";
import { Target } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { ScopeEstimatePanel } from "@/components/projects/scope-estimate-panel";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";

// Phase 4A — Project Scope, Build Plan and Cost Estimate. A focused new
// view, not a dashboard redesign: describe what to build, generate a
// structured plan, review its cost estimate, revise or approve it. Nothing
// on this page creates a task or starts execution — see
// apps/api/src/routes/estimates.ts's header comment for the hard invariant
// this page's actions are backed by.
export default function ProjectScopePage() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: projects, isLoading } = useRepoProjects();
  const project = projects?.find((p) => p.id === projectId);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        backHref={`/projects/${projectId}`}
        icon={<Target />}
        title="Scope & estimate"
        subtitle={
          isLoading
            ? "Loading…"
            : project
              ? project.permittedRepository
              : "Describe what to build, then review its plan and cost."
        }
      />
      <ScopeEstimatePanel projectId={projectId} />
    </main>
  );
}
