"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";

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
import { useCreateProject } from "@/lib/hooks/use-projects";

const PROPOSED_SCOPE = [
  "Pages: home, listings, detail, contact",
  "Features: search and filtering, inquiry form",
  "Database tables: entries, categories, inquiries",
  "Authentication: owner/admin login",
  "Acceptance tests: core pages render, forms submit, admin login works",
];

export function NewProjectForm() {
  const router = useRouter();
  const createProject = useCreateProject();

  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [addFundsUsd, setAddFundsUsd] = useState("100");
  const [maxBudgetUsd, setMaxBudgetUsd] = useState("5.00");

  const canContinue = name.trim().length > 0 && objective.trim().length > 0;

  async function handleSubmit() {
    const project = await createProject.mutateAsync({
      name: name.trim(),
      objective: objective.trim(),
      maxBudgetMinor: Math.round(parseFloat(maxBudgetUsd || "0") * 100),
      currency: "USD",
    });
    router.push(`/projects/${project.id}/workspace`);
  }

  if (step === 1) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Describe your project</CardTitle>
          <CardDescription>
            Tell Proto-col what you want built. It'll propose a scope before
            anything is generated.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="project-name">
              Project name
            </label>
            <Input
              id="project-name"
              placeholder="Everest Hotel"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="project-objective">
              What do you want built?
            </label>
            <Textarea
              id="project-objective"
              placeholder="Create a modern hotel website with room management."
              rows={4}
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>

          {objective.trim().length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 p-3">
              <p className="mb-2 text-xs font-medium text-muted-foreground">
                Proposed scope
              </p>
              <ul className="flex flex-col gap-1.5">
                {PROPOSED_SCOPE.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-2 text-sm text-foreground"
                  >
                    <Check className="mt-0.5 size-3.5 shrink-0 text-success" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
        <CardFooter className="justify-end">
          <Button disabled={!canContinue} onClick={() => setStep(2)}>
            Continue
          </Button>
        </CardFooter>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Add funds</CardTitle>
        <CardDescription>
          You approve a maximum AI development budget. You're only charged
          for what's actually used.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-sm font-medium" htmlFor="add-funds">
            Add to balance (USD)
          </label>
          <Input
            id="add-funds"
            type="number"
            min="0"
            step="1"
            value={addFundsUsd}
            onChange={(event) => setAddFundsUsd(event.target.value)}
          />
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
          <p className="text-xs text-muted-foreground">
            The rest of your balance stays available for hosting and future
            change requests.
          </p>
        </div>
      </CardContent>
      <CardFooter className="justify-between">
        <Button variant="ghost" onClick={() => setStep(1)}>
          Back
        </Button>
        <Button disabled={createProject.isPending} onClick={handleSubmit}>
          {createProject.isPending ? "Starting…" : "Start building"}
        </Button>
      </CardFooter>
    </Card>
  );
}
