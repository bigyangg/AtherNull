/**
 * SPIKE-B STUB (see MANIFEST.md "stores/command-store" row — zustand store,
 * explicitly named in the task brief as a stub candidate: "useCommandStore").
 * Upstream's version is appended to by a live websocket stream from the
 * Agent Server's PTY. This harness has no PTY and no websocket — this is a
 * plain zustand store (harness-local state, not a live connection) that
 * `app/harness/page.tsx` seeds directly via `useCommandStore.setState(...)`
 * with each terminal fixture's replayed command/output pairs before
 * rendering `<Terminal>`. `terminal.tsx` / `hooks/use-terminal.ts` are
 * otherwise unmodified real vendored files reading `state.commands` exactly
 * as upstream does — this is a REPLAY of static output, not a functional
 * terminal (see MANIFEST.md's fidelity-labeling section).
 */
import { create } from "zustand";

export type Command = {
  content: string;
  type: "input" | "output";
};

interface CommandState {
  commands: Command[];
  appendInput: (content: string) => void;
  appendOutput: (content: string) => void;
  clearTerminal: () => void;
}

export const useCommandStore = create<CommandState>((set) => ({
  commands: [],
  appendInput: (content: string) =>
    set((state) => ({
      commands: [...state.commands, { content, type: "input" }],
    })),
  appendOutput: (content: string) =>
    set((state) => ({
      commands: [...state.commands, { content, type: "output" }],
    })),
  clearTerminal: () => set({ commands: [] }),
}));
