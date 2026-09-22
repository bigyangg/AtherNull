/**
 * SPIKE-B SCOPE-REDUCTION SHIM (see MANIFEST.md "react-i18next" row).
 *
 * Real `react-i18next` initializes an i18next instance loading 15 languages
 * of translated strings over HTTP (`i18next-http-backend`) — real app
 * infrastructure this presentation-only harness has no backend for. Per the
 * task brief this is stubbed with a passthrough `{ t: (k) => k }`: every
 * vendored component still calls `useTranslation()` / `t(I18nKey.XXX)`
 * exactly as upstream does, it just renders the raw `I18nKey` string instead
 * of a translated label. This is a deliberate scope reduction, not a
 * incompatibility — react-i18next itself works fine under Next.js.
 *
 * Wired in via `next.config.ts`'s `turbopack.resolveAlias`, so every
 * `import { useTranslation } from "react-i18next"` in vendored files
 * resolves here without editing those files' import lines.
 */
import type { ReactNode } from "react";

type TFunction = (key: string, options?: Record<string, unknown>) => string;

const t: TFunction = (key) => key;

export function useTranslation(_ns?: string | string[]) {
  return {
    t,
    i18n: { language: "en", changeLanguage: async () => undefined },
    ready: true,
  };
}

// `<Trans i18nKey="..." components={{...}} />` — used by
// `get-event-content.tsx` (real interpolated titles like "Editing <path/>")
// and `model-messages.tsx` (stubbed away, so unused in practice there).
// Real react-i18next substitutes `{{token}}` placeholders in the translated
// string and swaps in `components` by tag name; since this shim has no
// translated strings, it renders the raw `i18nKey` followed by each
// component (close enough for a presentation-only harness — the important
// thing is it renders without crashing, not that the interpolation is
// pixel-faithful).
export function Trans({
  i18nKey,
  children,
  components,
}: {
  ns?: string;
  i18nKey?: string;
  values?: Record<string, unknown>;
  components?: Record<string, ReactNode>;
  children?: ReactNode;
}) {
  return (
    <>
      {children ?? i18nKey ?? null}
      {components &&
        Object.entries(components).map(([key, node]) => (
          <span key={key}>{node}</span>
        ))}
    </>
  );
}

export function initReactI18next() {
  return { type: "3rdParty" as const, init: () => undefined };
}
