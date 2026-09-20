import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

// Unauthenticated-only routes — a logged-in visitor is bounced to /projects.
const AUTH_PATHS = [
  "/sign-in",
  "/sign-up",
  "/verify-email",
  "/forgot-password",
  "/reset-password",
];

// Public marketing routes, reachable with or without a session.
const PUBLIC_PATHS = ["/"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Pre-launch flag: apps/api isn't deployed alongside this yet, so
  // sign-in/sign-up/projects would only ever show mock data or a dead auth
  // form. Bounce everything but the marketing page back to "/" until the
  // backend is live. Unset (or "false") restores normal routing.
  if (process.env.LANDING_ONLY_MODE === "true" && pathname !== "/") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const isAuthPath = AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
  const isPublicPath = PUBLIC_PATHS.includes(pathname);

  // Cookie presence only — an optimistic check to avoid a DB round trip on
  // every navigation. The real session is validated server-side wherever it
  // actually matters (every apps/api read/write), per the tenant-isolation
  // rule in PLAN.md; this middleware only decides which page to render.
  const sessionCookie = getSessionCookie(request);

  if (!sessionCookie && !isAuthPath && !isPublicPath) {
    const url = new URL("/sign-in", request.url);
    url.searchParams.set("callbackURL", pathname);
    return NextResponse.redirect(url);
  }

  if (sessionCookie && pathname === "/") {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  if (sessionCookie && isAuthPath && pathname !== "/verify-email") {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
