"use client";

import Link from "next/link";
import { Check, ChevronDown, ExternalLink, FolderGit2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { CANVAS_STEPS, stageStepIndex, type CanvasStage } from "@/lib/canvas";
import { cn } from "@/lib/utils";
import type { RepoProject, Task } from "@/lib/types";

export interface BuildOption {
  key: string; // "task:<id>" | "lineage:<id>"
  label: string;
  task: Task | null;
  createdAt: string;
}

// "github.com/acme/web" -> "acme/web"; a local path -> its last segment.
function repoLabel(repository: string): string {
  const parts = repository.split(/[\\/]/).filter(Boolean);
  if (parts[0]?.includes(".") && parts.length >= 3) return parts.slice(1).join("/");
  return parts.at(-1) ?? repository;
}

function Stepper({ stage }: { stage: CanvasStage }) {
  const current = stageStepIndex(stage);
  const failed = stage === "failed" || stage === "refunded";
  const done = stage === "settled";
  return (
    <ol className="hidden items-center gap-1 xl:flex">
      {CANVAS_STEPS.map((step, i) => {
        const complete = i < current || (done && i === current);
        const active = i === current && !done;
        return (
          <li key={step} className="flex items-center gap-1">
            <span
              className={cn(
                "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
                complete && "text-success",
                active && !failed && "bg-info/15 text-info",
                active && failed && "bg-destructive/15 text-destructive",
                !complete && !active && "text-muted-foreground/60",
              )}
            >
              {complete && <Check className="size-3" />}
              {step}
            </span>
            {i < CANVAS_STEPS.length - 1 && <span className="h-px w-3 bg-border" />}
          </li>
        );
      })}
    </ol>
  );
}

export function CanvasHeader({
  project,
  stage,
  task,
  builds,
  selectedKey,
  onSelect,
  onNew,
}: {
  project: RepoProject;
  stage: CanvasStage;
  task: Task | null;
  builds: BuildOption[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onNew: () => void;
}) {
  return (
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
      <Link
        href={`/projects/${project.id}/tasks`}
        title={project.permittedRepository}
        className="flex min-w-0 shrink-0 items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
      >
        <FolderGit2 className="size-4 shrink-0" />
        <span className="max-w-40 truncate font-medium text-foreground">{repoLabel(project.permittedRepository)}</span>
      </Link>
      <span className="text-muted-foreground/50">/</span>
      <div className="relative min-w-0 max-w-xs">
        <select
          aria-label="Build"
          value={selectedKey ?? "new"}
          onChange={(e) => (e.target.value === "new" ? onNew() : onSelect(e.target.value))}
          className="w-full min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent py-1 pl-1 pr-6 text-sm text-foreground outline-none hover:bg-accent"
        >
          {selectedKey === null && <option value="new">New build</option>}
          {builds.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
          {selectedKey !== null && <option value="new">+ New build</option>}
        </select>
        <ChevronDown className="pointer-events-none absolute right-1 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3">
        <Stepper stage={stage} />
        {task && <StatusBadge status={task.status} />}
        {task && (
          <Button variant="ghost" size="sm" asChild className="hidden sm:inline-flex">
            <Link href={`/projects/${project.id}/tasks/${task.id}`}>
              Details <ExternalLink />
            </Link>
          </Button>
        )}
        <Button variant="outline" size="sm" onClick={onNew}>
          <Plus /> <span className="hidden sm:inline">New build</span>
        </Button>
      </div>
    </header>
  );
}
