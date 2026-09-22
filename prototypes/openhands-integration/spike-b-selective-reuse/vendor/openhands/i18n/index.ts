/**
 * SPIKE-B SCOPE-REDUCTION SHIM (see MANIFEST.md "i18n" row).
 *
 * Upstream's `#/i18n` is a configured `i18next` instance wired to
 * `i18next-http-backend` + `i18next-browser-languagedetector` +
 * `react-i18next`, loading 15 languages' worth of translated strings from
 * `public/locales/<lang>/openhands.json`. This harness is presentation-only
 * and single-language, so `i18n.t(key)` here is a passthrough that returns
 * the `I18nKey` string itself — same shim as the `react-i18next`
 * `useTranslation` stub in `#/i18n/react-i18next-shim`, just used by the two
 * vendored files (`get-action-content.ts`, `error-message.tsx`) that call
 * `i18n.t()` directly instead of through the `useTranslation()` hook.
 */
const i18n = {
  t: (key: string): string => key,
  language: "en",
  // `error-message.tsx` calls `i18n.exists(errorId)` to decide whether a
  // server-sent error id has a translated string; always false here so it
  // falls back to the generic `CHAT_INTERFACE$AGENT_ERROR_MESSAGE` key.
  exists: (_key: string): boolean => false,
};

export default i18n;
