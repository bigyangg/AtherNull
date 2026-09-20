use anchor_lang::prelude::*;

use crate::constants::ESCROW_SEED;
use crate::state::{Escrow, EscrowStatus};

#[derive(Accounts)]
#[instruction(task_id: [u8; 16])]
pub struct InitializeEscrow<'info> {
    /// Platform settlement authority — never a worker/agent key
    /// (plansol.md Sec 0).
    #[account(mut)]
    pub authority: Signer<'info>,

    /// `init` fails if a PDA for this `task_id` already exists — that's the
    /// duplicate-payment guard, not a separate check (plansol.md Sec 1).
    #[account(
        init,
        payer = authority,
        space = 8 + Escrow::INIT_SPACE,
        seeds = [ESCROW_SEED, task_id.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_handler(
    ctx: Context<InitializeEscrow>,
    task_id: [u8; 16],
    customer: Pubkey,
    amount: u64,
    deadline: i64,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    escrow.task_id = task_id;
    escrow.customer = customer;
    escrow.authority = ctx.accounts.authority.key();
    escrow.amount = amount;
    escrow.status = EscrowStatus::Initialized;
    escrow.deadline = deadline;
    escrow.bump = ctx.bumps.escrow;
    Ok(())
}
