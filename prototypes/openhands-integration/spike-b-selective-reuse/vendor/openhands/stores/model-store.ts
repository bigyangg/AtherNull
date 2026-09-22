/**
 * SPIKE-B STUB (see MANIFEST.md "stores/model-store" row — zustand store,
 * explicitly called out in the task brief as a stub candidate). Upstream
 * tracks `/model` command entries per conversation, anchored to the message
 * event that triggered them, fed by live conversation state. This harness
 * seeds an empty map (harness-local, not wired to anything live) — no
 * fixture in this harness represents a `/model` command, so
 * `messages.tsx`'s `modelAnchorIds` is always `null` and `<ModelMessages>`
 * (also stubbed — see MANIFEST.md) is never mounted.
 */
import { create } from "zustand";

export interface ModelStoreEntry {
  anchorEventId: string | null;
}

interface ModelStoreState {
  entriesByConversation: Record<string, ModelStoreEntry[]>;
}

export const useModelStore = create<ModelStoreState>(() => ({
  entriesByConversation: {},
}));
