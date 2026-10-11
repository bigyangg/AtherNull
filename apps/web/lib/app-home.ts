// Where a signed-in user lands. ADR-0016: the OpenHands Agent Canvas is the
// product's home (sign in -> canvas -> discuss -> plan -> fund -> build).
// Deployments without the canvas set NEXT_PUBLIC_APP_HOME=/builds.
export const APP_HOME = process.env.NEXT_PUBLIC_APP_HOME || "/canvas";

// /canvas is a separate app on this origin, so reaching it needs a full page
// load rather than a client-side Next.js transition.
export function isCanvasPath(path: string): boolean {
  return path === "/canvas" || path.startsWith("/canvas/") || path.startsWith("/canvas?");
}

export function navigateTo(path: string, push: (path: string) => void): void {
  if (isCanvasPath(path)) window.location.assign(path);
  else push(path);
}
