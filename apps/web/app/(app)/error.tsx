"use client";

import { useEffect } from "react";

import { AppErrorScreen } from "@/components/error-screen";
import { APP_HOME } from "@/lib/app-home";

// An unexpected error inside the signed-in app (Builds, projects, usage…).
// Your data is untouched: this only affects the page that failed to render.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AppErrorScreen
      code="Error"
      title="This page couldn't load"
      message="Something unexpected happened while showing this page. Your builds, payments and conversations are not affected. Try again, or go back to your workspace."
      reference={error.digest}
      onRetry={reset}
      homeHref={APP_HOME}
      homeLabel="Back to workspace"
    />
  );
}
