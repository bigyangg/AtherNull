"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useAgentProfiles } from "@/lib/hooks/use-agent-profiles";
import { useCreateRepoProject } from "@/lib/hooks/use-repo-projects";
import { useCreateTask, useFundTask } from "@/lib/hooks/use-tasks";

function parseAcceptanceCriteria(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function NewRepoProjectForm() {
  const router = useRouter();
  const createRepoProject = useCreateRepoProject();
  const createTask = useCreateTask();
  const fundTask = useFundTask();
  const { data: agentProfiles, isLoading: profilesLoading } = useAgentProfiles();

  const [step, setStep] = useState<1 | 2>(1);
  const [permittedRepository, setPermittedRepository] = useState("");
  const [revision, setRevision] = useState("");
  const [scope, setScope] = useState("");

  const [repositoryRevision, setRepositoryRevision] = useState("");
  const [objective, setObjective] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [agentProfileId, setAgentProfileId] = useState("");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("5.00");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const canContinue = permittedRepository.trim().length > 0;
  const selectedAgentProfileId = agentProfileId || agentProfiles?.[0]?.id || "";
  const canSubmit =
    repositoryRevision.trim().length > 0 &&
    objective.trim().length > 0 &&
    selectedAgentProfileId.length > 0 &&
    !createRepoProject.isPending &&
    !createTask.isPending &&
    !fundTask.isPending;

  function goToStep2() {
    setRepositoryRevision(revision.trim());
    setStep(2);
  }

  async function handleSubmit() {
    setSubmitError(null);
    try {
      const project = await createRepoProject.mutateAsync({
        permittedRepository: permittedRepository.trim(),
        revision: revision.trim() || undefined,
        scope: scope.trim() || undefined,
      });

      const task = await createTask.mutateAsync({
        projectId: project.id,
        repositoryRevision: repositoryRevision.trim(),
        objective: objective.trim(),
        acceptanceCriteria: parseAcceptanceCriteria(acceptanceCriteria),
        agentProfileId: selectedAgentProfileId,
        budgetMinor: Math.round(parseFloat(maxBudgetUsd || "0") * 100),
        currency: "usd",
      });

      await fundTask.mutateAsync(task.id);

      router.push(`/projects/${project.id}/tasks/${task.id}`);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  if (step === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Import a repository</CardTitle>
          <CardDescription>
            Point AtherNull at a repository it's allowed to work on.
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
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={!canContinue} onClick={goToStep2}>
            Continue
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Describe the work</CardTitle>
        <CardDescription>
          What should the agent do, and how will you know it's done?
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="repository-revision">
            Repository revision
          </label>
          <Input
            id="repository-revision"
            placeholder="a commit SHA or branch name"
            value={repositoryRevision}
            onChange={(event) => setRepositoryRevision(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Snapshotted on the task so it stays reproducible, even if the
            project's default revision changes later.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="objective">
            Objective
          </label>
          <Textarea
            id="objective"
            placeholder="Add a health check endpoint at /healthz"
            rows={3}
            value={objective}
            onChange={(event) => setObjective(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="acceptance-criteria">
            Acceptance criteria (one per line)
          </label>
          <Textarea
            id="acceptance-criteria"
            placeholder={"Returns 200 with { status: \"ok\" }\nCovered by a test"}
            rows={3}
            value={acceptanceCriteria}
            onChange={(event) => setAcceptanceCriteria(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="agent-profile">
            Agent profile
          </label>
          <select
            id="agent-profile"
            className="flex h-10 w-full rounded-lg border border-border bg-muted px-3.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            value={selectedAgentProfileId}
            disabled={profilesLoading || !agentProfiles || agentProfiles.length === 0}
            onChange={(event) => setAgentProfileId(event.target.value)}
          >
            {(agentProfiles ?? []).map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.policyVersion} (rev {profile.configRevision})
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="max-budget">
            Max AI development budget (USD)
          </label>
          <Input
            id="max-budget"
            type="number"
            min="0"
            step="0.5"
            value={maxBudgetUsd}
            onChange={(event) => setMaxBudgetUsd(event.target.value)}
          />
        </div>
        {submitError && <p className="text-sm text-destructive">{submitError}</p>}
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="ghost" onClick={() => setStep(1)}>
          Back
        </Button>
        <Button disabled={!canSubmit} onClick={handleSubmit}>
          {createRepoProject.isPending || createTask.isPending || fundTask.isPending
            ? "Starting…"
            : "Start building"}
        </Button>
      </CardFooter>
    </Card>
  );
}
