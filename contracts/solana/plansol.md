# contracts/solana — Implementation Plan

Sub-plan for the escrow program referenced by `PLAN.md` Phase 5. Scope, decisions and file
breakdown for building the Anchor program **standalone** — see "Sequencing decision" below for why
this deliberately does not touch `apps/api` yet.

## Status legend
`[ ]` not started · `[~]` in progress · `[x]` done · `[!]` blocked / needs a decision

---

## 0. Decisions locked in (2026-09-20)

| Decision | Choice | Why |
|---|---|---|
| Sequencing | Build the Anchor program standalone now; do **not** wire it into `apps/api` until Phases 1–4 (task engine, worker adapter, sandbox, verifier) exist. | `PLAN.md`'s go/no-go gate blocks payment wiring until one coding job reliably produces a verified patch. A devnet Anchor program is separable and can be written/tested in isolation without violating that gate. |
| Settlement authority | **Platform authority key + timeout-to-refund.** `release_escrow`/`refund_escrow` require the platform authority signature. A permissionless `timeout_refund` becomes callable by anyone once a deadline passes with the escrow still `Funded` — so a withheld or lost platform key can't trap customer funds forever. | Matches the repo's existing non-negotiable: a worker/agent can never self-approve or release funds ([`PLAN.md`](../../PLAN.md), [`docs/threat-model.md`](../../docs/threat-model.md)). Avoids requiring customer co-signature (which has no fallback if the customer goes silent) without over-building a multisig for an MVP. |
| Target network | Solana devnet, native SOL only. No SPL token, no Meteora/token launch. | Existing scope decision, `contracts/solana/README.md`. |
| Custody model | One PDA per task, seeded `["escrow", task_id]`, holding both state and lamports directly (no separate vault account — native SOL, not an SPL token account). | Simplest correct model for native SOL; a second `initialize` for the same `task_id` fails automatically, which is the duplicate-payment guard. |
| PDA rent reclaim (2026-09-20, post-review) | `release_escrow`/`refund_escrow`/`timeout_refund` all close the escrow PDA (`close = authority`), reclaiming its rent-exempt balance (~0.0012–0.0016 SOL depending on cluster) back to `authority` — consistently, on every terminal instruction, never to whoever happens to call `timeout_refund`. | Original design left every terminal escrow's rent-exempt balance permanently stranded (only `escrow.amount` was ever debited) — an unbounded per-task platform cost with no reclaim path, caught by external review. `authority` always gets it back because it was the payer at `initialize_escrow`; considered and rejected paying the `timeout_refund` caller instead (a "keeper reward") in favor of consistency across all three instructions. |

## Still open — do not silently resolve these

- [!] **Platform authority keypair storage.** Devnet MVP can be a gitignored local keypair file; must not be committed, must not be reachable by `workers/coding-agent`. Production key custody (KMS/HSM) is out of scope for this plan and must be revisited before any mainnet or real-fund use.
- [!] **Timeout duration** for `timeout_refund` (e.g. 7 days from funding?) — needs a number before `release.rs`/`timeout_refund.rs` can be finalized.
- [!] **Payout split** — does `release_escrow` pay the full amount to one recipient, or split platform fee / worker payout? Not yet decided; `state.rs` should be written so this isn't a breaking change later (store `amount` generically, decide split logic in `release.rs`).

---

## 1. Program design

```
contracts/solana/
  Anchor.toml                # devnet cluster config, program ID placeholder
  Cargo.toml                 # workspace manifest, pins anchor-lang version
  programs/athernull_escrow/
    Cargo.toml
    src/
      lib.rs                 # program entrypoint, instruction routing
      state.rs                # Escrow account struct
      errors.rs                # custom error enum
      instructions/
        initialize.rs          # creates the PDA, sets deadline + authority
        fund.rs                  # customer-signed SOL transfer into the PDA
        release.rs                # platform-authority-signed payout
        refund.rs                 # platform-authority-signed refund (dispute/failure path)
        timeout_refund.rs           # permissionless refund once deadline has passed
  tests/
    athernull_escrow.ts        # Anchor mocha/ts integration tests
  migrations/
    deploy.ts                    # Anchor default deploy script
```

