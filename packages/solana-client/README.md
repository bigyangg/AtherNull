# packages/solana-client

Typed TypeScript wrapper over the `athernull_escrow` Anchor program (`contracts/solana`). Owns:
instruction builders and PDA derivation for the five escrow instructions. Must not own: signing or
sending transactions — every `build*Ix` function returns an unsigned `TransactionInstruction`;
deciding who signs what (platform authority vs. customer vs. nobody, for `timeout_refund`) belongs
to the caller.

`src/idl/athernullEscrow.json` and `src/idl/athernullEscrow.ts` are vendored, not hand-written —
copied from `contracts/solana/target/idl/` and `target/types/` after an `anchor build`. Regenerate
both together whenever the program changes; don't hand-edit either.

Deliberately not imported by `apps/api` yet (`contracts/solana/plansol.md` Sec 0/3) — this package
exists so the client surface is ready when Phase 5 payment integration actually starts, not before.

## Phase 4E.1 funding surface (thin, Anchor-free)

The package root (`@athernull/solana-client`) now exports only the ProjectFunding protocol on `@solana/web3.js` + `bs58`: canonical binding hash, PDA derivation, constants, account decode, and deposit/initialize instruction build/decode. `apps/api` imports this; `apps/web` does not need it. The Anchor-based legacy escrow wrapper described above moved to `@athernull/solana-client/legacy-escrow` and Anchor is an optional peer/dev dependency. See docs/adr/0013-solana-devnet-project-funding.md.
