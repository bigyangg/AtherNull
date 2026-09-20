/**
 * Vendored from contracts/solana/target/types/athernull_escrow.ts — auto-generated
 * by `anchor build`, do not hand-edit. Regenerate by rebuilding the Anchor program
 * and re-copying both this file and athernullEscrow.json from contracts/solana/target/.
 *
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/athernull_escrow.json`.
 */
export type AthernullEscrow = {
  "address": "9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv",
  "metadata": {
    "name": "athernullEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "fundEscrow",
      "discriminator": [
        155,
        18,
        218,
        141,
        182,
        213,
        69,
        201
      ],
      "accounts": [
        {
          "name": "customer",
          "docs": [
            "Must match `escrow.customer`, checked via `has_one` below — only the",
            "customer named at `initialize` can fund their own escrow."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.task_id",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeEscrow",
      "discriminator": [
        243,
        160,
        77,
        153,
        11,
        92,
        48,
        209
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "Platform settlement authority — never a worker/agent key",
            "(plansol.md Sec 0)."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "escrow",
          "docs": [
            "`init` fails if a PDA for this `task_id` already exists — that's the",
            "duplicate-payment guard, not a separate check (plansol.md Sec 1)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "arg",
                "path": "taskId"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "taskId",
          "type": {
            "array": [
              "u8",
              16
            ]
          }
        },
        {
          "name": "customer",
          "type": "pubkey"
        },
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "deadline",
          "type": "i64"
        }
      ]
    },
    {
      "name": "refundEscrow",
      "discriminator": [
        107,
        186,
        89,
        99,
        26,
        194,
        23,
        204
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "`mut`: also the destination for the escrow PDA's reclaimed rent (see",
            "`close` below) — it was the payer at `initialize_escrow`, so it's the",
            "one that gets it back, on every terminal outcome, not just refund."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.task_id",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "customer",
          "writable": true,
          "relations": [
            "escrow"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "releaseEscrow",
      "discriminator": [
        146,
        253,
        129,
        233,
        20,
        145,
        181,
        206
      ],
      "accounts": [
        {
          "name": "authority",
          "docs": [
            "`mut`: also the destination for the escrow PDA's reclaimed rent (see",
            "`close` below) — it was the payer at `initialize_escrow`, so it's the",
            "one that gets it back, on every terminal outcome, not just release."
          ],
          "writable": true,
          "signer": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "escrow",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.task_id",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "recipient",
          "docs": [
            "Payout destination named by the platform authority at call time — the",
            "chain doesn't encode a payout-split policy (still open, plansol.md",
            "Sec 0), it only moves lamports where the authority points it."
          ],
          "writable": true
        },
        {
          "name": "customer",
          "docs": [
            "Receives whatever remains of `escrow.amount` after `recipient`'s cut,",
            "in the same instruction — the reconciled-actual-cost settlement model",
            "(release what was actually spent, return the rest), not a flat",
            "full-balance payout."
          ],
          "writable": true,
          "relations": [
            "escrow"
          ]
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "timeoutRefund",
      "discriminator": [
        194,
        205,
        141,
        37,
        231,
        118,
        147,
        9
      ],
      "accounts": [
        {
          "name": "escrow",
          "docs": [
            "Deliberately no signature requirement on `authority` (checked only via",
            "`has_one` below, address-only) and no signer at all beyond whichever",
            "account pays this transaction's fee — this is the permissionless",
            "fallback (plansol.md Sec 0). Anyone can trigger it once the deadline",
            "has passed, so a withheld or lost platform authority key can never",
            "strand customer funds in the escrow indefinitely. The reclaimed rent",
            "still always goes back to `authority` (it was the payer at",
            "`initialize_escrow`), not to whoever happens to call this — a",
            "deliberate choice to keep rent destination consistent across all",
            "three terminal instructions rather than turning this into a keeper",
            "reward."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              },
              {
                "kind": "account",
                "path": "escrow.task_id",
                "account": "escrow"
              }
            ]
          }
        },
        {
          "name": "customer",
          "writable": true,
          "relations": [
            "escrow"
          ]
        },
        {
          "name": "authority",
          "docs": [
            "`escrow.authority` via `has_one` — never required to sign."
          ],
          "writable": true,
          "relations": [
            "escrow"
          ]
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "escrow",
      "discriminator": [
        31,
        213,
        123,
        187,
        186,
        22,
        218,
        155
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notInitialized",
      "msg": "Escrow is not in the Initialized state"
    },
    {
      "code": 6001,
      "name": "notFunded",
      "msg": "Escrow is not in the Funded state"
    },
    {
      "code": 6002,
      "name": "unauthorized",
      "msg": "Signer is not the escrow authority"
    },
    {
      "code": 6003,
      "name": "deadlineNotReached",
      "msg": "Deadline has not yet been reached"
    },
    {
      "code": 6004,
      "name": "amountExceedsBalance",
      "msg": "Amount exceeds the escrowed balance"
    }
  ],
  "types": [
    {
      "name": "escrow",
      "docs": [
        "One escrow per task, PDA-seeded on `task_id` (see `ESCROW_SEED` in",
        "`constants.rs`) so a second `initialize` for the same task fails instead",
        "of silently creating a duplicate — that's the duplicate-payment guard,",
        "not a separate check (plansol.md Sec 1)."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "taskId",
            "docs": [
              "Matches Postgres `tasks.id` (uuid), carried as raw bytes so the",
              "on-chain account has no dependency on how Postgres generates ids."
            ],
            "type": {
              "array": [
                "u8",
                16
              ]
            }
          },
          {
            "name": "customer",
            "type": "pubkey"
          },
          {
            "name": "authority",
            "docs": [
              "Platform settlement authority (plansol.md Sec 0: \"platform authority",
              "key + timeout-to-refund\"). Never a worker/agent key."
            ],
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "escrowStatus"
              }
            }
          },
          {
            "name": "deadline",
            "docs": [
              "Unix timestamp after which `timeout_refund` becomes callable by",
              "anyone, regardless of `authority` — the fallback that keeps funds",
              "from being strandable by a withheld or lost authority key."
            ],
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "escrowStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "initialized"
          },
          {
            "name": "funded"
          },
          {
            "name": "released"
          },
          {
            "name": "refunded"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "escrowSeed",
      "docs": [
        "PDA seed prefix: `[ESCROW_SEED, task_id]` (plansol.md Sec 1)."
      ],
      "type": "bytes",
      "value": "[101, 115, 99, 114, 111, 119]"
    }
  ]
};
