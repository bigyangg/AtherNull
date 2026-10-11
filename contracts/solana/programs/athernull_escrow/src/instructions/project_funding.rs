use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::constants::{PROJECT_FUNDING_SEED, PROJECT_FUNDING_VERSION};
use crate::error::EscrowError;
use crate::state::ProjectFunding;

#[derive(Accounts)]
#[instruction(binding_hash: [u8; 32])]
pub struct InitializeProjectFunding<'info> {
    /// Platform authority — pays rent, never a worker/agent key. Because
    /// only this signer can create the account, on-chain state (customer,
    /// required amount, binding) is trustworthy by construction.
    #[account(mut)]
    pub authority: Signer<'info>,

    /// `init` fails if the PDA for this binding already exists — duplicate
    /// initialization is impossible, not just checked.
    #[account(
        init,
        payer = authority,
        space = 8 + ProjectFunding::INIT_SPACE,
        seeds = [PROJECT_FUNDING_SEED, binding_hash.as_ref()],
        bump,
    )]
    pub project_funding: Account<'info, ProjectFunding>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_project_funding_handler(
    ctx: Context<InitializeProjectFunding>,
    binding_hash: [u8; 32],
    customer: Pubkey,
    required_amount: u64,
) -> Result<()> {
    require!(required_amount > 0, EscrowError::InvalidRequiredAmount);
    require!(customer != Pubkey::default(), EscrowError::InvalidCustomer);

    let pf = &mut ctx.accounts.project_funding;
    pf.version = PROJECT_FUNDING_VERSION;
    pf.binding_hash = binding_hash;
    pf.customer = customer;
    pf.authority = ctx.accounts.authority.key();
    pf.required_amount = required_amount;
    pf.deposited_amount = 0;
    pf.deposit_count = 0;
    pf.bump = ctx.bumps.project_funding;
    Ok(())
}

#[derive(Accounts)]
pub struct DepositProjectFunding<'info> {
    /// Must be the customer bound at initialization (`has_one`).
    #[account(mut)]
    pub customer: Signer<'info>,

    #[account(
        mut,
        seeds = [PROJECT_FUNDING_SEED, project_funding.binding_hash.as_ref()],
        bump = project_funding.bump,
        has_one = customer,
    )]
    pub project_funding: Account<'info, ProjectFunding>,

    pub system_program: Program<'info, System>,
}

pub fn deposit_project_funding_handler(
    ctx: Context<DepositProjectFunding>,
    amount: u64,
) -> Result<()> {
    let (new_deposited, new_count) = apply_deposit(
        ctx.accounts.project_funding.deposited_amount,
        ctx.accounts.project_funding.deposit_count,
        amount,
    )?;

    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            Transfer {
                from: ctx.accounts.customer.to_account_info(),
                to: ctx.accounts.project_funding.to_account_info(),
            },
        ),
        amount,
    )?;

    let pf = &mut ctx.accounts.project_funding;
    pf.deposited_amount = new_deposited;
    pf.deposit_count = new_count;
    Ok(())
}

// --- Phase 4E.2: settlement and refund. Both are platform-authority-only
// and both close the account, so a funding account can be paid out at most
// once — a second settle/refund fails on the missing account, which is the
// on-chain half of settlement idempotency (Postgres holds the other half).

#[derive(Accounts)]
pub struct SettleProjectFunding<'info> {
    /// Must be the authority recorded at initialization. `mut`: it paid the
    /// rent, so it receives the rent back when the account closes.
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PROJECT_FUNDING_SEED, project_funding.binding_hash.as_ref()],
        bump = project_funding.bump,
        has_one = authority @ EscrowError::Unauthorized,
        has_one = customer,
        close = authority,
    )]
    pub project_funding: Account<'info, ProjectFunding>,

    /// Provider payout destination, named by the authority at call time.
    #[account(mut)]
    pub recipient: SystemAccount<'info>,

    /// Bound customer; receives whatever of the deposit is not released.
    #[account(mut)]
    pub customer: SystemAccount<'info>,
}

