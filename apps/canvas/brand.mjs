#!/usr/bin/env node
// AtherNull branding overlay for the pinned Agent Canvas (ADR-0015).
// Regenerates each branded file from the pinned upstream version (git HEAD)
// and applies ./brand on top, so it is idempotent and never compounds.
//   - logo and favicons      <- brand/logo.svg, brand/public/*
//   - document title         <- "AtherNull"
//   - product-surface copy   <- brand/strings.json (every locale gets the
//                               English override for those keys)
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const upstream = join(here, "upstream");
const brand = join(here, "brand");
const pristine = (path) => execFileSync("git", ["show", `HEAD:${path}`], { cwd: upstream, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// The product logo becomes AtherNull's; the OpenHands *agent* keeps its own
// mark (agent-brand-icon.tsx), since that agent really is OpenHands.
const productLogo = "src/assets/branding/athernull-logo.svg";
copyFileSync(join(brand, "logo.svg"), join(upstream, productLogo));
execFileSync("git", ["checkout", "--", "src/assets/branding/openhands-logo.svg"], { cwd: upstream });
for (const file of ["src/components/shared/buttons/openhands-logo-button.tsx", "src/routes/shared-conversation.tsx"]) {
  const source = pristine(file);
  const from = 'import OpenHandsLogo from "#/assets/branding/openhands-logo.svg?react";';
  if (!source.includes(from)) throw new Error(`upstream ${file} logo import changed; update brand.mjs`);
  writeFileSync(join(upstream, file), source.replace(from, 'import OpenHandsLogo from "#/assets/branding/athernull-logo.svg?react";'));
}
for (const file of readdirSync(join(brand, "public"))) copyFileSync(join(brand, "public", file), join(upstream, "public", file));

const rootPath = "src/root.tsx";
const root = pristine(rootPath);
if (!root.includes('{ title: "OpenHands" }')) throw new Error("upstream root.tsx title changed; update brand.mjs");
writeFileSync(join(upstream, rootPath), root.replace('{ title: "OpenHands" }', '{ title: "AtherNull" }'));

const i18nPath = "src/i18n/translation.json";
const translations = JSON.parse(pristine(i18nPath));
const overrides = JSON.parse(readFileSync(join(brand, "strings.json"), "utf8"));
for (const [key, text] of Object.entries(overrides)) {
  if (key.startsWith("_")) continue;
  const entry = translations[key];
  if (!entry || typeof entry !== "object") throw new Error(`unknown i18n key ${key}; update brand/strings.json`);
  for (const lang of Object.keys(entry)) entry[lang] = text;
}
writeFileSync(join(upstream, i18nPath), `${JSON.stringify(translations, null, 2)}\n`);
console.log(`branded canvas: logo, ${readdirSync(join(brand, "public")).length} icons, title, ${Object.keys(overrides).length - 1} strings`);
