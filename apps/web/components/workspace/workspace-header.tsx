import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import type { Project } from "@/lib/types";

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
