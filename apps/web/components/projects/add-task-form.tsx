"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useAgentProfiles } from "@/lib/hooks/use-agent-profiles";
import { useProjectBudgetAuthorizations } from "@/lib/hooks/use-budget-authorizations";
import { usePrepareBuild } from "@/lib/hooks/use-tasks";
import { formatMinor } from "@/lib/types";

// Phase 4C — Provenance-Bound Task Creation and Execution Activation Gate.
//
// This panel replaces the old ad-hoc "type an objective, guess a budget,
// create + fund in one click" flow. A task can now only be prepared from an
// ACTIVE budget authorization, which itself only exists against an APPROVED
// scope estimate (see scope-estimate-panel.tsx / budget-authorization-panel.tsx).
// Submitting here calls the canonical
// POST /v1/projects/:projectId/tasks/from-budget-authorization endpoint,
// which lands the task at AWAITING_FUNDING and stops — no execution, no
// funding, no payment movement happens here. A separate, later "Activate
// Build" action (on the task detail page) is what moves it to QUEUED.
//
// Vocabulary rule for this component and anything downstream of it: never
// "Fund"/"Pay"/"Deposit"/"Escrow" — only "Prepare Build" / "Activate Build" /
// "Awaiting Funding", since no real payment rail exists anywhere in this
// codebase yet (see docs/adr/0010-provenance-bound-task-creation.md).
export function AddTaskForm({
  projectId,
  defaultRevision,
}: {
  projectId: string;
  defaultRevision: string;
}) {
  const router = useRouter();
  const prepareBuild = usePrepareBuild(projectId);
  const { data: agentProfiles, isLoading: profilesLoading } = useAgentProfiles();
  const { data: authorizations, isLoading: authorizationsLoading } =
    useProjectBudgetAuthorizations(projectId);
  const noAgentProfiles = !profilesLoading && (agentProfiles?.length ?? 0) === 0;

  const activeAuthorizations = authorizations?.filter((a) => a.status === "ACTIVE") ?? [];

  const [repositoryRevision, setRepositoryRevision] = useState(defaultRevision);
  const [budgetAuthorizationId, setBudgetAuthorizationId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const agentProfileId = agentProfiles?.[0]?.id ?? "";
  const selectedAuthorizationId = budgetAuthorizationId || activeAuthorizations[0]?.id || "";
  const canSubmit =
    repositoryRevision.trim().length > 0 &&
    agentProfileId.length > 0 &&
    selectedAuthorizationId.length > 0 &&
    !prepareBuild.isPending;

  async function handleSubmit() {
    setError(null);
    try {
      const task = await prepareBuild.mutateAsync({
        budgetAuthorizationId: selectedAuthorizationId,
        agentProfileId,
        repositoryRevision: repositoryRevision.trim(),
      });
      router.push(`/projects/${projectId}/tasks/${task.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  }

  const isLoading = profilesLoading || authorizationsLoading;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Prepare a build</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : activeAuthorizations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active budget authorization yet. Generate and approve a scope estimate, then
            authorize a budget against it, before a build can be prepared.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="add-task-authorization">
              Budget authorization
            </label>
            <select
              id="add-task-authorization"
              className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs"
              value={selectedAuthorizationId}
              onChange={(event) => setBudgetAuthorizationId(event.target.value)}
            >
              {activeAuthorizations.map((authorization) => (
                <option key={authorization.id} value={authorization.id}>
                  {formatMinor(authorization.amountMinor, authorization.currency)} — estimate v
                  {authorization.estimateVersion}
                </option>
              ))}
            </select>
          </div>
        )}
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
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        {noAgentProfiles && (
          <p className="text-sm text-warning">
            No agent profiles are configured for this organization — an admin
            needs to add one before a build can be prepared.
          </p>
        )}
        <div className="flex items-center justify-between">
          {error ? <p className="text-sm text-destructive">{error}</p> : <span />}
          <Button disabled={!canSubmit} onClick={handleSubmit}>
            {prepareBuild.isPending ? "Preparing…" : "Prepare Build"}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
