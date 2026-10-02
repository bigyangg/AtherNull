"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  devnetExplorerAddressUrl,
  devnetExplorerTxUrl,
  formatDevnetSol,
  type ProjectFundingView,
} from "@athernull/contracts";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { Connection, Transaction } from "@solana/web3.js";
import { ExternalLink, Rocket, Wallet } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { IconBadge } from "@/components/icon-badge";
import {
  useCreateProjectFunding,
  usePrepareProjectFunding,
  useProjectFunding,
  useVerifyProjectFunding,
} from "@/lib/hooks/use-project-funding";
import { useFundTask } from "@/lib/hooks/use-tasks";

// Phase 4E.1 — Project Funding (Solana Devnet) and "Activate Build".
//
// Customer-facing wording: "Project Funding", "Fund Project", "Awaiting
// funding", "Partially funded", "Funded", "Activate Build". Never the word
// "Escrow" (settlement/refund semantics belong to Phase 4E.2), never a USD
// equivalent, and the network is always labelled "Solana Devnet".
//
// The browser wallet signs and sends the deposit; this component never sees
// a private key. The RPC key lives only in apps/api — the wallet adapter's
// connection below is the PUBLIC devnet endpoint, used only so the wallet
// knows which chain to sign for. AtherNull's own verification (finalized
// chain state, via apps/api) is the only thing that credits funding.

const WALLET_DEVNET_ENDPOINT = "https://api.devnet.solana.com";
const POLL_MS = 3_000;
const POLL_MAX_MS = 3 * 60_000;

const STATUS_LABEL: Record<ProjectFundingView["status"], string> = {
  AWAITING_FUNDS: "Awaiting funding",
  PARTIALLY_FUNDED: "Partially funded",
  FUNDED: "Funded",
};

// Strict decimal SOL -> lamports with no floating point.
function solToLamports(input: string): string | null {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(input.trim());
  if (!m) return null;
  const lamports = BigInt(m[1]!) * 1_000_000_000n + BigInt((m[2] ?? "").padEnd(9, "0") || "0");
  return lamports > 0n ? lamports.toString() : null;
}

