"use client";

import { useEffect } from "react";

import { SiteErrorScreen } from "@/components/error-screen";

// Any unexpected error on a public page. The digest matches the server log
// entry, so support can find exactly what went wrong.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <SiteErrorScreen
      code="Error"
      title="Something went wrong."
      message="This page hit an unexpected problem. Trying again usually fixes it. If it keeps happening, contact support and include the reference below."
      reference={error.digest}
      onRetry={reset}
    />
  );
}
