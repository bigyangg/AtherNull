import { NextResponse } from "next/server";

// Stores waitlist signups as Resend contacts — no database needed, so this
// works even in the landing-only deployment where apps/api/Postgres isn't
// running alongside the web app. Same Resend account/domain apps/api uses
// for auth email (see apps/api/src/email.ts), just a different audience.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_WAITLIST_AUDIENCE_ID = process.env.RESEND_WAITLIST_AUDIENCE_ID;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { name, email } = (body ?? {}) as { name?: unknown; email?: unknown };

  if (typeof email !== "string" || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }
  const trimmedName = typeof name === "string" ? name.trim().slice(0, 200) : "";

  if (!RESEND_API_KEY || !RESEND_WAITLIST_AUDIENCE_ID) {
    console.warn("[waitlist] RESEND_API_KEY / RESEND_WAITLIST_AUDIENCE_ID not set — dropping signup for", email);
    return NextResponse.json(
      { error: "Signups aren't configured yet. Try again shortly." },
      { status: 503 },
    );
  }

  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${RESEND_WAITLIST_AUDIENCE_ID}/contacts`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          first_name: trimmedName || undefined,
          unsubscribed: false,
        }),
      },
    );

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[waitlist] Resend rejected ${email}: ${res.status} ${detail}`);
      return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 502 });
    }
  } catch (err) {
    console.error(`[waitlist] failed to reach Resend for ${email}:`, err);
    return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