function short(address: string) {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function FundingBody({ taskId }: { taskId: string }) {
  const { data: funding, isLoading, error: loadError } = useProjectFunding(taskId);
  const createFunding = useCreateProjectFunding(taskId);
  const prepare = usePrepareProjectFunding(taskId);
  const verify = useVerifyProjectFunding(taskId);
  const activate = useFundTask();
  const { wallets, wallet, publicKey, connected, connecting, select, connect, disconnect, sendTransaction } = useWallet();

  const [amountInput, setAmountInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [observed, setObserved] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "preparing" | "signing" | "confirming">(null);
  const connection = useMemo(() => new Connection(WALLET_DEVNET_ENDPOINT, "confirmed"), []);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong.");

  // Poll AtherNull's own verification (never the browser's idea of success)
  // until the signature is credited at FINALIZED, or the window elapses.
  const confirmSignature = useCallback(
    async (signature: string) => {
      setBusy("confirming");
      const started = Date.now();
      while (!cancelled.current && Date.now() - started < POLL_MAX_MS) {
        try {
          const res = await verify.mutateAsync(signature);
          const outcome = res.signature?.outcome;
          if (outcome === "CREDITED" || outcome === "ALREADY_CREDITED") {
            setPendingSignature(null);
            setObserved(null);
            setBusy(null);
            return;
          }
          const c = res.signature?.observedCommitment;
          setObserved(c === "confirmed" ? "confirmed — finalizing" : c === "processed" ? "processed" : c === "finalized" ? "finalized — verifying" : null);
        } catch (err) {
          const msg = message(err);
          // Retriable verification trouble: keep polling; anything else stops.
          if (!/VERIFICATION_UNAVAILABLE|retriable/i.test(msg)) {
            setError(msg);
            setBusy(null);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }
      setBusy(null);
      if (!cancelled.current) setError("Still waiting for Solana to finalize. Use “Check funding” in a moment.");
    },
    [verify],
  );

  async function handleCreate() {
    setError(null);
    try {
      await createFunding.mutateAsync();
    } catch (err) {
      setError(message(err));
    }
  }

  async function handleFund() {
    setError(null);
    if (!publicKey) {
      setError("Connect a wallet first.");
      return;
    }
    let amountLamports: string | undefined;
    if (amountInput.trim() !== "") {
      const parsed = solToLamports(amountInput);
      if (!parsed) {
        setError("Enter a devnet SOL amount like 0.02.");
        return;
      }
      amountLamports = parsed;
    }
    try {
      setBusy("preparing");
      let res = await prepare.mutateAsync({ customerWallet: publicKey.toBase58(), amountLamports });
      // The on-chain account may still be initializing; retry a few times.
      for (let i = 0; i < 6 && res.state === "INITIALIZING"; i++) {
        await new Promise((r) => setTimeout(r, 2_000));
        res = await prepare.mutateAsync({ customerWallet: publicKey.toBase58(), amountLamports });
      }
      if (res.state !== "READY" || !res.transaction) {
        setBusy(null);
        setError("The project account is still being created on Solana Devnet. Try again in a moment.");
        return;
      }
      setBusy("signing");
      const tx = Transaction.from(Uint8Array.from(atob(res.transaction.base64), (c) => c.charCodeAt(0)));
      const signature = await sendTransaction(tx, connection);
      setPendingSignature(signature);
      await confirmSignature(signature);
    } catch (err) {
      setBusy(null);
      setError(message(err));
    }
  }

  async function handleCheck() {
    setError(null);
    try {
      setBusy("confirming");
      await verify.mutateAsync(pendingSignature ?? undefined);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function handleActivate() {
    setError(null);
    try {
      await activate.mutateAsync(taskId);
    } catch (err) {
      setError(message(err));
    }
  }

  const status = funding?.status;
  const funded = status === "FUNDED";

  return (
    <Card>
      <CardHeader className="flex-row items-center gap-3 space-y-0">
        <IconBadge>
          <Wallet />
        </IconBadge>
        <CardTitle className="text-base">Project Funding</CardTitle>
        {status && (
          <Badge variant={funded ? "success" : "muted"} className="ml-auto">
            {STATUS_LABEL[status]}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Network</dt>
          <dd>Solana Devnet</dd>
          <dt className="text-muted-foreground">Required</dt>
          <dd>{funding ? `${formatDevnetSol(funding.requiredLamports)} devnet SOL` : "0.05 devnet SOL"}</dd>
          <dt className="text-muted-foreground">Received</dt>
          <dd>{funding ? `${formatDevnetSol(funding.confirmedLamports)} devnet SOL` : "0.00 devnet SOL"}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{status ? STATUS_LABEL[status] : "Awaiting funding"}</dd>
        </dl>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading funding…</p>
        ) : loadError ? (
          <p className="text-sm text-destructive">{message(loadError)}</p>
        ) : !funding ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              This build is prepared but not yet active. Create its project account on Solana Devnet, fund it with test
              value only, then activate the build.
            </p>
            <div>
              <Button disabled={createFunding.isPending} onClick={handleCreate}>
                {createFunding.isPending ? "Creating…" : "Create Project Account"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Project Account</span>
              <a
                className="inline-flex items-center gap-1 break-all text-primary underline-offset-4 hover:underline"
                href={devnetExplorerAddressUrl(funding.onchainAccount)}
                target="_blank"
                rel="noreferrer"
              >
                {funding.onchainAccount}
                <ExternalLink className="size-3 shrink-0" />
              </a>
              <span className="text-xs text-muted-foreground">View on Solana Explorer (Devnet)</span>
            </div>

            {funding.deposits.length > 0 && (
              <div className="flex flex-col gap-1 text-sm">
                <span className="text-muted-foreground">Funding transactions</span>
                {funding.deposits.map((d) => (
                  <a
                    key={d.signature}
                    className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                    href={devnetExplorerTxUrl(d.signature)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatDevnetSol(d.amountLamports)} devnet SOL · {short(d.signature)}
                    <ExternalLink className="size-3 shrink-0" />
                  </a>
                ))}
              </div>
            )}

            {!funded && (
              <div className="flex flex-col gap-3">
                {!connected ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {wallets.filter((w) => w.readyState === "Installed").length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        No Solana wallet detected. Install a wallet (set to Devnet) and reload.
                      </p>
                    ) : (
                      wallets
                        .filter((w) => w.readyState === "Installed")
                        .map((w) => (
                          <Button
                            key={w.adapter.name}
                            variant="outline"
                            disabled={connecting}
                            onClick={async () => {
                              setError(null);
                              try {
                                select(w.adapter.name);
                                await w.adapter.connect();
                              } catch (err) {
                                setError(message(err));
                              }
                            }}
                          >
                            Connect Wallet · {w.adapter.name}
                          </Button>
                        ))
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">Wallet</span>
                    <span>{wallet?.adapter.name} · {publicKey ? short(publicKey.toBase58()) : ""}</span>
                    <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
                      Disconnect
                    </Button>
                  </div>
                )}

                {connected && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      className="w-48"
                      inputMode="decimal"
                      placeholder="Amount (devnet SOL) — optional"
                      value={amountInput}
                      onChange={(e) => setAmountInput(e.target.value)}
                    />
                    <Button disabled={busy !== null} onClick={handleFund}>
                      {busy === "preparing"
                        ? "Preparing…"
                        : busy === "signing"
                          ? "Waiting for wallet…"
                          : busy === "confirming"
                            ? "Confirming on Solana…"
                            : "Fund Project"}
                    </Button>
                    <Button variant="ghost" disabled={busy !== null} onClick={handleCheck}>
                      Check funding
                    </Button>
                  </div>
                )}
                {busy === "confirming" && (
                  <p className="text-sm text-muted-foreground">
                    Confirming on Solana{observed ? ` (${observed})` : ""}… funding is credited only once Solana finalizes
                    the transaction and AtherNull verifies it.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">Test value only — Solana Devnet. No real funds.</p>
              </div>
            )}

            {funded && (
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Funding verified. Activating queues the build for execution.</p>
                <Button disabled={activate.isPending} onClick={handleActivate}>
                  <Rocket />
                  {activate.isPending ? "Activating…" : "Activate Build"}
                </Button>
              </div>
            )}
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

export function ProjectFundingPanel({ taskId }: { taskId: string }) {
  // Standard (wallet-standard) wallets self-register, so no adapter list is
  // needed. The provider wraps only this panel, never the rest of the app.
  return (
    <ConnectionProvider endpoint={WALLET_DEVNET_ENDPOINT}>
      <WalletProvider wallets={[]} autoConnect={false}>
        <FundingBody taskId={taskId} />
      </WalletProvider>
    </ConnectionProvider>
  );
}
