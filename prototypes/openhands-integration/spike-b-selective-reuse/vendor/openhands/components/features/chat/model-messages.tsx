/**
 * SPIKE-B STUB (see MANIFEST.md "ModelMessages" row). Upstream renders
 * `/model` command entries, reading `useModelStore` (also stubbed, seeded
 * empty — see stores/model-store.ts) and a live `useFreeModels` query. Since
 * the store is always empty in this harness, `messages.tsx`'s
 * `modelAnchorIds` is always `null` and this component is never actually
 * mounted — kept as a same-signature stand-in (mirrors upstream's own
 * early-return-null behavior) so `messages.tsx` needs no edits.
 */
export function ModelMessages(_props: {
  conversationId: string | null;
  anchorEventId: string;
}) {
  return null;
}
