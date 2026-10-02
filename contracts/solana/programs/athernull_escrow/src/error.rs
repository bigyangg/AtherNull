use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Escrow is not in the Initialized state")]
    NotInitialized,
    #[msg("Escrow is not in the Funded state")]
    NotFunded,
    #[msg("Signer is not the escrow authority")]
    Unauthorized,
    #[msg("Deadline has not yet been reached")]
    DeadlineNotReached,
    #[msg("Amount exceeds the escrowed balance")]
    AmountExceedsBalance,
    // --- ProjectFunding (4E.1). Appended, never reordered: legacy error
    // codes above must keep their numeric values.
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Required amount must be greater than zero")]
    InvalidRequiredAmount,
    #[msg("Customer must be a non-default pubkey")]
    InvalidCustomer,
}
