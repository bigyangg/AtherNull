import { Resend } from "resend";

// Resend + the athernull.io domain are verified (see Resend dashboard). One
// client, reused for every auth email so there's a single place to swap
// providers later.
//
// Resend's constructor throws synchronously if the key is missing/empty —
// left unguarded, that crashes the whole API process at import time
// whenever RESEND_API_KEY isn't set (e.g. a fresh local checkout), before
// any request is even handled. Construct lazily instead so a missing key
// degrades to "emails don't send, loudly logged" — consistent with the
// never-throw intent below — rather than "the server doesn't start."
const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.EMAIL_FROM ?? "AtherNull <auth@athernull.io>";

function layout(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0a;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#141414;border:1px solid #262626;border-radius:12px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <span style="font-size:15px;font-weight:600;letter-spacing:0.02em;color:#f5f5f5;">AtherNull</span>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px 32px;color:#e5e5e5;font-size:14px;line-height:22px;">
                <h1 style="font-size:18px;font-weight:600;color:#ffffff;margin:0 0 12px 0;">${title}</h1>
                ${bodyHtml}
              </td>
            </tr>
          </table>
          <p style="max-width:480px;margin:20px 0 0 0;color:#525252;font-size:12px;line-height:18px;">
            AtherNull &middot; if you didn't request this, you can safely ignore this email.
          </p>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;">
    <tr>
      <td style="border-radius:8px;background-color:#f5f5f5;">
        <a href="${url}" style="display:inline-block;padding:10px 20px;font-size:14px;font-weight:600;color:#0a0a0a;text-decoration:none;">${label}</a>
      </td>
    </tr>
  </table>
  <p style="color:#737373;font-size:12px;line-height:18px;word-break:break-all;">
    Or paste this link into your browser:<br />
    <a href="${url}" style="color:#a3a3a3;">${url}</a>
  </p>`;
}

async function send(to: string, subject: string, html: string): Promise<void> {
  // Never throw out of here: Better Auth awaits sendResetPassword/sendMagicLink
  // directly (not backgrounded) and turns a thrown error into a 500 straight
  // to the client — which both breaks the UX on a transient Resend hiccup and
  // undermines forget-password's enumeration-safe "always generic success"
  // response. A delivery failure should be loud in the server logs, never
  // visible to (or distinguishable by) the caller.
  if (!resend) {
    console.warn(
      `[email] RESEND_API_KEY not set — skipping "${subject}" to ${to}`,
    );
    return;
  }

  try {
    const { error } = await resend.emails.send({ from: FROM, to, subject, html });
    if (error) {
      console.error(`[email] failed to send "${subject}" to ${to}:`, error);
    }
  } catch (err) {
    console.error(`[email] failed to send "${subject}" to ${to}:`, err);
  }
}

export async function sendVerificationEmail(params: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const html = layout(
    "Confirm your email",
    `<p>Hi ${escapeHtml(params.name)},</p>
     <p>Confirm this email address to finish setting up your AtherNull account.</p>
     ${button(params.url, "Verify email")}
     <p>This link expires in 1 hour.</p>`,
  );
  await send(params.to, "Verify your email for AtherNull", html);
}

export async function sendPasswordResetEmail(params: {
  to: string;
  name: string;
  url: string;
}): Promise<void> {
  const html = layout(
    "Reset your password",
    `<p>Hi ${escapeHtml(params.name)},</p>
     <p>We received a request to reset the password for your AtherNull account.</p>
     ${button(params.url, "Reset password")}
     <p>This link expires in 1 hour. If you didn't request this, your password is unchanged and you can ignore this email.</p>`,
  );
  await send(params.to, "Reset your AtherNull password", html);
}

export async function sendMagicLinkEmail(params: {
  to: string;
  url: string;
}): Promise<void> {
  const html = layout(
    "Sign in to AtherNull",
    `<p>Click below to sign in. This link can only be used once.</p>
     ${button(params.url, "Sign in")}
     <p>This link expires in 15 minutes. If you didn't request this, you can ignore this email.</p>`,
  );
  await send(params.to, "Your AtherNull sign-in link", html);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
