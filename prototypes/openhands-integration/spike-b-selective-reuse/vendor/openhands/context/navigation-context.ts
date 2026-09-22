/**
 * SPIKE-B STUB (see MANIFEST.md "context/navigation-context" row). Upstream
 * wraps React Router's `useNavigate()`. This harness has one static route, so
 * `navigate()` is a no-op (logged to the console so a real click is still
 * observable during manual testing).
 */
export function useNavigation(): { navigate: (path: string) => void } {
  return {
    navigate: (path: string) => {
      // eslint-disable-next-line no-console
      console.info(`[spike-b stub] navigate(${path}) — no-op, no router wired`);
    },
  };
}
