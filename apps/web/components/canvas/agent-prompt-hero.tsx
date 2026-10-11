"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, FolderGit2, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCreateRepoProject, useRepoProjects } from "@/lib/hooks/use-repo-projects";

const NEW_REPO = "__new__";

// Agent-first entry point: say what to build, pick (or name) the repo, and
// land in that project's canvas with planning already under way.
export function AgentPromptHero() {
  const router = useRouter();
  const { data: projects, isLoading } = useRepoProjects();
  const createProject = useCreateRepoProject();
  // The Agent Canvas home composer hands its prompt over as ?prompt=.
  const searchParams = useSearchParams();
  const [prompt, setPrompt] = useState(() => searchParams.get("prompt") ?? "");
  const [choice, setChoice] = useState<string>("");
  const [newRepo, setNewRepo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const selected = choice || projects?.[0]?.id || NEW_REPO;
  const needsRepo = selected === NEW_REPO;
  const canSubmit =
    prompt.trim().length > 0 && (!needsRepo || newRepo.trim().length > 0) && !createProject.isPending;

  async function submit() {
    if (!canSubmit) return;
    setError(null);
    try {
      const projectId = needsRepo
        ? (await createProject.mutateAsync({ permittedRepository: newRepo.trim() })).id
        : selected;
      const params = new URLSearchParams({ new: "1", prompt: prompt.trim() });
      router.push(`/projects/${projectId}?${params.toString()}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <section className="flex flex-col gap-4 py-6">
      <h1 className="text-center text-2xl font-semibold tracking-tight sm:text-3xl">What should your agent build?</h1>
      <div className="rounded-2xl border border-border bg-panel p-3 focus-within:border-muted-foreground/50">
        <textarea
          rows={3}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder="e.g. Add a /health endpoint that reports database connectivity, with a test"
          aria-label="What should your agent build?"
          className="w-full resize-none bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 items-center gap-1.5 rounded-lg bg-muted px-2 text-sm">
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <select
              aria-label="Repository"
              value={selected}
              disabled={isLoading}
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
          {needsRepo && (
            <Input
              value={newRepo}
              onChange={(e) => setNewRepo(e.target.value)}
              placeholder="github.com/owner/repo"
              aria-label="Repository to import"
              className="h-8 w-56 font-mono text-xs"
            />
          )}
          <Button
            size="icon"
            className="ml-auto size-8 rounded-full"
            disabled={!canSubmit}
            onClick={() => void submit()}
            aria-label="Start"
          >
            {createProject.isPending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
          </Button>
        </div>
      </div>
      {error && <p className="text-center text-sm text-destructive">{error}</p>}
      <p className="text-center text-xs text-muted-foreground">
        Plan → authorize budget → fund on Solana devnet → agent builds in a sandbox → verified → you accept and it settles.
      </p>
    </section>
  );
}
