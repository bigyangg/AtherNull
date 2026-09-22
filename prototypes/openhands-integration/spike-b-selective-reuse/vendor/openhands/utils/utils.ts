/**
 * SPIKE-B PARTIAL VENDOR (see MANIFEST.md "utils/utils cn()" row). Upstream's
 * `utils/utils.ts` is 785 lines of unrelated app-wide helpers (download
 * blobs, i18n-keyed status formatting, settings/provider helpers, ...) that
 * pull in their own app-specific type imports. Only `cn()` — the
 * clsx+tailwind-merge helper every vendored presentational component uses
 * for conditional class names — is reproduced here, verbatim.
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
