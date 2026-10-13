"use client";

import { useEffect } from "react";

import { InlineError } from "@/components/error-screen";

// The in-chat build bar or panel failed to render. Kept small: it sits inside
// the canvas, so the conversation around it stays usable.
export default function ChatBuildError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="p-1">
      <InlineError
        title="Your build couldn't be shown"
        message={`Something went wrong loading this build. Your payment and progress are safe.${error.digest ? ` Reference: ${error.digest}` : ""}`}
        onRetry={reset}
      />
    </div>
  );
}
