"use client";

import { useSearchParams } from "next/navigation";
import { TriangleAlert } from "lucide-react";

// The canvas sends signed-in users here (?sandbox=missing) when their
// organization has no agent sandbox yet (ADR-0015 provisioning).
export function SandboxMissingNotice() {
  const searchParams = useSearchParams();
  if (searchParams.get("sandbox") !== "missing") return null;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 text-sm">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>
        <p className="font-medium text-foreground">Your organization doesn&apos;t have an agent workspace yet</p>
        <p className="mt-1 text-muted-foreground">
          An administrator needs to provision one before the canvas can open:{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">pnpm --filter @athernull/api sandbox:provision -- --org &lt;organization id&gt;</code>
        </p>
      </div>
    </div>
  );
}
