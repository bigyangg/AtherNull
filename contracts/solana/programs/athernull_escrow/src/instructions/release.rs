use anchor_lang::prelude::*;

use crate::constants::ESCROW_SEED;
use crate::error::EscrowError;
use crate::state::{Escrow, EscrowStatus};

#[derive(Accounts)]
pub struct ReleaseEscrow<'info> {
    /// `mut`: also the destination for the escrow PDA's reclaimed rent (see
    /// `close` below) — it was the payer at `initialize_escrow`, so it's the
    /// one that gets it back, on every terminal outcome, not just release.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.task_id.as_ref()],
        bump = escrow.bump,
        has_one = authority @ EscrowError::Unauthorized,
        has_one = customer,
        constraint = escrow.status == EscrowStatus::Funded @ EscrowError::NotFunded,
        close = authority,
    )]
    pub escrow: Account<'info, Escrow>,

    /// Payout destination named by the platform authority at call time — the
    /// chain doesn't encode a payout-split policy (still open, plansol.md
    /// Sec 0), it only moves lamports where the authority points it.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    /// Receives whatever remains of `escrow.amount` after `recipient`'s cut,
    /// in the same instruction — the reconciled-actual-cost settlement model
    /// (release what was actually spent, return the rest), not a flat
    /// full-balance payout.
    #[account(mut)]
    pub customer: SystemAccount<'info>,
}

pub fn release_handler(ctx: Context<ReleaseEscrow>, amount: u64) -> Result<()> {
    let total = ctx.accounts.escrow.amount;
    require!(amount <= total, EscrowError::AmountExceedsBalance);
    let remainder = total - amount;

    // Only the funded amount moves here — escrow is program-owned, so its
    // lamports can be debited directly; crediting any other account needs no
    // ownership check. The `close = authority` constraint above sweeps
    // whatever's left (exactly the rent-exempt balance, since only `total`
    // is withdrawn here) to `authority` once this handler returns, and
    // reassigns the account to the System Program — no need to also set
    // `status` here, since `close` skips normal serialization entirely and
    // that write would never be persisted.
    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= total;
    **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += amount;
    **ctx.accounts.customer.to_account_info().try_borrow_mut_lamports()? += remainder;

    Ok(())
}
