"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Messages } from "#/components/conversation-events/chat/messages";
import { isActionEvent, isObservationEvent } from "#/types/agent-server/type-guards";
import type { OpenHandsEvent } from "#/types/agent-server/core";
import { useCommandStore } from "#/stores/command-store";
import {
  fetchJourneyConversations,
  fetchJourneyEvents,
  buildJourneyTerminalCommands,
  type JourneyConversationSummary,
} from "../../lib/adapter/adapter-journey-client";

// SPIKE B (same reason as app/harness/page.tsx and app/harness-live/page.tsx
// — see MANIFEST.md "xterm SSR" row): @xterm/xterm reaches for
// `document`/`window` at module scope, which crashes during Next's server
// render.
const Terminal = dynamic(
  () => import("#/components/features/terminal/terminal"),
  { ssr: false },
);

// Same as app/harness-live/page.tsx's local toUiMessages — duplicated here
// rather than imported, since neither of those routes is modified by this
// spike. "UI events (actions replaced by observations)" per <Messages>'s own
// prop doc comment.
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

// This spike never hosts (or hits) AtherNull's real apps/web — the "Return
// to review" link below is a URL-correctness check only (see README.md's
// "Return to review" section). Default matches apps/web's own dev-server
// default Next.js port; override via env if apps/web is actually running
// somewhere else when eyeballing the link.
const WEB_APP_BASE =
  process.env.NEXT_PUBLIC_ATHERNULL_WEB_BASE ?? "http://localhost:3000";

// Real ids from spike-f-execution-review-journey/seed-journey-output.json
// (this session's actual seeded run) — overridable via env the same way
// app/harness-live/page.tsx's NEXT_PUBLIC_CONVERSATION_ID is, for a
// re-seeded environment with different ids.
const JOURNEY_PROJECT_ID =
  process.env.NEXT_PUBLIC_JOURNEY_PROJECT_ID ??
  "30d02805-f11e-431d-a887-ad1cd3b472c6";
const JOURNEY_TASK_ID =
  process.env.NEXT_PUBLIC_JOURNEY_TASK_ID ??
  "4030f47b-42ca-422f-ac0b-41a513fdd01b";

// See adapter-journey-client.ts's fetchJourneyConversations doc comment:
// narrows /search's org-wide results down to this journey's own task by
// matching the distinctive marker seed-journey-data.mjs embeds in the real
// task requirements text.
const JOURNEY_TITLE_FILTER =
  process.env.NEXT_PUBLIC_JOURNEY_TITLE_FILTER ?? "[Spike-F journey";

// Real AtherNull route pattern, read (not guessed) from
// apps/web/app/(app)/projects/[projectId]/tasks/[taskId]/page.tsx.
const REVIEW_URL = `${WEB_APP_BASE}/projects/${JOURNEY_PROJECT_ID}/tasks/${JOURNEY_TASK_ID}`;

type ConversationsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; conversations: JourneyConversationSummary[] };

type EventsState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; events: OpenHandsEvent[] };

/** Formats the real AtherNull status + verification outcome tags the
 * adapter's mapping.ts now attaches to each execution's AppConversation
 * (buildStatusTags) — rendered directly as the raw tag values (e.g.
 * "SETTLED · PASS"), simpler than wiring up a vendored tag-chip component
 * for a single badge (see README.md's "status tag" section for why this
 * spike chose that over reusing conversation-tag-chips.tsx). */
function formatStatusBadge(tags: Record<string, string> | null | undefined): string {
  if (!tags || !tags.status) return "(no status tag)";
  return tags.verification_outcome
    ? `${tags.status} · ${tags.verification_outcome}`
    : tags.status;
}

