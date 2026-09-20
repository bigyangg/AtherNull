use anchor_lang::prelude::*;

/// One escrow per task, PDA-seeded on `task_id` (see `ESCROW_SEED` in
/// `constants.rs`) so a second `initialize` for the same task fails instead
/// of silently creating a duplicate — that's the duplicate-payment guard,
/// not a separate check (plansol.md Sec 1).
#[account]
#[derive(InitSpace)]
pub struct Escrow {
    /// Matches Postgres `tasks.id` (uuid), carried as raw bytes so the
    /// on-chain account has no dependency on how Postgres generates ids.
    pub task_id: [u8; 16],
    pub customer: Pubkey,
    /// Platform settlement authority (plansol.md Sec 0: "platform authority
    /// key + timeout-to-refund"). Never a worker/agent key.
    pub authority: Pubkey,
    pub amount: u64,
    pub status: EscrowStatus,
    /// Unix timestamp after which `timeout_refund` becomes callable by
    /// anyone, regardless of `authority` — the fallback that keeps funds
    /// from being strandable by a withheld or lost authority key.
    pub deadline: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowStatus {
    Initialized,
    Funded,
    Released,
    Refunded,
}
