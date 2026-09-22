import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { Project, TaskStatus } from "@/lib/types";

export function WorkspaceHeader({ project }: { project: Project }) {
  return (
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-3">
        <Link
          href="/projects"
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
        </Link>
        <div>
          <p className="text-sm font-semibold leading-tight">
            {project.name}
          </p>
          <p className="text-xs text-muted-foreground">Proto-col Workspace</p>
        </div>
      </div>
      <StatusBadge status={project.status} />
    </div>
  );
}

// Real-data variant (Phase 2's live workspace) — a task, not a mock Project,
// and a backHref to the actual task detail page rather than the project
// list, since that's where this view is always linked from.
export function TaskWorkspaceHeader({
  backHref,
  title,
  status,
}: {
  backHref: string;
  title: string;
  status: TaskStatus;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <Link href={backHref} className="shrink-0 text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">{title}</p>
          <p className="text-xs text-muted-foreground">Live agent workspace</p>
        </div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}
