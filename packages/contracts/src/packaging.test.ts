// Package-boundary guard for @athernull/contracts.
//
// This package is a SOURCE workspace package (package.json: main/types ->
// src/index.ts, no build step, no dist). It is consumed as raw TypeScript by
// three different resolvers: `tsc` (moduleResolution "Bundler"), `tsx` (the
// API/test runtime) and the Next.js bundler (apps/web). Next/Turbopack/webpack
// do NOT map a relative `./x.js` specifier to `x.ts` (tsc and tsx do), so a
// `.js` suffix on a relative import breaks `next build` while typecheck and
// the API keep passing. Relative imports must therefore be extensionless.
//
// The browser also imports this package, so its non-test source must stay
// free of Node-only modules.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const srcDir = new URL("./", import.meta.url);
const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
const sourceFiles = files.filter((f) => !f.endsWith(".test.ts"));

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

test("no relative import/export specifier carries a .js (or .ts) extension", () => {
  const bad: string[] = [];
  for (const f of files) {
    const src = strip(readFileSync(new URL(f, srcDir), "utf8"));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g)) {
      if (/\.(js|ts|tsx|mjs|cjs)$/.test(m[1]!)) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], "relative specifiers must be extensionless so Next/Turbopack can resolve them");
});

test("browser-facing contracts source imports no Node-only modules", () => {
  const bad: string[] = [];
  for (const f of sourceFiles) {
    const src = strip(readFileSync(new URL(f, srcDir), "utf8"));
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith("node:") || ["fs", "path", "crypto", "child_process", "os", "net", "http", "https"].includes(spec)) {
        bad.push(`${f}: ${spec}`);
      }
      if (/^@athernull\/(database|solana-client)|@coral-xyz\/anchor|@solana\//.test(spec)) bad.push(`${f}: ${spec}`);
    }
  }
  assert.deepEqual(bad, []);
});