/// Pays `release_amount` of the deposit to `recipient`, returns the rest of
/// the deposit to the customer, and closes the account. Only deposited value
/// moves — lamports sent to the PDA outside `deposit_project_funding` are not
/// deposits and go back to the authority with the rent on close.
pub fn settle_project_funding_handler(ctx: Context<SettleProjectFunding>, release_amount: u64) -> Result<()> {
    let deposited = ctx.accounts.project_funding.deposited_amount;
    let remainder = split_settlement(deposited, release_amount)?;

    **ctx.accounts.project_funding.to_account_info().try_borrow_mut_lamports()? -= deposited;
    **ctx.accounts.recipient.to_account_info().try_borrow_mut_lamports()? += release_amount;
    **ctx.accounts.customer.to_account_info().try_borrow_mut_lamports()? += remainder;
    Ok(())
}

#[derive(Accounts)]
pub struct RefundProjectFunding<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [PROJECT_FUNDING_SEED, project_funding.binding_hash.as_ref()],
        bump = project_funding.bump,
        has_one = authority @ EscrowError::Unauthorized,
        has_one = customer,
        close = authority,
    )]
    pub project_funding: Account<'info, ProjectFunding>,

    #[account(mut)]
    pub customer: SystemAccount<'info>,
}

/// Returns the full deposit to the customer and closes the account.
pub fn refund_project_funding_handler(ctx: Context<RefundProjectFunding>) -> Result<()> {
    let deposited = ctx.accounts.project_funding.deposited_amount;
    **ctx.accounts.project_funding.to_account_info().try_borrow_mut_lamports()? -= deposited;
    **ctx.accounts.customer.to_account_info().try_borrow_mut_lamports()? += deposited;
    Ok(())
}

/// Settlement split: the released part may not exceed the deposit. Returns
/// the remainder owed back to the customer.
pub fn split_settlement(deposited: u64, release_amount: u64) -> Result<u64> {
    require!(release_amount <= deposited, EscrowError::SettlementExceedsDeposit);
    Ok(deposited - release_amount)
}

/// Pure deposit arithmetic: amount must be > 0 and neither counter may
/// overflow. Split out so overflow handling is unit-testable without
/// needing 2^64 lamports on a validator.
pub fn apply_deposit(deposited: u64, count: u64, amount: u64) -> Result<(u64, u64)> {
    require!(amount > 0, EscrowError::ZeroAmount);
    let new_deposited = deposited.checked_add(amount).ok_or(EscrowError::Overflow)?;
    let new_count = count.checked_add(1).ok_or(EscrowError::Overflow)?;
    Ok((new_deposited, new_count))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deposit_accumulates() {
        assert_eq!(apply_deposit(0, 0, 20).unwrap(), (20, 1));
        assert_eq!(apply_deposit(20, 1, 15).unwrap(), (35, 2));
    }

    #[test]
    fn zero_deposit_rejected() {
        assert!(apply_deposit(5, 1, 0).is_err());
    }

    #[test]
    fn deposited_overflow_rejected() {
        assert!(apply_deposit(u64::MAX, 1, 1).is_err());
        assert!(apply_deposit(u64::MAX - 1, 1, 2).is_err());
        assert_eq!(apply_deposit(u64::MAX - 1, 1, 1).unwrap(), (u64::MAX, 2));
    }

    #[test]
    fn count_overflow_rejected() {
        assert!(apply_deposit(0, u64::MAX, 1).is_err());
    }

    #[test]
    fn settlement_split() {
        assert_eq!(split_settlement(100, 60).unwrap(), 40);
        assert_eq!(split_settlement(100, 100).unwrap(), 0);
        assert_eq!(split_settlement(100, 0).unwrap(), 100);
        assert!(split_settlement(100, 101).is_err());
    }
}
