"use client";

import { useMemo } from "react";
import Link from "next/link";
import {
  ClipboardCheck,
  FolderGit2,
  Gauge,
  Loader2,
  Plug,
  Plus,
  Radio,
  Wrench,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { IconBadge } from "@/components/icon-badge";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { EmptyState } from "@/components/empty-state";
import { useCurrentOrg } from "@/lib/auth/current-org-provider";
import { useLiveTasks } from "@/lib/hooks/use-tasks";
import { useRepoProjects } from "@/lib/hooks/use-repo-projects";
import { useUsageSummary } from "@/lib/hooks/use-usage";
import { formatMinor } from "@/lib/types";

const QUICK_LINKS = [
  { href: "/projects", icon: FolderGit2, title: "Projects", description: "Repositories you've imported." },
  { href: "/skill-sets", icon: Wrench, title: "Skill sets", description: "What your agents are allowed to do." },
  { href: "/integrations", icon: Plug, title: "Integrations", description: "Connect other tools." },
] as const;

export default function DashboardPage() {
  const { organizationName } = useCurrentOrg();
  const { data: tasks, isLoading: tasksLoading } = useLiveTasks();
  const { data: projects } = useRepoProjects();
  const { data: usage } = useUsageSummary();

  const projectNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const project of projects ?? []) {
      map.set(project.id, project.permittedRepository);
    }
    return map;
  }, [projects]);

  const needsReview = useMemo(
    () => (tasks ?? []).filter((task) => task.status === "AWAITING_ACCEPTANCE"),
    [tasks],
  );
  const liveActivity = useMemo(
    () => (tasks ?? []).filter((task) => task.status === "RUNNING" || task.status === "VERIFYING"),
    [tasks],
  );

  const maxDailySpend = Math.max(1, ...(usage?.dailySpend.map((d) => d.spentMinor) ?? [0]));

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <PageHeader
        title="Dashboard"
        subtitle={organizationName}
        trailing={
          <Button asChild>
            <Link href="/projects/new/import">
              <Plus /> New project
            </Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <ClipboardCheck />
            </IconBadge>
            <CardTitle className="text-base">Needs your review</CardTitle>
          </CardHeader>
          <CardContent>
            {tasksLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : needsReview.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing needs your review right now.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {needsReview.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/projects/${task.projectId}/tasks/${task.id}`}
                      className="flex items-center justify-between gap-3 py-3 text-sm"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                        {task.requirements}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        {projectNameById.get(task.projectId)}
                        <StatusBadge status={task.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center gap-3 space-y-0">
            <IconBadge>
              <Radio />
            </IconBadge>
            <CardTitle className="text-base">Live activity</CardTitle>
          </CardHeader>
          <CardContent>
            {tasksLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : liveActivity.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No agents running right now.
              </p>
            ) : (
              <ul className="flex flex-col divide-y divide-border">
                {liveActivity.map((task) => (
                  <li key={task.id}>
                    <Link
                      href={`/projects/${task.projectId}/tasks/${task.id}`}
                      className="flex items-center justify-between gap-3 py-3 text-sm"
                    >
                      <span className="flex min-w-0 flex-1 items-center gap-2 font-medium text-foreground">
                        <Loader2 className="size-4 shrink-0 animate-spin text-info" />
                        <span className="truncate">{task.requirements}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        {projectNameById.get(task.projectId)}
                        <StatusBadge status={task.status} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3">
              <IconBadge>
                <Gauge />
              </IconBadge>
              <CardTitle className="text-base">Usage</CardTitle>
            </div>
            <Link href="/usage" className="text-xs text-muted-foreground hover:text-foreground">
              View all →
            </Link>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-2xl font-semibold text-foreground">
              {usage ? formatMinor(usage.totalSpentMinor, usage.currency) : "—"}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                spent all-time
              </span>
            </p>
            {usage && usage.dailySpend.length > 0 && (
              <div className="flex h-10 items-end gap-1">
                {usage.dailySpend.map((day) => (
                  <div
                    key={day.date}
                    className="flex-1 rounded-sm bg-info/40"
                    style={{ height: `${Math.max(6, (day.spentMinor / maxDailySpend) * 100)}%` }}
                    title={`${new Date(day.date).toLocaleDateString()}: ${formatMinor(day.spentMinor, usage.currency)}`}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-3">
          {QUICK_LINKS.map(({ href, icon: Icon, title, description }) => (
            <Link key={href} href={href}>
              <Card className="h-full transition-colors hover:border-primary/50">
                <CardContent className="flex flex-col gap-2 pt-6">
                  <IconBadge>
                    <Icon />
                  </IconBadge>
                  <p className="text-sm font-medium text-foreground">{title}</p>
                  <p className="text-xs text-muted-foreground">{description}</p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>

        {!tasksLoading && (tasks?.length ?? 0) === 0 && (
          <EmptyState
            icon={<FolderGit2 />}
            title="Nothing here yet"
            description="Import a repository to give AtherNull its first task."
            action={
              <Button asChild className="mt-1">
                <Link href="/projects/new/import">
                  <Plus /> New project
                </Link>
              </Button>
            }
          />
        )}
      </div>
    </main>
  );
}
