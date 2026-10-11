"use client";

import { useSyncExternalStore } from "react";

// True when this app is rendered inside the OpenHands Agent Canvas (the
// AtherNull Builds canvas extension frames it, same origin). The canvas
// then owns navigation, so the app drops its own chrome.
export function useEmbeddedInCanvas(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.self !== window.top;
      } catch {
        return true; // cross-origin parent: still framed
      }
    },
    () => false,
  );
}
