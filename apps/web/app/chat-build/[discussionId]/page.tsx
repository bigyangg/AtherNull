"use client";

import { Suspense, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";

import { ChatBuildBar, ChatBuildCard } from "@/components/chat-build/chat-build-card";
import { useEmbeddedInCanvas } from "@/lib/use-embedded";

// The chat-native build, framed by the Agent Canvas (patch 0006) in two
// ways: ?view=bar is the fixed-height bar at the end of a discussion (the
// current step and its action), ?view=full is the whole build in the canvas's
// large panel. Opened directly (e.g. to pay from a browser with a wallet), it
// is the full build on a plain page.
function ChatBuildView() {
  const { discussionId } = useParams<{ discussionId: string }>();
  const view = useSearchParams().get("view");
  const framed = useEmbeddedInCanvas();

  useEffect(() => {
    if (!framed || view === "bar") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") window.parent.postMessage({ type: "athernull:close-build", discussionId }, window.location.origin);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [framed, view, discussionId]);

  if (view === "bar") {
    return (
      <>
        <style>{"html,body{background:transparent!important;min-height:0!important;margin:0!important;overflow:hidden!important}"}</style>
        <ChatBuildBar discussionId={discussionId} />
      </>
    );
  }
  return (
    <div className={framed ? "px-5 py-5" : "mx-auto max-w-2xl px-4 py-10"}>
      <ChatBuildCard discussionId={discussionId} />
    </div>
  );
}

export default function ChatBuildPage() {
  return (
    <Suspense>
      <ChatBuildView />
    </Suspense>
  );
}