### `state.rs` — `Escrow` account (PDA)

| Field | Type | Notes |
|---|---|---|
| `task_id` | `[u8; 32]` (or `Pubkey`-sized identifier) | Matches Postgres `tasks.id` (uuid) — stored as bytes |
| `customer` | `Pubkey` | Funder's wallet |
| `authority` | `Pubkey` | Platform settlement authority, set at `initialize` |
| `amount` | `u64` | Lamports funded |
| `status` | enum `{ Initialized, Funded, Released, Refunded }` | |
| `deadline` | `i64` (unix timestamp) | Set at `initialize`; gates `timeout_refund` |
| `bump` | `u8` | PDA bump seed |

### Instructions

| Instruction | Signer | Effect | Guards |
|---|---|---|---|
| `initialize_escrow` | Platform authority | Creates PDA `["escrow", task_id]`, sets `authority`, `deadline`, `status = Initialized` | Fails if PDA already exists → duplicate-payment prevention |
| `fund_escrow` | Customer | Transfers SOL customer → PDA, `status → Funded` | Only from `Initialized`; amount must match expected task budget |
| `release_escrow` | Platform authority | Pays out from PDA, `status → Released` | Only from `Funded`; signer must equal stored `authority` |
| `refund_escrow` | Platform authority | Pays back to `customer`, `status → Refunded` | Only from `Funded`; signer must equal stored `authority` |
| `timeout_refund` | **Anyone** (permissionless) | Same effect as `refund_escrow` | Only from `Funded` AND `Clock::now >= deadline` |

---

## Toolchain note (2026-09-19) — read before running `cargo update`

`anchor init` scaffolded the workspace and `anchor build` now succeeds end to end (`.so`, IDL, and
TS types all generated), but getting there needed `Cargo.lock` pins that don't happen by default:

- Solana's bundled SBF toolchain (`platform-tools`, both `v1.48` and `v1.51` — version-bumping
  alone didn't help) ships `rustc 1.84.1-dev`, which predates Rust's `edition2024` stabilization
  (1.85). Several transitive dependencies pulled in by `anchor-lang 0.32.2` had shipped new
  releases requiring `edition2024` or `rust-version 1.85`, which the SBF-side cargo can't parse.
- Fixed by precision-pinning the offending crates back to their last edition2021/MSRV-1.84.1
  compatible releases in `Cargo.lock`: `proc-macro-crate` (3.5.0→3.1.0, which also pulled
  `toml_edit`/`toml_datetime` back), `zeroize` (1.9.0→1.8.1), `indexmap` (2.14.2→2.5.0, pulling
  `hashbrown` back too), `unicode-segmentation` (1.13.3→1.12.0).
- **`Cargo.lock` must stay committed** (it isn't gitignored — checked). Without it, a fresh
  `cargo build`/`anchor build` will re-resolve to the newer, incompatible versions and this whole
  class of error comes back. If `cargo update` is ever run without `--precise` pins afterward,
  re-check with the scan below before trusting the result.
- Fast way to re-check the whole graph instead of waiting on a failed build (catches both the
  `edition2024` and MSRV cases in one pass):
  ```
  cargo metadata --format-version=1 | python3 -c "
  import json,sys
  d = json.load(sys.stdin)
  bad_edition = [(p['name'], p['version']) for p in d['packages'] if p.get('edition') == '2024']
  bad_msrv = [(p['name'], p['version'], p['rust_version']) for p in d['packages']
              if p.get('rust_version') and tuple(map(int, p['rust_version'].lstrip('^').split('.'))) > (1,84,1)]
  print('edition2024:', bad_edition or 'none')
  print('msrv>1.84.1:', bad_msrv or 'none')
  "
  ```
- `anchor build -- --tools-version <ver>` only affects the `cargo build-sbf` step — passing it
  broke Anchor's separate IDL-generation step (which shells out to plain `cargo test` and doesn't
  understand that flag). Once the lockfile itself is clean, plain `anchor build` with no extra args
  is correct and builds both the program and the IDL.