export default function HarnessJourneyPage() {
  const [conversationsState, setConversationsState] = useState<ConversationsState>({
    status: "loading",
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventsState, setEventsState] = useState<EventsState>({ status: "idle" });

  // Fetch the attempt list once on mount.
  useEffect(() => {
    let cancelled = false;
    fetchJourneyConversations(ADAPTER_BASE, JOURNEY_TITLE_FILTER)
      .then((conversations) => {
        if (cancelled) return;
        // Oldest attempt first (attempt 1, 2, ...) — same chronological order
        // a native sidebar would list retry cards in.
        const sorted = [...conversations].sort(
          (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
        );
        setConversationsState({ status: "ready", conversations: sorted });
        // Default to the LAST (most recent) attempt — for the seeded journey
        // this is the SETTLED+PASS attempt, showing the fullest event set
        // (file diff + terminal + status tag) without an extra click.
        setSelectedId(sorted.length > 0 ? sorted[sorted.length - 1].id : null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setConversationsState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch the selected attempt's events whenever the selection changes.
  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    useCommandStore.setState({ commands: [] });
    setEventsState({ status: "loading" });
    fetchJourneyEvents(ADAPTER_BASE, selectedId)
      .then((events) => {
        if (cancelled) return;
        useCommandStore.setState({ commands: buildJourneyTerminalCommands(events) });
        setEventsState({ status: "ready", events });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setEventsState({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
      useCommandStore.setState({ commands: [] });
    };
  }, [selectedId]);

  const events = eventsState.status === "ready" ? eventsState.events : [];
  const messages = useMemo(() => toUiMessages(events), [events]);
  const conversations =
    conversationsState.status === "ready" ? conversationsState.conversations : [];
  const selectedConversation = conversations.find((c) => c.id === selectedId) ?? null;

  return (
    <main className="mx-auto max-w-3xl p-8 text-foreground">
      <h1 className="text-lg font-semibold mb-1">
        Spike B — OpenHands selective reuse (execution-review journey)
      </h1>
      <p className="text-sm text-muted mb-2">
        Real AtherNull execution-attempt data for one seeded multi-attempt
        task, read via Spike C&apos;s adapter-server (Phase 1 mapping
        changes), rendered through the vendored event feed plus the real,
        unmodified OpenHands file-editor diff visualizer (newly vendored for
        this spike — see vendor/openhands/MANIFEST.md). Not the output of a
        paid coding-agent execution; see README.md for full provenance.
      </p>
      <p className="text-xs text-muted mb-6" data-testid="adapter-target">
        adapter: {ADAPTER_BASE} · title filter: &quot;{JOURNEY_TITLE_FILTER}&quot;
      </p>

      {/* Attempt selector — new custom UI. Spike B never vendored a
          conversation-list/sidebar component (only the event-feed +
          terminal reuse units), so unlike Spike C (which gets attempt
          switching for free from OpenHands' real sidebar once each
          execution has its own AppConversation), this is hand-rolled here.
          See README.md's "attempt-switching asymmetry" section. */}
      <section className="mb-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted mb-2">
          Attempt
        </h2>
        {conversationsState.status === "loading" && (
          <p data-testid="conversations-status" data-status="loading" className="text-sm text-muted">
            Loading attempts…
          </p>
        )}
        {conversationsState.status === "error" && (
          <p
            data-testid="conversations-status"
            data-status="error"
            className="text-sm text-red-500"
          >
            Failed to load attempts: {conversationsState.message}
          </p>
        )}
        {conversationsState.status === "ready" && (
          <div
            data-testid="attempt-selector"
            role="tablist"
            className="flex flex-wrap gap-2"
          >
            {conversations.length === 0 && (
              <p className="text-sm text-muted">No attempts found.</p>
            )}
            {conversations.map((conversation) => {
              const isSelected = conversation.id === selectedId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  data-testid="attempt-tab"
                  data-selected={isSelected}
                  onClick={() => setSelectedId(conversation.id)}
                  className={
                    isSelected
                      ? "rounded border border-border bg-interactive-hover px-3 py-1.5 text-left text-sm font-medium text-foreground"
                      : "rounded border border-border bg-surface px-3 py-1.5 text-left text-sm text-muted hover:bg-interactive-hover"
                  }
                >
                  {conversation.title}
                </button>
              );
            })}
          </div>
        )}
      </section>

      {selectedConversation && (
        <p
          data-testid="status-badge"
          data-status-value={formatStatusBadge(selectedConversation.tags)}
          className="mb-6 inline-block rounded bg-surface-raised px-3 py-1 text-sm font-medium text-foreground"
        >
          Status: {formatStatusBadge(selectedConversation.tags)}
        </p>
      )}

      {eventsState.status === "loading" && (
        <p data-testid="load-status" data-load-status="loading" className="text-sm text-muted mb-8">
          Loading real events for this attempt…
        </p>
      )}
      {eventsState.status === "error" && (
        <p data-testid="load-status" data-load-status="error" className="text-sm text-red-500 mb-8">
          Failed to load events: {eventsState.message}
        </p>
      )}

      {eventsState.status === "ready" && selectedConversation && (
        <>
          <p data-testid="load-status" data-load-status="ready" className="text-sm text-muted mb-6">
            Loaded {events.length} real events for attempt {selectedConversation.id}.
          </p>

          <section className="mb-10">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-muted mb-3">
              Event feed ({events.length} events)
            </h3>
            <div className="rounded border border-border bg-surface p-4">
              <Messages messages={messages} allEvents={events} />
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

      <a
        href={REVIEW_URL}
        data-testid="return-to-review-link"
        className="text-sm text-blue-400 underline"
      >
        Return to review
      </a>
      <p className="text-xs text-muted mt-1">
        URL-correctness check only — this spike does not render AtherNull&apos;s
        real review-panel.tsx.
      </p>
    </main>
  );
}
