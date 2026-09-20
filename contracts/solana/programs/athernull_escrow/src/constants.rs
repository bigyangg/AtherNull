use anchor_lang::prelude::*;

/// PDA seed prefix: `[ESCROW_SEED, task_id]` (plansol.md Sec 1).
#[constant]
pub const ESCROW_SEED: &[u8] = b"escrow";
