"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useCreateRepoProject } from "@/lib/hooks/use-repo-projects";

// Phase 4C — this wizard used to have a second step ("Describe the work")
// that created AND funded a task in one shot via the legacy POST /v1/jobs +
// /fund pair. That path is now compatibility-only, gated behind
// ALLOW_LEGACY_JOB_CREATION and fail-closed in production by default (see
// apps/api/src/routes/jobs.ts), and even when enabled, a legacy-created task
// can never be funded — the hardened /fund check requires real provenance
// (an APPROVED estimate + a CONSUMED budget authorization) that a synchronous
// onboarding step cannot produce (generating an estimate calls the planner
// LLM, and authorizing a budget is a separate privileged action). Rather
// than leave a wizard step that silently 403s in production, this now stops
// after creating the project and hands off to the project page's own
// canonical Scope & Estimate -> Budget Authorization -> Prepare Build flow
// (scope-estimate-panel.tsx / budget-authorization-panel.tsx / add-task-form.tsx).
export function NewRepoProjectForm() {
  const router = useRouter();
  const createRepoProject = useCreateRepoProject();

  const [permittedRepository, setPermittedRepository] = useState("");
  const [revision, setRevision] = useState("");
  const [scope, setScope] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canSubmit = permittedRepository.trim().length > 0 && !createRepoProject.isPending;

  async function handleSubmit() {
    setSubmitError(null);
    try {
      const project = await createRepoProject.mutateAsync({
        permittedRepository: permittedRepository.trim(),
        revision: revision.trim() || undefined,
        scope: scope.trim() || undefined,
      });
      router.push(`/projects/${project.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import a repository</CardTitle>
        <CardDescription>
          Point AtherNull at a repository it's allowed to work on. You'll scope, estimate, and
          authorize a budget for your first build on the project page next.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="permitted-repository">
            Repository
          </label>
          <Input
            id="permitted-repository"
            placeholder="github.com/acme/website"
            value={permittedRepository}
            onChange={(event) => setPermittedRepository(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="revision">
            Default revision (optional)
          </label>
          <Input
            id="revision"
            placeholder="main"
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="scope">
            Scope (optional)
          </label>
          <Input
            id="scope"
            placeholder="Only touch apps/web/**"
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          />
        </div>
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      </CardContent>
      <CardFooter className="justify-end">
        <Button disabled={!canSubmit} onClick={handleSubmit}>
          {createRepoProject.isPending ? "Importing…" : "Import repository"}
        </Button>
      </CardFooter>
    </Card>
  );
}
