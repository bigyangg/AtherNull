import { createHash } from "node:crypto";

import { PublicKey } from "@solana/web3.js";

import { BINDING_DOMAIN, BINDING_VERSION, PROJECT_FUNDING_SEED } from "./constants.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Canonical 16 raw bytes of a UUID. Throws on anything that isn't a canonical hyphenated UUID. */
export function uuidToBytes(uuid: string): Uint8Array {
  if (!UUID_RE.test(uuid)) throw new Error(`Not a canonical UUID: ${uuid}`);
  return Uint8Array.from(Buffer.from(uuid.replace(/-/g, ""), "hex"));
}

export interface ProvenanceIds {
  organizationId: string;
  projectId: string;
  taskId: string;
  budgetAuthorizationId: string;
}

/**
 * SHA-256( "athernull:project-funding:v1" || 0x01 || org[16] || project[16]
 * || task[16] || budgetAuthorization[16] ). No JSON, no string seeds. The
 * Rust twin is `compute_binding_hash` in the program's state module; the
 * shared vectors (vectors.ts) prove they agree.
 */
export function computeBindingHash(ids: ProvenanceIds): Uint8Array {
  const hash = createHash("sha256");
  hash.update(Buffer.from(BINDING_DOMAIN, "utf8"));
  hash.update(Buffer.from([BINDING_VERSION]));
  hash.update(uuidToBytes(ids.organizationId));
  hash.update(uuidToBytes(ids.projectId));
  hash.update(uuidToBytes(ids.taskId));
  hash.update(uuidToBytes(ids.budgetAuthorizationId));
  return Uint8Array.from(hash.digest());
}

/** PDA = findProgramAddress(["pf", bindingHash], programId). */
export function deriveProjectFundingPda(
  programId: PublicKey,
  bindingHash: Uint8Array,
): [PublicKey, number] {
  if (bindingHash.length !== 32) throw new Error("bindingHash must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [Buffer.from(PROJECT_FUNDING_SEED, "utf8"), Buffer.from(bindingHash)],
    programId,
  );
}

export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
export function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
