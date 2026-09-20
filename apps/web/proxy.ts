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
const PUBLIC_PATHS = ["/", "/docs", "/whitepaper", "/privacy-policy", "/refund-policy", "/contact", "/waitlist"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublicPath = PUBLIC_PATHS.includes(pathname);
  const landingOnly = process.env.LANDING_ONLY_MODE === "true";

  // Until apps/api is live, keep account/product routes closed. Marketing,
  // policy, and contact pages are public and don't depend on the API.
  if (landingOnly && !isPublicPath) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const isAuthPath = AUTH_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );

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

  if (sessionCookie && pathname === "/" && !landingOnly) {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  if (sessionCookie && isAuthPath && pathname !== "/verify-email") {
    return NextResponse.redirect(new URL("/projects", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // Excludes any path with a file extension (images, fonts, icon.png,
  // robots.txt, etc.) in addition to api/_next — otherwise an unauthenticated
  // request for a static asset like /brand/*.png gets redirected to
  // /sign-in, and whatever fetched it (e.g. next/image's optimizer) chokes
  // trying to parse that HTML redirect as an image.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)"],
};
