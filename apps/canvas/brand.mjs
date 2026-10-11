#!/usr/bin/env node
// AtherNull branding overlay for the pinned Agent Canvas (ADR-0015).
// Regenerates each branded file from the pinned upstream version (git HEAD)
// and applies ./brand on top, so it is idempotent and never compounds.
//   - logo and favicons      <- brand/logo.svg, brand/public/*
//   - document title         <- "AtherNull"
//   - product-surface copy   <- brand/strings.json (every locale gets the
//                               English override for those keys), then
//                               "OpenHands" -> "AtherNull" in every string
//   - brand check            <- fails if user-facing text still says
//                               OpenHands (see checkBrand below)
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const upstream = join(here, "upstream");
const brand = join(here, "brand");
const pristine = (path) => execFileSync("git", ["show", `HEAD:${path}`], { cwd: upstream, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

// Every logo the canvas shows becomes AtherNull's, the agent's included: in
// AtherNull the agent is presented as the AtherNull Agent.
const productLogo = "src/assets/branding/athernull-logo.svg";
copyFileSync(join(brand, "logo.svg"), join(upstream, productLogo));
execFileSync("git", ["checkout", "--", "src/assets/branding/openhands-logo.svg"], { cwd: upstream });
for (const file of ["src/components/shared/buttons/openhands-logo-button.tsx", "src/routes/shared-conversation.tsx", "src/components/shared/agent-brand-icon.tsx"]) {
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
for (const entry of Object.values(translations)) {
  for (const [lang, text] of Object.entries(entry)) {
    // "Agent Canvas" is the upstream product's own name.
    if (typeof text === "string") entry[lang] = text.replace(/OpenHands/g, "AtherNull").replace(/Agent Canvas/g, "AtherNull");
  }
}
writeFileSync(join(upstream, i18nPath), `${JSON.stringify(translations, null, 2)}\n`);
console.log(`branded canvas: logo, ${readdirSync(join(brand, "public")).length} icons, title, ${Object.keys(overrides).length - 1} strings`);

checkBrand(translations);

// Fails the build when anything a user can read still names OpenHands:
//   1. any translation string, in any locale;
//   2. string literals and JSX text in the canvas source, outside tests and
//      a short reviewed list of files whose text never reaches an AtherNull
//      user (agent-facing tool prompts, surfaces AtherNull hides, protocol
//      header names). A new hit anywhere else must be rebranded or reviewed
//      into that list.
function checkBrand(strings) {
  const banned = /openhands|open hands|all-hands\.dev|agent canvas/i;
  const problems = [];
  for (const [key, entry] of Object.entries(strings)) {
    for (const [lang, text] of Object.entries(entry)) {
      if (typeof text === "string" && banned.test(text)) problems.push(`i18n ${key} [${lang}]: ${text.slice(0, 80)}`);
    }
  }
  const reviewed = new Set(JSON.parse(readFileSync(join(brand, "brand-check-allow.json"), "utf8")).files);
  const name = String.raw`(?:OpenHands|openhands\.dev|all-hands\.dev|Agent Canvas)`;
  const literal = new RegExp(String.raw`"([^"\n]*${name}[^"\n]*)"|'([^'\n]*${name}[^'\n]*)'|\x60([^\x60\n]*${name}[^\x60\n]*)\x60|>([^<>{}();=]*${name}[^<>{}();=]*)<`, "g");
  const walk = (dir) =>
    readdirSync(join(upstream, dir), { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? walk(`${dir}/${d.name}`) : /\.(tsx?|jsx?)$/.test(d.name) ? [`${dir}/${d.name}`] : [],
    );
  for (const file of walk("src")) {
    if (/(\.test\.|\.stories\.|\/mocks\/|\/fixtures\/|__tests__)/.test(file) || reviewed.has(file)) continue;
    const code = readFileSync(join(upstream, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/^import .*$/gm, "");
    for (const m of code.matchAll(literal)) problems.push(`${file}: ${(m[1] ?? m[2] ?? m[3] ?? m[4]).trim().slice(0, 80)}`);
  }
  if (problems.length > 0) {
    console.error(`brand check failed: ${problems.length} user-facing OpenHands reference(s)`);
    for (const p of problems.slice(0, 50)) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log("brand check: no user-facing OpenHands text");
}
