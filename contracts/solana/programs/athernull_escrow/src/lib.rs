pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv");

#[program]
pub mod athernull_escrow {
    use super::*;

    pub fn initialize_escrow(
        ctx: Context<InitializeEscrow>,
        task_id: [u8; 16],
        customer: Pubkey,
        amount: u64,
        deadline: i64,
    ) -> Result<()> {
        initialize::initialize_handler(ctx, task_id, customer, amount, deadline)
    }

    pub fn fund_escrow(ctx: Context<FundEscrow>) -> Result<()> {
        fund::fund_handler(ctx)
    }

    pub fn release_escrow(ctx: Context<ReleaseEscrow>, amount: u64) -> Result<()> {
        release::release_handler(ctx, amount)
    }

    pub fn refund_escrow(ctx: Context<RefundEscrow>) -> Result<()> {
        refund::refund_handler(ctx)
    }

    pub fn timeout_refund(ctx: Context<TimeoutRefund>) -> Result<()> {
        timeout_refund::timeout_refund_handler(ctx)
    }

    // --- Phase 4E.1 ProjectFunding (additive; legacy escrow above untouched).
    pub fn initialize_project_funding(
        ctx: Context<InitializeProjectFunding>,
        binding_hash: [u8; 32],
        customer: Pubkey,
        required_amount: u64,
    ) -> Result<()> {
        project_funding::initialize_project_funding_handler(
            ctx,
            binding_hash,
            customer,
            required_amount,
        )
    }

    pub fn deposit_project_funding(ctx: Context<DepositProjectFunding>, amount: u64) -> Result<()> {
        project_funding::deposit_project_funding_handler(ctx, amount)
    }
}
