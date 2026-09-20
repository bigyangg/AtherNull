use anchor_lang::prelude::*;

use crate::constants::ESCROW_SEED;
use crate::error::EscrowError;
use crate::state::{Escrow, EscrowStatus};

#[derive(Accounts)]
pub struct RefundEscrow<'info> {
    /// `mut`: also the destination for the escrow PDA's reclaimed rent (see
    /// `close` below) — it was the payer at `initialize_escrow`, so it's the
    /// one that gets it back, on every terminal outcome, not just refund.
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

    #[account(mut)]
    pub customer: SystemAccount<'info>,
}

pub fn refund_handler(ctx: Context<RefundEscrow>) -> Result<()> {
    let total = ctx.accounts.escrow.amount;

    // Only the funded amount moves here — `close = authority` above sweeps
    // the remaining rent-exempt balance to `authority` once this handler
    // returns (see release_handler's comment for why no `status` write is
    // needed: `close` skips normal serialization).
    **ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= total;
    **ctx.accounts.customer.to_account_info().try_borrow_mut_lamports()? += total;

    Ok(())
}
