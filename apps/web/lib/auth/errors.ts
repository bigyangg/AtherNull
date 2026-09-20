// Error codes Better Auth appends as `?error=` on a redirect (from the
// verify-email / magic-link GET callbacks) or returns in an API error body.
const MESSAGES: Record<string, string> = {
  INVALID_TOKEN: "That link is invalid. Request a new one below.",
  TOKEN_EXPIRED: "That link has expired. Request a new one below.",
  USER_NOT_FOUND: "We couldn't find an account for that email.",
  INVALID_USER: "That link doesn't match your current session.",
  EMAIL_NOT_VERIFIED: "Verify your email before signing in.",
  INVALID_EMAIL_OR_PASSWORD: "Invalid email or password.",
  PASSWORD_COMPROMISED:
    "That password has appeared in a known data breach. Choose a different one.",
  new_user_signup_disabled: "Sign-up isn't available for that email right now.",
  failed_to_create_user: "We couldn't create your account. Please try again.",
  failed_to_create_session: "We couldn't sign you in. Please try again.",
};

export function describeAuthError(code: string | null | undefined): string | null {
  if (!code) return null;
  return MESSAGES[code] ?? "Something went wrong. Please try again.";
}
