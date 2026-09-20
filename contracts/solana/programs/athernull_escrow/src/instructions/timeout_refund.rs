use anchor_lang::prelude::*;

use crate::constants::ESCROW_SEED;
use crate::error::EscrowError;
use crate::state::{Escrow, EscrowStatus};

#[derive(Accounts)]
pub struct TimeoutRefund<'info> {
    /// Deliberately no signature requirement on `authority` (checked only via
    /// `has_one` below, address-only) and no signer at all beyond whichever
    /// account pays this transaction's fee — this is the permissionless
    /// fallback (plansol.md Sec 0). Anyone can trigger it once the deadline
    /// has passed, so a withheld or lost platform authority key can never
    /// strand customer funds in the escrow indefinitely. The reclaimed rent
    /// still always goes back to `authority` (it was the payer at
    /// `initialize_escrow`), not to whoever happens to call this — a
    /// deliberate choice to keep rent destination consistent across all
    /// three terminal instructions rather than turning this into a keeper
    /// reward.
    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.task_id.as_ref()],
        bump = escrow.bump,
        has_one = authority,
        has_one = customer,
        constraint = escrow.status == EscrowStatus::Funded @ EscrowError::NotFunded,
        close = authority,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut)]
    pub customer: SystemAccount<'info>,

    /// CHECK: rent destination only, address-checked against
    /// `escrow.authority` via `has_one` — never required to sign.
    #[account(mut)]
    pub authority: UncheckedAccount<'info>,
}

pub fn timeout_refund_handler(ctx: Context<TimeoutRefund>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.escrow.deadline, EscrowError::DeadlineNotReached);

    let total = ctx.accounts.escrow.amount;

    // Only the funded amount moves here — `close = authority` above sweeps
    // the remaining rent-exempt balance to `authority` once this handler
    // returns (see release_handler's comment for why no `status` write is
    // needed: `close` skips normal serialization).
    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= total;
    **ctx.accounts.customer.to_account_info().try_borrow_mut_lamports()? += total;

    Ok(())
}
