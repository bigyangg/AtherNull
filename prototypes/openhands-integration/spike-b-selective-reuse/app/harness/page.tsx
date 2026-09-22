"use client";

import { useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { Messages } from "#/components/conversation-events/chat/messages";
import { isActionEvent, isObservationEvent } from "#/types/agent-server/type-guards";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import { useCommandStore } from "#/stores/command-store";
import {
  SYNTHETIC_EXECUTION_EVENTS_LIST,
  SYNTHETIC_EXECUTION_EVENTS,
} from "../../lib/fixtures/execution-events.synthetic";
import {
  UPSTREAM_REAL_EVENTS_LIST,
  UPSTREAM_REAL_EVENTS,
} from "../../lib/fixtures/execution-events.upstream-real";
import { executionEventsToOpenHandsEvents } from "../../lib/adapter/execution-event-to-openhands-event";

// SPIKE-B: `next/dynamic` with `ssr: false` for anything touching xterm (see
// MANIFEST.md "xterm SSR" row) — `@xterm/xterm` reaches for `document` /
// `window` at module scope, which crashes during Next's server render.
const Terminal = dynamic(
  () => import("#/components/features/terminal/terminal"),
  { ssr: false },
);

/**
 * Given the full adapted event history, returns the `messages` array
 * `<Messages>` expects: "UI events (actions replaced by observations)" per
 * its own prop doc comment — i.e. every event EXCEPT an `ActionEvent` that
 * already has a paired `ObservationEvent` (that action's content renders
 * via the observation instead, using `allEvents` to look up its thought/
 * title). An action with no paired observation yet (e.g. a `FinishAction`,
 * or an unrecognized tool call with no response) stays in `messages` as-is.
 */
function toUiMessages(allEvents: OpenHandsEvent[]): OpenHandsEvent[] {
  const answeredActionIds = new Set(
    allEvents.filter(isObservationEvent).map((event) => event.action_id),
  );
  return allEvents.filter(
    (event) => !(isActionEvent(event) && answeredActionIds.has(event.id)),
  );
}

function FixtureSection({
  title,
  events,
}: {
  title: string;
  events: OpenHandsEvent[];
}) {
  const messages = useMemo(() => toUiMessages(events), [events]);
  return (
    <section className="mb-10">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
        {title} ({events.length} events)
      </h2>
      <div className="rounded border border-border bg-surface p-4">
        <Messages messages={messages} allEvents={events} />
      </div>
    </section>
  );
}

export default function HarnessPage() {
  const syntheticEvents = useMemo(
    () => executionEventsToOpenHandsEvents(SYNTHETIC_EXECUTION_EVENTS_LIST),
    [],
  );
  const upstreamRealEvents = useMemo(
    () => executionEventsToOpenHandsEvents(UPSTREAM_REAL_EVENTS_LIST),
    [],
  );

  // Seed the (stubbed — see MANIFEST.md) command store with the 2 terminal
  // fixtures' input/output pairs so <Terminal> has something to replay. This
  // is a REPLAY of static text, not a live PTY — see MANIFEST.md's fidelity
  // labeling.
  useEffect(() => {
    const successAction = SYNTHETIC_EXECUTION_EVENTS.terminalSuccess.payload as {
      action: { command: string };
    };
    const successObs = SYNTHETIC_EXECUTION_EVENTS.terminalSuccessObservation
      .payload as { observation: { content: { text: string }[] } };
    const errorAction = SYNTHETIC_EXECUTION_EVENTS.terminalError.payload as {
      action: { command: string };
    };
    const errorObs = SYNTHETIC_EXECUTION_EVENTS.terminalErrorObservation
      .payload as { observation: { content: { text: string }[] } };

    useCommandStore.setState({
      commands: [
        { type: "input", content: successAction.action.command },
        { type: "output", content: successObs.observation.content[0]?.text ?? "" },
        { type: "input", content: errorAction.action.command },
        { type: "output", content: errorObs.observation.content[0]?.text ?? "" },
      ],
    });
  }, []);

  return (
    <main className="mx-auto max-w-3xl p-8 text-foreground">
      <h1 className="text-lg font-semibold mb-1">
        Spike B — OpenHands selective reuse harness
      </h1>
      <p className="text-sm text-muted mb-8">
        Vendored event feed (Messages/EventMessage) and terminal components,
        rendering both fixture sets. See vendor/openhands/MANIFEST.md for
        the presentation-only / mocked-providers labeling of every component
        below.
      </p>

      <FixtureSection
        title="1. Synthetic fixtures (authored for this spike)"
        events={syntheticEvents}
      />
      <FixtureSection
        title="2. Upstream-real fixtures (genuine OpenHands protocol payloads)"
        events={upstreamRealEvents}
      />

      <section className="mb-10">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
          3. Terminal (presentation-only — static replay, not a live PTY)
        </h2>
        <div className="h-80 rounded border border-border bg-surface">
          <Terminal />
        </div>
      </section>
    </main>
  );
}
