"use client";

import { useState } from "react";
import { ArrowRight, FolderGit2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dashboardApi } from "@/lib/api";
import { useCreateRepoProject, useRepoProjects } from "@/lib/hooks/use-repo-projects";
import type { Discussion } from "@/lib/types";
import { repoLabel } from "@/lib/utils";

const NEW_REPO = "__new__";

// One small popup to start a build: from a canvas discussion, or from a
// description. It drafts the plan and hands back where to open it.
export function StartBuildDialog({
  open,
  onOpenChange,
  discussion,
  onPlanned,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  discussion: Discussion | null; // null = describe it here
  onPlanned: (projectId: string, lineageId: string) => void;
}) {
  const { data: projects } = useRepoProjects();
  const createProject = useCreateRepoProject();
  const [choice, setChoice] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = choice || projects?.[0]?.id || NEW_REPO;
  const ready = (selected !== NEW_REPO || newRepo.trim()) && (discussion || prompt.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const projectId =
        selected === NEW_REPO ? (await createProject.mutateAsync({ permittedRepository: newRepo.trim() })).id : selected;
      const estimate = discussion
        ? await dashboardApi.generateEstimateFromDiscussion(projectId, discussion.id)
        : await dashboardApi.generateEstimate(projectId, prompt.trim());
      setPrompt("");
      onPlanned(projectId, estimate.lineageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Planning failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogTitle>{discussion ? "Turn into a build" : "New build"}</DialogTitle>
        <DialogDescription>
          {discussion
            ? `The agent drafts a plan from “${discussion.title ?? "your discussion"}”. You approve it, set a budget and fund it before anything is built.`
            : "Describe the change. The agent drafts a plan; nothing is built until you approve and fund it."}
        </DialogDescription>

        <div className="mt-4 flex flex-col gap-3">
          {!discussion && (
            <Textarea
              rows={3}
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Add GET /version that returns the package.json version, with a test"
              disabled={busy}
            />
          )}
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">Repository</span>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5">
              <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              <select
                value={selected}
                disabled={busy}
                onChange={(e) => setChoice(e.target.value)}
                className="min-w-0 flex-1 truncate bg-transparent py-2 outline-none"
              >
                {projects?.map((p) => (
                  <option key={p.id} value={p.id} title={p.permittedRepository}>
                    {repoLabel(p.permittedRepository)}
                  </option>
                ))}
                <option value={NEW_REPO}>+ Another repository…</option>
              </select>
            </div>
          </label>
          {selected === NEW_REPO && (
            <Input
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="font-mono text-xs"
              disabled={busy}
            />
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="mt-1 flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!ready || busy} onClick={() => void submit()}>
              {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              {busy ? "Drafting the plan…" : "Draft plan"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
