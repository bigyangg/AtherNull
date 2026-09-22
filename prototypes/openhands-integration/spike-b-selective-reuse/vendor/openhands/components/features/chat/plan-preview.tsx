/**
 * SPIKE-B STUB (see MANIFEST.md "PlanPreview" row). Upstream renders the
 * live `PLAN.md` preview card, wired to `useHandleBuildPlanClick`,
 * `useSelectConversationTab`, and `useScrollContext` — all real app-shell
 * panel/routing state. No fixture in this harness represents a
 * `PlanningFileEditorObservation` (not one of the 9 required synthetic
 * fixtures), so `event-message.tsx`'s `PlanningObservationPreview` wrapper
 * never actually mounts this in practice.
 */
export function PlanPreview({
  planContent,
}: {
  planContent: string | null;
  isStreaming?: boolean;
  isBuildDisabled?: boolean;
}) {
  return (
    <div className="text-xs text-muted" data-testid="plan-preview-stub">
      Plan preview: {planContent ?? "(none)"}
    </div>
  );
}
