# OpenHands integration prototype — fair A/B spike

This is the isolated prototype called for by `opencodeXather.md` §9: a
side-by-side test of two ways AtherNull could adopt OpenHands
(https://github.com/OpenHands/OpenHands) frontend code, run without
presupposing which one wins.

Pinned upstream commit: `380fd839d6bcb1f9e1674ab0ff5c0225705118e8`.

- **[Spike A](./spike-a-standalone-shell/README.md)** — the standalone
  OpenHands frontend shell, run in isolation under its own built-in
  mock-backend mode. Measures install/build cost and whether the app
  genuinely boots and navigates in a real browser.
- **[Spike B](./spike-b-selective-reuse/README.md)** — 2 OpenHands
  presentation components (the event/activity feed, and the terminal)
  vendored into a minimal standalone Next.js 16 / React 19 harness. Measures
  real adapter/integration cost against AtherNull's actual event shapes.
- **[COMPARISON.md](./COMPARISON.md)** — the actual deliverable: measured
  findings from both spikes, with an explicit statement of what is and isn't
  comparable between them. No architecture winner is declared here — see
  COMPARISON.md's final section for why, and what would be needed next.

## Isolation

Everything here lives under `prototypes/openhands-integration/`. Neither
spike touches `apps/web`, `apps/api`, `packages/database`, the root
`package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` — each spike has
its own, fully separate `package.json`/lockfile and is not a pnpm workspace
member. Spike A's `upstream/` (the raw OpenHands checkout) is gitignored and
reproducible from `spike-a-standalone-shell/commit.txt`; everything else here
is committed.

## Reproducing

```bash
# Spike A
cd prototypes/openhands-integration/spike-a-standalone-shell
cat commit.txt   # exact fetch commands
# ...then npm install --ignore-scripts / npm run build:mock / npm run build:lib
# inside the resulting upstream/ checkout, per README.md

# Spike B
cd prototypes/openhands-integration/spike-b-selective-reuse
npm install
npm run build
npm run validate-fixtures
```

No live backend, auth, or paid coding-agent execution is required or was
used for either spike.
