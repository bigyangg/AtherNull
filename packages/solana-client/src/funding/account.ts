import { PublicKey } from "@solana/web3.js";

import {
  PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR,
  PROJECT_FUNDING_ACCOUNT_SIZE,
} from "./constants.js";

export interface ProjectFundingAccount {
  version: number;
  bindingHash: Uint8Array;
  customer: PublicKey;
  authority: PublicKey;
  requiredAmount: bigint;
  depositedAmount: bigint;
  depositCount: bigint;
  bump: number;
}

/** Decodes a ProjectFunding account's raw data. Throws on wrong size/discriminator. */
export function decodeProjectFunding(data: Uint8Array): ProjectFundingAccount {
  if (data.length !== PROJECT_FUNDING_ACCOUNT_SIZE) {
    throw new Error(`ProjectFunding account must be ${PROJECT_FUNDING_ACCOUNT_SIZE} bytes, got ${data.length}`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PROJECT_FUNDING_ACCOUNT_DISCRIMINATOR[i]) {
      throw new Error("Not a ProjectFunding account (bad discriminator)");
    }
  }
  const buf = Buffer.from(data);
  let o = 8;
  const version = buf.readUInt8(o);
  o += 1;
  const bindingHash = Uint8Array.from(buf.subarray(o, o + 32));
  o += 32;
  const customer = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const authority = new PublicKey(buf.subarray(o, o + 32));
  o += 32;
  const requiredAmount = buf.readBigUInt64LE(o);
  o += 8;
  const depositedAmount = buf.readBigUInt64LE(o);
  o += 8;
  const depositCount = buf.readBigUInt64LE(o);
  o += 8;
  const bump = buf.readUInt8(o);
  return { version, bindingHash, customer, authority, requiredAmount, depositedAmount, depositCount, bump };
}
