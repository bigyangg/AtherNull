import Link from "next/link";
import { FolderGit2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { IconBadge } from "@/components/icon-badge";
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

export function ProjectCard({
  project,
  needsReviewCount = 0,
}: {
  project: RepoProject;
  needsReviewCount?: number;
}) {
  return (
    <Link href={`/projects/${project.id}`}>
      <Card className="transition-colors hover:border-primary/50">
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <IconBadge>
            <FolderGit2 />
          </IconBadge>
          <div className="min-w-0">
            <CardTitle className="text-base">{project.permittedRepository}</CardTitle>
            <p className="line-clamp-1 text-sm text-muted-foreground">
              {project.revision ? `Pinned at ${project.revision}` : "Tracks default branch"}
              {project.scope ? ` · ${project.scope}` : ""}
            </p>
          </div>
        </CardHeader>
        <CardContent className="flex items-center justify-end gap-2">
          {needsReviewCount > 0 && (
            <Badge variant="warning">
              {needsReviewCount} need{needsReviewCount === 1 ? "s" : ""} review
            </Badge>
          )}
          <span className="shrink-0 text-xs text-muted-foreground">
            Added {relativeTime(project.createdAt)}
          </span>
        </CardContent>
      </Card>
    </Link>
  );
}

export function ProjectCardSkeleton() {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <Skeleton className="size-11 rounded-xl" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-3 w-56" />
        </div>
      </CardHeader>
      <CardContent className="flex justify-end">
        <Skeleton className="h-3 w-16" />
      </CardContent>
    </Card>
  );
}
