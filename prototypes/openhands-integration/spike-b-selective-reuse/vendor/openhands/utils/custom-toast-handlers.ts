/**
 * SPIKE-B STUB (see MANIFEST.md "utils/custom-toast-handlers" row). Upstream
 * dispatches a styled toast notification (a UI-chrome concern owned by the
 * app shell, not either of the 2 target reuse units). Logs to the console
 * instead.
 */
export function displayErrorToast(message: string | null): void {
  // eslint-disable-next-line no-console
  console.error(`[spike-b stub] toast: ${message ?? "unknown error"}`);
}
