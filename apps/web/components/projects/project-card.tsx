import Link from "next/link";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { RepoProject } from "@/lib/types";

function relativeTime(iso: string): string {
  const deltaMs = Date.now() - new Date(iso).getTime();
  const seconds = Math.max(0, Math.round(deltaMs / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ProjectCard({ project }: { project: RepoProject }) {
  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="flex-row items-start justify-between space-y-0">
          <CardTitle className="text-base">{project.permittedRepository}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <p className="line-clamp-1 text-sm text-muted-foreground">
            {project.revision ? `Pinned at ${project.revision}` : "Tracks default branch"}
            {project.scope ? ` · ${project.scope}` : ""}
          </p>
          <span className="shrink-0 pl-4 text-xs text-muted-foreground">
            Added {relativeTime(project.createdAt)}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}
