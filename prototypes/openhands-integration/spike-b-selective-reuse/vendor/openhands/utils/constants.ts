/**
 * SPIKE-B PARTIAL VENDOR (see MANIFEST.md "utils/constants" row). Upstream's
 * `utils/constants.ts` is 785 lines covering unrelated app-wide constants
 * (product URLs, i18n-keyed status labels, settings defaults, ...). Only
 * `METADATA_PREFIXES` — read by `event-message-components/skill-item-expanded.tsx`
 * — is reproduced here, verbatim.
 */
export const METADATA_PREFIXES: readonly string[] = [
  "The following information has been included",
  "It may or may not be relevant",
  "Skill location:",
  "(Use this path to resolve",
];
