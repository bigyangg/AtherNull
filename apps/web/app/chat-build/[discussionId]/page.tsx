"use client";

import { useEffect, useRef } from "react";
import { useParams } from "next/navigation";

import { ChatBuildCard } from "@/components/chat-build/chat-build-card";
import { useEmbeddedInCanvas } from "@/lib/use-embedded";

// The in-chat build card, framed by the Agent Canvas at the end of a
// discussion (patch 0006). It reports its own height so the canvas can size
// the frame; it is measured on its own wrapper, never the document, so the
// frame can shrink again. Opened directly (e.g. to pay from a tab with a
// wallet), it is the same card on a plain page.
export default function ChatBuildPage() {
  const { discussionId } = useParams<{ discussionId: string }>();
  const ref = useRef<HTMLDivElement>(null);
  const framed = useEmbeddedInCanvas();

  useEffect(() => {
    const el = ref.current;
    if (!el || !framed) return;
    const post = () =>
      window.parent.postMessage(
        { type: "athernull:chat-build", discussionId, height: Math.ceil(el.getBoundingClientRect().height) },
        window.location.origin,
      );
    const observer = new ResizeObserver(post);
    observer.observe(el);
    post();
    return () => observer.disconnect();
  }, [discussionId, framed]);

  return (
    <>
      {framed && <style>{"html,body{background:transparent!important;min-height:0!important}"}</style>}
      <div ref={ref} className={framed ? "py-1" : "mx-auto max-w-2xl px-4 py-10"}>
        <ChatBuildCard discussionId={discussionId} />
      </div>
    </>
  );
}
