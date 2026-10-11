"use client";

import { Suspense } from "react";
import { useParams } from "next/navigation";

import { AgentCanvas } from "@/components/canvas/agent-canvas";

// The project's home is the agent canvas: one conversation that carries a
// build from prompt -> plan -> budget -> devnet funding -> live agent ->
// verification -> review, with the plan/diff/terminal/chain state beside it.
// The card-based task list lives on at ./tasks for an at-a-glance view.
export default function ProjectCanvasPage() {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <Suspense>
      <AgentCanvas projectId={projectId} />
    </Suspense>
  );
}
