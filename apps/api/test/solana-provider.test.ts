// Phase 4E.1 — Helius transport (standard Solana JSON-RPC) unit tests: retry
// policy, timeout, error normalization, and secret hygiene. No network, no DB.
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEVNET_GENESIS_HASH } from "@athernull/solana-client";

import { loadFundingConfig } from "../src/solana/config.js";
import { FundingError, SolanaRpcError } from "../src/solana/errors.js";
import { HeliusSolanaRpcProvider } from "../src/solana/provider.js";

const URL_WITH_KEY = "https://devnet.helius-rpc.com/?api-key=SUPER-SECRET-KEY";

function json(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function make(responses: (() => Promise<Response>)[], extra: Partial<ConstructorParameters<typeof HeliusSolanaRpcProvider>[0]> = {}) {
  const sleeps: number[] = [];
  let i = 0;
  const calls: { url: string; body: string }[] = [];
  const provider = new HeliusSolanaRpcProvider({
    url: URL_WITH_KEY,
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return next();
    }) as unknown as typeof fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...extra,
  });
  return { provider, sleeps, calls };
}

describe("HeliusSolanaRpcProvider", () => {
  test("posts standard JSON-RPC and decodes getGenesisHash", async () => {
    const { provider, calls } = make([async () => json({ jsonrpc: "2.0", id: 1, result: DEVNET_GENESIS_HASH })]);
    assert.equal(await provider.getGenesisHash(), DEVNET_GENESIS_HASH);
    assert.equal(calls[0]!.url, URL_WITH_KEY);
    assert.equal(JSON.parse(calls[0]!.body).method, "getGenesisHash");
  });

  test("getAccountInfo decodes base64 data and context slot; null value", async () => {
    const data = Buffer.from([1, 2, 3]).toString("base64");
    const a = make([async () => json({ result: { context: { slot: 77 }, value: { data: [data, "base64"], owner: "Owner", lamports: 5 } } })]);
    const r = await a.provider.getAccountInfo("addr", "finalized");
    assert.equal(r.slot, 77);
    assert.deepEqual(Array.from(r.value!.data), [1, 2, 3]);
    assert.deepEqual(JSON.parse(a.calls[0]!.body).params[1], { encoding: "base64", commitment: "finalized" });
    const b = make([async () => json({ result: { context: { slot: 78 }, value: null } })]);
    assert.equal((await b.provider.getAccountInfo("addr", "confirmed")).value, null);
  });

  test("getTransaction requests json encoding, the exact commitment, and v0 support", async () => {
    const { provider, calls } = make([async () => json({ result: null })]);
    assert.equal(await provider.getTransaction("sig", "finalized"), null);
    assert.deepEqual(JSON.parse(calls[0]!.body).params[1], { encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0 });
  });

  test("retries 429 (honouring Retry-After, capped) then succeeds", async () => {
    const { provider, sleeps } = make([
      async () => new Response("", { status: 429, headers: { "retry-after": "1" } }),
      async () => json({ result: "ok" }),
    ]);
    assert.equal(await provider.getGenesisHash(), "ok");
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0]! >= 1000 && sleeps[0]! <= 2000);
  });

  test("retries 5xx with bounded exponential backoff, then fails retriable after maxAttempts", async () => {
    const { provider, sleeps, calls } = make([async () => new Response("", { status: 503 })]);
    await assert.rejects(provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.kind === "SERVER_ERROR" && e.retriable);
    assert.equal(calls.length, 3, "bounded: exactly maxAttempts calls, no infinite loop");
    assert.equal(sleeps.length, 2);
    assert.ok(sleeps[1]! > sleeps[0]!, "backoff grows");
  });

  test("a persistent 429 surfaces RATE_LIMITED (retriable)", async () => {
    const { provider } = make([async () => new Response("", { status: 429 })]);
    await assert.rejects(provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.kind === "RATE_LIMITED" && e.retriable);
  });

  test("timeouts abort the request and surface TIMEOUT (retriable)", async () => {
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const { provider, calls } = make([], { timeoutMs: 5, maxAttempts: 2 });
    // Replace fetch with the hanging implementation.
    const p = new HeliusSolanaRpcProvider({
      url: URL_WITH_KEY,
      fetchImpl: ((url: string, init: RequestInit) => {
        calls.push({ url, body: "" });
        return hang(url, init);
      }) as unknown as typeof fetch,
      timeoutMs: 5,
      maxAttempts: 2,
      sleep: async () => {},
    });
    void provider;
    await assert.rejects(p.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.kind === "TIMEOUT" && e.retriable);
    assert.equal(calls.length, 2);
  });

  test("network errors are retriable and never echo the URL/API key", async () => {
    const { provider } = make([
      async () => {
        throw new TypeError(`fetch failed for ${URL_WITH_KEY}`);
      },
    ]);
    await assert.rejects(provider.getGenesisHash(), (e: unknown) => {
      assert.ok(e instanceof SolanaRpcError);
      assert.equal(e.kind, "NETWORK");
      assert.ok(!e.message.includes("SUPER-SECRET-KEY"));
      return true;
    });
  });

  test("JSON-RPC errors: node-unhealthy is transient; others are not retried", async () => {
    const transient = make([async () => json({ error: { code: -32005, message: "Node is unhealthy" } })]);
    await assert.rejects(transient.provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.retriable && e.rpcCode === -32005);
    assert.equal(transient.calls.length, 3);

    const permanent = make([async () => json({ error: { code: -32602, message: "Invalid params" } })]);
    await assert.rejects(permanent.provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && !e.retriable && e.kind === "RPC_ERROR");
    assert.equal(permanent.calls.length, 1);
  });

  test("unparseable bodies and missing results are non-retriable BAD_RESPONSE", async () => {
    const a = make([async () => new Response("<html>", { status: 200 })]);
    await assert.rejects(a.provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.kind === "BAD_RESPONSE");
    const b = make([async () => json({ jsonrpc: "2.0" })]);
    await assert.rejects(b.provider.getGenesisHash(), (e: unknown) => e instanceof SolanaRpcError && e.kind === "BAD_RESPONSE");
  });

  test("the total time budget stops retries early", async () => {
    const { provider, calls } = make([async () => new Response("", { status: 500 })], { totalBudgetMs: 1, maxAttempts: 5 });
    await assert.rejects(provider.getGenesisHash());
    assert.equal(calls.length, 1);
  });
});

