"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, FolderGit2, Loader2, MessagesSquare } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDiscussions, usePlanFromDiscussion } from "@/lib/hooks/use-discussions";
import { useCreateRepoProject, useRepoProjects } from "@/lib/hooks/use-repo-projects";
import type { Discussion } from "@/lib/types";

const NEW_REPO = "__new__";

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function TurnIntoBuild({ discussion, onCancel }: { discussion: Discussion; onCancel: () => void }) {
  const router = useRouter();
  const { data: projects } = useRepoProjects();
  const createProject = useCreateRepoProject();
  const plan = usePlanFromDiscussion();
  const [choice, setChoice] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const selected = choice || projects?.[0]?.id || NEW_REPO;
  const busy = createProject.isPending || plan.isPending;

  async function submit() {
    setError(null);
    try {
      const projectId =
        selected === NEW_REPO ? (await createProject.mutateAsync({ permittedRepository: newRepo.trim() })).id : selected;
      const estimate = await plan.mutateAsync({ projectId, discussionId: discussion.id });
      router.push(`/projects/${projectId}?lineage=${estimate.lineageId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Planning failed.");
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border bg-background/40 p-3">
      <p className="text-xs text-muted-foreground">Which repository should the agent build this in?</p>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2 text-sm">
          <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
          <select
            aria-label="Repository"
            value={selected}
            disabled={busy}
            onChange={(e) => setChoice(e.target.value)}
            className="min-w-0 max-w-56 truncate bg-transparent py-1.5 outline-none"
          >
            {projects?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.permittedRepository}
              </option>
            ))}
            <option value={NEW_REPO}>+ Another repository…</option>
          </select>
        </div>
        {selected === NEW_REPO && (
          <Input
            value={newRepo}
            onChange={(e) => setNewRepo(e.target.value)}
            placeholder="github.com/owner/repo"
            aria-label="Repository to import"
            className="h-8 w-56 font-mono text-xs"
          />
        )}
        <Button size="sm" disabled={busy || (selected === NEW_REPO && !newRepo.trim())} onClick={() => void submit()}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          {plan.isPending ? "Drafting the plan…" : "Plan it"}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// ADR-0016 — the bridge from talking to building. Discussions happen in the
// canvas with a tool-less agent; here one becomes a plan to approve, fund
// and build.
export function DiscussionsPanel() {
  const { data: discussions, isLoading } = useDiscussions();
  const [openId, setOpenId] = useState<string | null>(null);

  if (isLoading) return null;

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-panel p-4">
      <div className="flex items-center gap-2">
        <MessagesSquare className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Your discussions</h2>
      </div>
      {!discussions || discussions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Start by{" "}
          <a href="/canvas" target="_top" className="text-foreground underline underline-offset-4">
            talking to the agent in the canvas
          </a>
          . Agree on what to build, then turn the discussion into a build here. Nothing is charged until you fund it.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {discussions.map((d) => (
            <li key={d.id} className="py-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{d.title ?? "Untitled discussion"}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.messageCount} message{d.messageCount === 1 ? "" : "s"} · {ago(d.lastMessageAt)}
                  </p>
                </div>
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/canvas/conversations/${d.id}`} target="_top">
                    Open
                  </a>
                </Button>
                {openId !== d.id && (
                  <Button size="sm" onClick={() => setOpenId(d.id)}>
                    Turn into a build
                  </Button>
                )}
              </div>
              {openId === d.id && <TurnIntoBuild discussion={d} onCancel={() => setOpenId(null)} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
