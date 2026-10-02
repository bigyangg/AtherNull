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

/// Phase 4E.1 project funding account. PDA seeds: `["pf", binding_hash]`.
///
/// `deposited_amount` is the authoritative funding state — it only ever
/// grows via `deposit_project_funding`, never from raw lamports sent to the
/// PDA by a plain system transfer (those are NOT deposits).
#[account]
#[derive(InitSpace)]
pub struct ProjectFunding {
    pub version: u8,
    /// SHA-256 provenance binding (see `compute_binding_hash`).
    pub binding_hash: [u8; 32],
    pub customer: Pubkey,
    /// Platform authority that initialized this account. Never a worker key.
    pub authority: Pubkey,
    pub required_amount: u64,
    pub deposited_amount: u64,
    pub deposit_count: u64,
    pub bump: u8,
}

#[cfg(test)]
mod tests {
    use sha2::{Digest, Sha256};

    /// Canonical provenance binding (ADR-0013): SHA-256(domain || 0x01 ||
    /// org[16] || project[16] || task[16] || budgetAuth[16]). The program takes the
    /// hash as an instruction argument; this test-only twin proves byte-for-byte
    /// parity with the TypeScript implementation in packages/solana-client.
    fn compute_binding_hash(
        organization: &[u8; 16],
        project: &[u8; 16],
        task: &[u8; 16],
        budget_authorization: &[u8; 16],
    ) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(crate::constants::BINDING_DOMAIN);
        h.update([crate::constants::BINDING_VERSION]);
        h.update(organization);
        h.update(project);
        h.update(task);
        h.update(budget_authorization);
        h.finalize().into()
    }

    fn uuid(s: &str) -> [u8; 16] {
        let hex: String = s.chars().filter(|c| *c != '-').collect();
        let mut out = [0u8; 16];
        for i in 0..16 {
            out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        out
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{:02x}", x)).collect()
    }

    // Shared vectors: packages/solana-client/src/funding/vectors.ts holds the
    // identical table and must produce the same hashes.
    #[test]
    fn binding_hash_vectors() {
        let h1 = compute_binding_hash(
            &uuid("00000000-0000-0000-0000-000000000001"),
            &uuid("00000000-0000-0000-0000-000000000002"),
            &uuid("00000000-0000-0000-0000-000000000003"),
            &uuid("00000000-0000-0000-0000-000000000004"),
        );
        assert_eq!(hex(&h1), "d97dd77a389263187180844ccbee8d7f6fbe6bfd368450c9f72c299faedb57e8");
        let h2 = compute_binding_hash(
            &uuid("0f8fad5b-d9cb-469f-a165-70867728950e"),
            &uuid("7c9e6679-7425-40de-944b-e07fc1f90ae7"),
            &uuid("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
            &uuid("f47ac10b-58cc-4372-a567-0e02b2c3d479"),
        );
        assert_eq!(hex(&h2), "124f563831b581f24e12bd60aa36c5dd78d088496a028775aa57e3942ff2937a");
    }
}