---

## 2. File-by-file checklist

Scaffolded by `anchor init athernull_escrow --template multiple --test-template mocha` and moved
into place (its own commit's worth of boilerplate, not hand-written) — actual generated paths
differ slightly from the original sketch (`error.rs` not `errors.rs`, `state/mod.rs` not
`state.rs`, plus an unplanned `constants.rs`). Tracking the real layout below.

- [x] `contracts/solana/Anchor.toml`
- [x] `contracts/solana/Cargo.toml` (workspace) — plus `Cargo.lock`, now pinned, see toolchain note above
- [x] `contracts/solana/programs/athernull_escrow/Cargo.toml`
- [x] `contracts/solana/programs/athernull_escrow/src/lib.rs` — all five instructions wired into the `#[program]` module
- [x] `contracts/solana/programs/athernull_escrow/src/state/mod.rs` — `Escrow` struct + `EscrowStatus` enum, both `#[derive(InitSpace)]`
- [x] `contracts/solana/programs/athernull_escrow/src/error.rs` — `EscrowError`: `NotInitialized`, `NotFunded`, `Unauthorized`, `DeadlineNotReached`, `AmountExceedsBalance`
- [x] `contracts/solana/programs/athernull_escrow/src/constants.rs` — `ESCROW_SEED = b"escrow"`
- [x] `contracts/solana/programs/athernull_escrow/src/instructions/initialize.rs` — `initialize_escrow`: creates the PDA, sets `customer`/`authority`/`amount`/`deadline`; duplicate `task_id` rejected by Anchor's `init` constraint itself
- [x] `contracts/solana/programs/athernull_escrow/src/instructions/fund.rs` — `fund_escrow`: customer-signed CPI transfer of exactly `escrow.amount`, guarded by `has_one = customer` + status check
- [x] `contracts/solana/programs/athernull_escrow/src/instructions/release.rs` — `release_escrow(amount)`: authority-signed, pays `amount` to `recipient` and the remainder back to `customer` in the same call (reconciled-actual-cost model, not flat full-balance payout)
- [x] `contracts/solana/programs/athernull_escrow/src/instructions/refund.rs` — `refund_escrow`: authority-signed, full balance back to `customer`
- [x] `contracts/solana/programs/athernull_escrow/src/instructions/timeout_refund.rs` — permissionless (no authority check), same effect as `refund_escrow`, gated on `Clock::get()?.unix_timestamp >= escrow.deadline`
- [x] `contracts/solana/tests/athernull_escrow.ts` — real suite, 6 tests, all passing against a localnet validator (2026-09-19)
- [ ] `packages/solana-client/package.json` + `src/index.ts` — typed wrapper over the generated IDL, written but **not imported by `apps/api`** in this pass

Note: `authority`/`customer` checks use Anchor's `has_one` constraint on the `escrow` account rather than
a standalone constraint on the signer — kept consistent across `fund`/`release`/`refund`/`timeout_refund`.
`release_escrow`/`refund_escrow`/`timeout_refund` debit the program-owned `escrow` PDA's lamports directly
(no CPI needed — a program may freely debit lamports from accounts it owns and credit any account); only
`fund_escrow` needs a CPI `system_program::transfer`, since it debits the customer's system-owned wallet.

---

## 3. Order of implementation

1. [x] Scaffold `Anchor.toml` + `Cargo.toml`, confirm `anchor build` runs clean with an empty program — done 2026-09-19; needed the toolchain pins above, `.so`/IDL/TS types all generate cleanly now (`anchor build`, exit 0).
2. [x] `state.rs` + `errors.rs` — real `Escrow` struct and error enum — done 2026-09-19.
3. [x] `initialize_escrow` + `fund_escrow` — done 2026-09-19 (compiles clean, `cargo check`; not yet test-run on localnet).
4. [x] `release_escrow` + `refund_escrow` with the authority check — done 2026-09-19.
5. [x] `timeout_refund` — done 2026-09-19. Full `anchor build` after all five instructions: exit 0, IDL lists all five (`initialize_escrow`, `fund_escrow`, `release_escrow`, `refund_escrow`, `timeout_refund`), `.so` is 240KB.
6. [x] Full Anchor test suite on localnet — done 2026-09-19. All 6 tests pass against a real local validator (not just compiled): happy path, refund path, duplicate-initialize rejection, unauthorized release/refund rejection, and timeout_refund proven both to fail before the deadline and to succeed after it when sent by a wallet that is neither the authority nor the customer (genuinely permissionless, not just compiled to look that way). Needed several environment fixes, see the WSL/JS toolchain note below.
7. [x] Devnet smoke test — done 2026-09-19. **Not** a rerun of the full localnet suite: devnet's
   airdrop faucet is rate-limited (unlike localnet's free airdrops), so a separate
   `tests/devnet-smoke.ts` funds its test customer wallet via `solana transfer` from the
   already-funded deploy wallet instead of `requestAirdrop`, with small amounts (0.02 SOL) to
   conserve real devnet SOL. Deployed to program id `9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv`
   (deploy signature `2zudnWEdXTG4iHEh2WUQdsRtzCKSCSCDUQ3bEWnwHwJxBGwCBisVFtVysMn2uYnFKXzgjwmQjso2nFFJdWH1oArz`).
   Happy path (`initialize_escrow` → `fund_escrow` → `release_escrow`) passes with real confirmed
   devnet transactions. Deploy (program rent-exemption) + test cost ≈1.25 SOL of the wallet's 10 SOL
   (8.75 SOL remaining) — rent-exemption alone is ~1.22 SOL for a program this size (240KB), worth
   knowing before redeploying casually. Run again with:
   `ANCHOR_PROVIDER_URL=https://api.devnet.solana.com ANCHOR_WALLET=~/.config/solana/id.json pnpm exec ts-mocha -p ./tsconfig.json -t 60000 tests/devnet-smoke.ts`
   (not via `anchor test`, which would also try to run the localnet suite's file against devnet via
   its `tests/**/*.ts` glob).
8. [x] `packages/solana-client` typed wrapper — done 2026-09-19. `src/idl/athernullEscrow.{json,ts}`
   vendored from `contracts/solana/target/{idl,types}/` (not hand-written, see the package's own
   README for how to regenerate). `src/index.ts` exports `getProgram()` and five
   `build*Ix()` functions (one per instruction) that only build unsigned `TransactionInstruction`s —
   they never sign or send, since who signs what is a settlement-policy decision that belongs to
   whatever eventually calls this (a future `apps/api` settlement module), not to the client itself.
   `pnpm install --ignore-workspace` + `tsc --noEmit` both clean, in full isolation from the root
   workspace (verified: root `pnpm-lock.yaml`'s diff is byte-identical to before this step — nothing
   leaked in). One real finding along the way: `.accounts({...})` (used successfully in the Anchor
   test suite, which doesn't enforce strict typechecking) does NOT satisfy `tsc --noEmit` for
   PDA-holding accounts here — Anchor 0.32's generated types only accept manually-specified
   `escrow`/`authority` etc. through `.accountsPartial({...})`, not `.accounts({...})`. Not a bug in
   the program or the tests (both still correct and passing), just a stricter client-side type than
   the loosely-typechecked test file happened to need.
9. **Stop.** No `apps/api` wiring until Phases 1–4 land (per sequencing decision above).

## 4. Tests required

- Rust unit tests: PDA derivation, state-transition guards. **Not written** — coverage so far is
  entirely at the Anchor TS integration level (below); a real bug in PDA derivation or state-guard
  logic would still be caught there, but dedicated Rust unit tests are cheaper to run and would
  isolate failures faster. Still open.
- [x] Anchor TS integration tests (localnet) — done 2026-09-19, all 6 passing:
  happy path (`initialize→fund→release`), refund path, duplicate-`initialize` rejection,
  unauthorized-`release`/`refund` rejection, `timeout_refund` before deadline (must fail) and after
  deadline (must succeed, sent by neither authority nor customer).
- [x] Devnet smoke test — done 2026-09-19, `tests/devnet-smoke.ts`, passing with real confirmed
  transactions (see step 7 above for signatures and cost).
- **No security audit yet** — required before any real (non-devnet-test) funds ever touch this program; not in scope for this pass.

---

## WSL/JS toolchain note (2026-09-19) — read before running `pnpm`/`anchor test` here

Getting `anchor test` to actually run (not just `anchor build`) needed several environment fixes,
none of which are `contracts/solana`-specific — they're this WSL setup's own rough edges. Recording
them so the next session doesn't re-diagnose from scratch:

- **`pnpm install` from this directory is NOT isolated by default.** Even though `contracts/solana`
  is deliberately excluded from the root `pnpm-workspace.yaml` globs, pnpm still walks up and finds
  that workspace root, and a plain `pnpm install` here reports "Scope: all 6 workspace projects" —
  i.e. it operates against the *shared root* `pnpm-lock.yaml` and can trigger a full-workspace
  reinstall prompt that would affect `apps/web`/`apps/api` too. **Always use
  `pnpm install --ignore-workspace` in this directory.** This was caught, not just theorized: a
  plain `pnpm install` here stamped an integrity hash onto the root `package.json`'s
  `packageManager` field and touched the root lockfile as a side effect before this was caught.
- **`node` wasn't directly executable from a non-interactive WSL shell.** Only a Windows-side
  `node.exe` (via `/mnt/c/Program Files/nodejs`) was reachable through shell scripts like `npm`
  (which resolve it internally), but a bare `node` invocation — which Anchor's IDL-build step and
  `pnpm exec ts-mocha` both need — failed with "No such file or directory". Routing through the
  Windows `node.exe` via a wrapper script is a dead end beyond that: its child-process spawning
  logic is still Windows-native (defaults to `cmd.exe`), so anything it spawns fails with
  `cmd.exe`-flavored errors ("... is not recognized as an internal or external command") against
  Linux tooling. **Fix: use the native Linux Node already installed via `nvm`**
  (`~/.nvm/versions/node/v24.10.0`, was already present, just not on non-interactive shells' PATH —
  likely an early-exit guard in `.bashrc` for non-interactive shells skips the `nvm` init lines).
  Symlinked `node`/`npm`/`npx`/`corepack` from there into `~/.local/bin` (already ahead of the
  `/mnt/c/...` entries on `$PATH`), then `corepack prepare pnpm@9.15.0 --activate` for a native
  `pnpm` matching the root repo's pinned version (`corepack` itself also failed the same way
  through the Windows install — its script has CRLF line endings that break under WSL bash's
  `/bin/sh` shebang; the native nvm-installed `corepack` doesn't have this problem).
- **Transient `EACCES` on `/mnt/c/...` during `pnpm install`** (a rename failed mid-install,
  1 package short of done) — a drvfs/Windows-mount flakiness, not a real permissions issue; retrying
  the same command succeeded. Same family of issue as the platform-tools download corruption and
  the test-validator slow-start below — `/mnt/c` under WSL is measurably less reliable for
  heavy/rapid I/O than a native path.
- **`solana-test-validator` (started via plain `anchor test`) times out during startup** when its
  ledger lives under `/mnt/c/...` — "Unable to get latest blockhash. Test validator does not look
  started." Fix: run `solana-test-validator --ledger <native WSL path, e.g. /tmp/...> --reset`
  directly (as its own long-lived background process, not backgrounded with a trailing `&` inside a
  one-shot script — that does NOT reliably survive the parent process exiting under WSL; use the
  harness's own background-process tracking instead), wait for `getHealth` to return `"ok"` via RPC,
  then run `anchor test --skip-local-validator` against it.
- **`declare_id!`/`Anchor.toml`/the actual `target/deploy/*-keypair.json` silently disagreed** from
  the very first build. Root cause: `anchor init` was run in a scratch directory and only the
  non-`target/` files were copied into `contracts/solana` (`target/` is correctly gitignored, so
  this was the right call) — but that meant the very first `anchor build` run inside
  `contracts/solana` auto-generated a **brand-new** keypair, while the copied `lib.rs`/`Anchor.toml`
  still referenced the scratch directory's original (different) program ID. Both built and deployed
  "successfully" throughout — the mismatch only surfaced when the TS client, reading the ID from
  `declare_id!`/the IDL, tried to talk to an address nothing was actually deployed to. **Fixed with
  `anchor keys sync`** (Anchor's own tool for exactly this), then a rebuild + redeploy. Worth an
  explicit gut-check next time this kind of manual scaffold relocation happens: after copying an
  `anchor init` output without its `target/`, run `anchor keys sync` before trusting any ID in the
  source or `Anchor.toml`.

---

## 5. Post-review fix: escrow PDAs now close on terminal state (2026-09-20)

External review of the built contract caught that `release_handler`/`refund_handler`/
`timeout_refund_handler` only ever debited `escrow.amount` (the customer's funded amount) — the
account's rent-exempt balance, paid separately by `authority` at `initialize_escrow`, was never
reclaimed and the account was never closed. Every completed task would have permanently stranded
~0.0012–0.0016 SOL (cluster-dependent) in a dead account forever — an unbounded per-task platform
liability, not a free audit trail as originally rationalized.

Fixed by adding `close = authority` to all three terminal instructions' `escrow` account constraint
(verified against the actual `anchor-lang 0.32.2` source, not assumed: `close` is implemented via
the `Exit` trait, which runs *after* the handler body returns — so manually moving the funded
amount during the handler and letting `close` sweep whatever's left, exactly the rent-exempt
balance, is correct and doesn't race). `timeout_refund` gained a new required (non-signer)
`authority` account it didn't previously need, purely as the rent destination — its permissionless
design (no signature required) is unchanged.

Consequence: `escrow.status` is no longer meaningful to check post-terminal — the account is fully
closed (0 lamports, 0 data, owner reassigned to the System Program), so
`program.account.escrow.fetch()` throws instead of returning a status. Tests updated to assert the
account is closed (`connection.getAccountInfo(escrow) === null`) and that `authority`'s balance
increased by (approximately) the rent-exempt amount, instead of fetching and checking `status`.

Verified for real, not just compiled: full localnet suite (7/7 passing) and the devnet smoke test
re-run against real devnet after upgrading the deployed program in place (`solana program extend`
was needed first — the new binary grew past the previously-allocated on-chain buffer size, a normal
consequence of adding an account to an instruction).

`packages/solana-client`'s `buildTimeoutRefundIx` signature changed to require an `authority: PublicKey`
parameter — the vendored IDL/types were re-copied from the rebuilt program.

---

## 6. Non-negotiables carried over (do not relitigate here)

- Agent/worker never gets escrow signing keys ([`PLAN.md`](../../PLAN.md), [`docs/threat-model.md`](../../docs/threat-model.md)).
- No deployment or payment counts as successful until the authoritative system (here: on-chain confirmation) confirms it.
- This plan does not change `apps/api`, `packages/database`, or any other existing component — `contracts/solana` builds and tests fully in isolation.
