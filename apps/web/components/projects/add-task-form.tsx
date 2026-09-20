"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAgentProfiles } from "@/lib/hooks/use-agent-profiles";
import { useCreateTask, useFundTask } from "@/lib/hooks/use-tasks";

function parseAcceptanceCriteria(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function AddTaskForm({
  projectId,
  defaultRevision,
}: {
  projectId: string;
  defaultRevision: string;
}) {
  const router = useRouter();
  const createTask = useCreateTask();
  const fundTask = useFundTask();
  const { data: agentProfiles } = useAgentProfiles();

  const [repositoryRevision, setRepositoryRevision] = useState(defaultRevision);
  const [objective, setObjective] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("5.00");
  const [error, setError] = useState<string | null>(null);

  const agentProfileId = agentProfiles?.[0]?.id ?? "";
  const canSubmit =
    repositoryRevision.trim().length > 0 &&
    objective.trim().length > 0 &&
    agentProfileId.length > 0 &&
    !createTask.isPending &&
    !fundTask.isPending;

  async function handleSubmit() {
    setError(null);
    try {
      const task = await createTask.mutateAsync({
        projectId,
        repositoryRevision: repositoryRevision.trim(),
        objective: objective.trim(),
        acceptanceCriteria: parseAcceptanceCriteria(acceptanceCriteria),
        agentProfileId,
        budgetMinor: Math.round(parseFloat(maxBudgetUsd || "0") * 100),
        currency: "usd",
      });
      await fundTask.mutateAsync(task.id);
      router.push(`/projects/${projectId}/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border p-4">
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="add-task-revision">
          Repository revision
        </label>
        <Input
          id="add-task-revision"
          value={repositoryRevision}
          onChange={(event) => setRepositoryRevision(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="add-task-objective">
          Objective
        </label>
        <Textarea
          id="add-task-objective"
          rows={3}
          value={objective}
          onChange={(event) => setObjective(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="add-task-criteria">
          Acceptance criteria (one per line)
        </label>
        <Textarea
          id="add-task-criteria"
          rows={3}
          value={acceptanceCriteria}
          onChange={(event) => setAcceptanceCriteria(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label className="text-sm font-medium" htmlFor="add-task-budget">
          Max AI development budget (USD)
        </label>
        <Input
          id="add-task-budget"
          type="number"
          min="0"
          step="0.5"
          value={maxBudgetUsd}
          onChange={(event) => setMaxBudgetUsd(event.target.value)}
        />
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <Button disabled={!canSubmit} onClick={handleSubmit} className="self-end">
        {createTask.isPending || fundTask.isPending ? "Starting…" : "Start task"}
      </Button>
    </div>
  );
}
