"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Messages } from "#/components/conversation-events/chat/messages";
import { isActionEvent, isObservationEvent } from "#/types/agent-server/type-guards";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import { useCommandStore } from "#/stores/command-store";
import {
  fetchLiveConversationAndEvents,
  buildLiveTerminalCommands,
  type LiveConversationSummary,
} from "../../lib/adapter/adapter-live-client";

// SPIKE-B (same reason as app/harness/page.tsx — see MANIFEST.md "xterm SSR"
// row): @xterm/xterm reaches for `document`/`window` at module scope, which
// crashes during Next's server render.
const Terminal = dynamic(
  () => import("#/components/features/terminal/terminal"),
  { ssr: false },
);

// Same as app/harness/page.tsx's local toUiMessages — duplicated here
// (not imported from that untouched fixture-only file) rather than shared,
// since app/harness/page.tsx is deliberately left unmodified by this spike.
// "UI events (actions replaced by observations)" per <Messages>'s own prop
// doc comment: every event EXCEPT an ActionEvent that already has a paired
// ObservationEvent (that action's content renders via the observation
// instead, using allEvents to look up its thought/title).
function toUiMessages(allEvents: OpenHandsEvent[]): OpenHandsEvent[] {
  const answeredActionIds = new Set(
    allEvents.filter(isObservationEvent).map((event) => event.action_id),
  );
  return allEvents.filter(
    (event) => !(isActionEvent(event) && answeredActionIds.has(event.id)),
  );
}

const ADAPTER_BASE =
  process.env.NEXT_PUBLIC_ADAPTER_BASE ?? "http://localhost:4100";
const CONVERSATION_ID = process.env.NEXT_PUBLIC_CONVERSATION_ID ?? "";

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      conversation: LiveConversationSummary | null;
      events: OpenHandsEvent[];
    };

export default function HarnessLivePage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    // Reset the command store on every (re)fetch — including the very
    // first mount — so this live route and the existing fixture-only
    // /harness route (app/harness/page.tsx) can never leak terminal state
    // into each other if both are visited in the same browser session
    // (e.g. during a Playwright run that loads both pages).
    useCommandStore.setState({ commands: [] });
    setState({ status: "loading" });

    if (!CONVERSATION_ID) {
      setState({
        status: "error",
        message:
          "NEXT_PUBLIC_CONVERSATION_ID is not set — see README.md's Spike D section for how to populate .env.local before starting next dev.",
      });
      return () => {
        cancelled = true;
      };
    }

    fetchLiveConversationAndEvents(ADAPTER_BASE, CONVERSATION_ID)
      .then(({ conversation, events }) => {
        if (cancelled) return;
        useCommandStore.setState({
          commands: buildLiveTerminalCommands(events),
        });
        setState({ status: "ready", conversation, events });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });

    return () => {
      cancelled = true;
      // Reset again on unmount — same isolation reason as above.
      useCommandStore.setState({ commands: [] });
    };
  }, []);

  const events = state.status === "ready" ? state.events : [];
  const messages = useMemo(() => toUiMessages(events), [events]);

  return (
    <main className="mx-auto max-w-3xl p-8 text-foreground">
      <h1 className="text-lg font-semibold mb-1">
        Spike B — OpenHands selective reuse harness (live data)
      </h1>
      <p className="text-sm text-muted mb-2">
        Vendored event feed (Messages/EventMessage) and terminal components,
        rendering REAL AtherNull API data read from a seeded local
        development database — via Spike C&apos;s already-working
        adapter-server, unmodified. Not fixtures (see the fixture-only{" "}
        <code>/harness</code> route for those), and NOT the output of a paid
        coding-agent execution — see README.md&apos;s &quot;Spike D&quot;
        section for the exact provenance.
      </p>
      <p className="text-xs text-muted mb-8" data-testid="adapter-target">
        adapter: {ADAPTER_BASE} · conversation: {CONVERSATION_ID || "(unset)"}
      </p>

      {state.status === "loading" && (
        <p data-testid="load-status" data-load-status="loading" className="text-sm text-muted mb-8">
          Loading real conversation data from the adapter-server…
        </p>
      )}

      {state.status === "error" && (
        <p
          data-testid="load-status"
          data-load-status="error"
          className="text-sm text-red-500 mb-8"
        >
          Failed to load live data: {state.message}
        </p>
      )}

      {state.status === "ready" && (
        <>
          <p
            data-testid="load-status"
            data-load-status="ready"
            className="text-sm text-muted mb-2"
          >
            Loaded {state.events.length} real events for conversation{" "}
            {state.conversation?.id ?? CONVERSATION_ID}.
          </p>
          <h2
            data-testid="conversation-title"
            className="text-base font-semibold mb-6"
          >
            {state.conversation?.title ?? "(conversation not found)"}
          </h2>

          <section className="mb-10">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
              Event feed ({state.events.length} events)
            </h3>
            <div className="rounded border border-border bg-surface p-4">
              <Messages messages={messages} allEvents={state.events} />
            </div>
          </section>

          <section className="mb-10">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
              Terminal (presentation-only — real fetched command/output text,
              replayed, not a live PTY)
            </h3>
            <div className="h-80 rounded border border-border bg-surface">
              <Terminal />
            </div>
          </section>
        </>
      )}
    </main>
  );
}
