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
}