describe("loadFundingConfig (fail closed)", () => {
  const good = {
    SOLANA_NETWORK: "devnet",
    SOLANA_RPC_PROVIDER: "helius",
    SOLANA_RPC_URL: URL_WITH_KEY,
    SOLANA_FUNDING_PROGRAM_ID: "9isSF5USV3WURyJaKLtvcd82W2txUQnFDaRz6WK8Vcjv",
    SOLANA_AUTHORITY_PUBKEY: "AMWem7ejFqbAna11U8BGxckyRWH2LdKWs6rA75LDAwFb",
  } as NodeJS.ProcessEnv;

  test("accepts a complete devnet config with the 50_000_000 lamport default", () => {
    const c = loadFundingConfig(good);
    assert.equal(c.network, "devnet");
    assert.equal(c.requiredLamports, 50_000_000n);
    assert.equal(c.genesisHash, DEVNET_GENESIS_HASH);
    assert.throws(() => c.loadAuthority(), FundingError); // no secret configured
  });

  test("rejects mainnet-beta, testnet, unknown, and unset networks", () => {
    for (const n of ["mainnet-beta", "mainnet", "testnet", "localnet", "Devnet", undefined]) {
      assert.throws(() => loadFundingConfig({ ...good, SOLANA_NETWORK: n }), /devnet only/);
    }
  });

  test("rejects a non-helius provider, missing/invalid URL, http, and non-devnet hostnames", () => {
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_RPC_PROVIDER: "quicknode" }));
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_RPC_URL: undefined }));
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_RPC_URL: "not a url" }));
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_RPC_URL: "http://devnet.helius-rpc.com/?api-key=x" }));
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=x" }));
  });

  test("rejects bad program ids and bad demo amounts", () => {
    assert.throws(() => loadFundingConfig({ ...good, SOLANA_FUNDING_PROGRAM_ID: "nope" }));
    for (const bad of ["0", "-5", "1.5", "0.05", "abc", "99999999999"]) {
      assert.throws(() => loadFundingConfig({ ...good, SOLANA_DEMO_REQUIRED_LAMPORTS: bad }), /lamports|cap/i);
    }
    assert.equal(loadFundingConfig({ ...good, SOLANA_DEMO_REQUIRED_LAMPORTS: "123" }).requiredLamports, 123n);
  });

  test("a malformed authority secret never appears in the error", () => {
    const c = loadFundingConfig({ ...good, SOLANA_AUTHORITY_KEYPAIR: "[1,2,3] TOP-SECRET" });
    assert.throws(
      () => c.loadAuthority(),
      (e: unknown) => e instanceof FundingError && !e.message.includes("TOP-SECRET"),
    );
  });
});
