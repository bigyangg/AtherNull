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
