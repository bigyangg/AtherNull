use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::ESCROW_SEED;
use crate::error::EscrowError;
use crate::state::{Escrow, EscrowStatus};

#[derive(Accounts)]
pub struct FundEscrow<'info> {
    /// Must match `escrow.customer`, checked via `has_one` below — only the
    /// customer named at `initialize` can fund their own escrow.
    #[account(mut)]
    pub customer: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.task_id.as_ref()],
        bump = escrow.bump,
        has_one = customer,
        constraint = escrow.status == EscrowStatus::Initialized @ EscrowError::NotInitialized,
    )]
    pub escrow: Account<'info, Escrow>,

    pub system_program: Program<'info, System>,
}

/// Transfers exactly `escrow.amount` (set at `initialize`, not caller-
/// supplied here) from the customer into the PDA, so there's no mismatch
/// between what was quoted/authorized and what actually lands on-chain.
pub fn fund_handler(ctx: Context<FundEscrow>) -> Result<()> {
    let amount = ctx.accounts.escrow.amount;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.customer.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        amount,
    )?;

    ctx.accounts.escrow.status = EscrowStatus::Funded;
    Ok(())
}
