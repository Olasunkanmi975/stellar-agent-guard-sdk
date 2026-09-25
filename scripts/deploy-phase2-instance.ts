/**
 * Bring up (or re-verify) the Phase 2 testnet deployment.
 *
 * Deploys a **fresh guard instance of the exact WASM hash Phase 1 deployed**
 * (`f47919f9…`), with keys generated and held by this script, plus a dedicated
 * SAC test token. The Phase 1 instance (`CAYJZT4X…`) is deliberately never
 * touched: it is the historical dead-man-switch evidence and is frozen by its
 * own switch, which is exactly what Phase 1 set out to demonstrate.
 *
 * The script is idempotent. Existing keys, token, guard instance and on-chain
 * state are detected and reused, so iterating on the SDK does not spawn a new
 * deployment each run. Every write it does perform is a real testnet
 * transaction, and it refuses to report success unless each one lands on a
 * ledger.
 *
 * Usage:
 *   node scripts/deploy-phase2-instance.ts [--json] [--rpc URL]
 *
 * Outputs:
 *   tests/fixtures/phase2-instance.json   public addresses + tx hashes (committed)
 *   .env.phase2                           secret keys (gitignored)
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { invoke } from "../src/invoke.ts";
import { policyToScVal, type PolicyConfig } from "../src/policy.ts";
import { summarizeDiagnosticEvents } from "../src/tx.ts";
import { assertFixtureSchema } from "../tests/integration/harness.ts";
import { json, parseArgs, verifyWasmIdentity } from "./inspect-deployment.ts";

/** The Phase 1 artifact — the same bytes must be deployed for Phase 2. */
const PHASE1_WASM_HASH = "f47919f92e78fdd034836aa61955fc338dd56a218c448c37df1867a8c3da0f63";
const PHASE1_GUARD = "CAYJZT4XH5SWDXNR7MZJCCUBIDAT2KZDDUTZ7OZQEMKCPJGD4P3X4CU7";
const TESTNET_RPC = "https://soroban-testnet.stellar.org";
const TESTNET_PASSPHRASE = Networks.TESTNET;
const ENV_PATH = ".env.phase2";
const FIXTURES_PATH = "tests/fixtures/phase2-instance.json";

/** Deterministic salt: the guard address is reproducible from the admin key. */
const GUARD_SALT = createHash("sha256").update("stellar-agent-guard:phase2:guard:1").digest();
const ASSET_CODE = "P2GUARD";
const MINT_AMOUNT = 100_000n;
const TRUSTLINE_LIMIT = 1_000_000n;

const ENV_KEYS = {
  guard: "PHASE2_GUARD",
  token: "PHASE2_TOKEN",
  rpcUrl: "PHASE2_RPC_URL",
  admin: "PHASE2_ADMIN_SECRET",
  agent: "PHASE2_AGENT_SECRET",
  issuer: "PHASE2_ISSUER_SECRET",
  recipient: "PHASE2_RECIPIENT_SECRET",
  outsider: "PHASE2_OUTSIDER_SECRET",
} as const;

/** Policy installed on the Phase 2 enforcement instance. */
function enforcementPolicy(token: string, recipient: string): PolicyConfig {
  return {
    per_tx_cap: 1_000n,
    window_secs: 60n,
    window_cap: 150n,
    assets: [token],
    protocols: [],
    recipients: [recipient],
    allow_any_recipient: false,
    active_from: 0n,
    active_until: 0n,
    paused: false,
    // Dead-man switch stays off on the enforcement instance: freeze/unfreeze is
    // exercised on a separate dedicated instance so a frozen account can never
    // collide with enforcement tests.
    dms_grace_secs: 0n,
  };
}

interface Keys {
  admin: Keypair;
  agent: Keypair;
  issuer: Keypair;
  recipient: Keypair;
  outsider: Keypair;
}

// ── environment persistence ──────────────────────────────────────────────

async function readEnv(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(ENV_PATH, "utf8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index > 0) out[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
    return out;
  } catch {
    return {};
  }
}

async function writeEnv(
  keys: Keys,
  deployment: { guard: string; token: string },
  rpcUrl: string,
): Promise<void> {
  await writeFile(
    ENV_PATH,
    [
      "# Phase 2 testnet secrets — written by scripts/deploy-phase2-instance.ts",
      "# Testnet only. Never reuse these keys on any other network.",
      `${ENV_KEYS.guard}=${deployment.guard}`,
      `${ENV_KEYS.token}=${deployment.token}`,
      `${ENV_KEYS.rpcUrl}=${rpcUrl}`,
      `${ENV_KEYS.admin}=${keys.admin.secret()}`,
      `${ENV_KEYS.agent}=${keys.agent.secret()}`,
      `${ENV_KEYS.issuer}=${keys.issuer.secret()}`,
      `${ENV_KEYS.recipient}=${keys.recipient.secret()}`,
      `${ENV_KEYS.outsider}=${keys.outsider.secret()}`,
      "",
    ].join("\n"),
  );
}

/**
 * Read the fixture file if it exists, so a re-run extends the record instead of
 * replacing it.
 */
async function readFixture(): Promise<FixtureFile | null> {
  try {
    return JSON.parse(await readFile(FIXTURES_PATH, "utf8")) as FixtureFile;
  } catch {
    return null;
  }
}

/**
 * Merge freshly created records into the existing ones. Existing entries win:
 * a transaction that created part of this deployment happened once, and its hash
 * must survive every subsequent run.
 */
function mergeTransactionRecords(
  existing: TransactionRecords | undefined,
  created: TransactionRecords,
): TransactionRecords {
  const merged: TransactionRecords = { ...existing };
  for (const [key, record] of Object.entries(created) as Array<
    [TransactionKey, TransactionRecord]
  >) {
    if (merged[key]) continue;
    merged[key] = record;
  }
  return merged;
}

/**
 * Re-read one recorded transaction from the RPC. Returns a fresh verification
 * stamp plus whether the hash is confirmed SUCCESS on chain.
 */
async function reVerify(
  server: rpc.Server,
  hash: string,
): Promise<{ success: boolean; stamp: NonNullable<TransactionRecord["lastVerified"]> }> {
  const result = await server.getTransaction(hash).catch(() => null);
  const status = result?.status ?? "NOT_FOUND";
  return {
    success: status === rpc.Api.GetTransactionStatus.SUCCESS,
    stamp: {
      at: new Date().toISOString(),
      status,
      ledger: result && "ledger" in result ? (result.ledger ?? null) : null,
    },
  };
}

/**
 * Re-read every recorded one-time bring-up transaction and stamp the result.
 * This is what makes the fixture self-verifying: anyone can re-run the bring-up
 * script and see each recorded hash independently confirmed on chain.
 */
async function verifyTransactionRecords(
  server: rpc.Server,
  records: TransactionRecords,
): Promise<{ records: TransactionRecords; allSuccess: boolean }> {
  let allSuccess = true;
  const verified: TransactionRecords = {};
  for (const [key, record] of Object.entries(records) as Array<
    [TransactionKey, TransactionRecord]
  >) {
    const { success, stamp } = await reVerify(server, record.hash);
    if (!success) allSuccess = false;
    verified[key] = { ...record, lastVerified: stamp };
  }
  return { records: verified, allSuccess };
}

/**
 * Mint records are append-only and keyed by their own hash, so each top-up that
 * actually broadcast stays on the record. Merge keeps every existing entry and
 * adds only hashes that are not already present.
 */
function mergeMints(previous: MintRecord[], created: MintRecord[]): MintRecord[] {
  const merged = [...previous];
  const seen = new Set(merged.map((entry) => entry.hash));
  for (const entry of created) {
    if (seen.has(entry.hash)) continue;
    seen.add(entry.hash);
    merged.push(entry);
  }
  return merged;
}

/**
 * Every mint this deployment has ever broadcast.
 *
 * The fixture used to keep a single `transactions.mint` slot that the top-up
 * step overwrote, which is the same evidence-loss failure mode as the original
 * overwrite bug: re-running bring-up after the integration suite had spent funds
 * minted again and silently replaced the previous hash. The legacy slot is
 * migrated into this list rather than dropped, so no historical mint is lost.
 */
function previousMints(existing: FixtureFile | null): MintRecord[] {
  const instance = existing?.phase2EnforcementInstance;
  const list = [...(instance?.mints ?? [])];
  const legacy = instance?.transactions?.mint;
  if (legacy && !list.some((entry) => entry.hash === legacy.hash)) {
    // No amount/balanceBefore: the old slot never recorded them.
    list.push({ ...legacy });
  }
  return list;
}

/** Re-read every recorded mint, same standard as the bring-up transactions. */
async function verifyMints(
  server: rpc.Server,
  mints: MintRecord[],
): Promise<{ records: MintRecord[]; allSuccess: boolean }> {
  let allSuccess = true;
  const verified: MintRecord[] = [];
  for (const mint of mints) {
    const { success, stamp } = await reVerify(server, mint.hash);
    if (!success) allSuccess = false;
    verified.push({ ...mint, lastVerified: stamp });
  }
  return { records: verified, allSuccess };
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── chain helpers ────────────────────────────────────────────────────────

async function fund(server: rpc.Server, publicKey: string): Promise<void> {
  try {
    await server.fundAddress(publicKey);
    return;
  } catch {
    const response = await fetch(
      `https://friendbot.stellar.org?addr=${encodeURIComponent(publicKey)}`,
    );
    if (!response.ok) {
      throw new Error(`friendbot funding failed for ${publicKey}: HTTP ${response.status}`);
    }
  }
}

/** Read a contract view function via simulation (no ledger mutation). */
async function readContract(
  server: rpc.Server,
  contractId: string,
  fn: string,
  args: xdr.ScVal[],
  sourceAddress: string,
): Promise<{ value?: unknown; error?: string }> {
  const account = await server.getAccount(sourceAddress);
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(Operation.invokeContractFunction({ contract: contractId, function: fn, args }))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    return { error: typeof sim.error === "string" ? sim.error : JSON.stringify(sim.error) };
  }
  const retval = (sim as rpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  return { value: retval === undefined ? null : (scValToNative(retval) as unknown) };
}

/**
 * Does the deployed instance already have `initialize` recorded?
 *
 * The instance's storage is read through its serialised form: the SDK's XDR
 * classes expose values as class instances whose property names differ from
 * their wire form, and the JSON form is both stable and exactly what the
 * ledger holds (`DataKey::Initialized` serialises as `[Symbol("Initialized")]`).
 */
async function isInitialized(server: rpc.Server, guard: string): Promise<boolean> {
  const instance = await server.getContractInstance(guard);
  const decoded = JSON.parse(JSON.stringify(instance)) as {
    storage?: Array<{ key?: { vec?: Array<{ symbol?: string; sym?: string }> }; val?: unknown }>;
  };
  for (const item of decoded.storage ?? []) {
    const first = item.key?.vec?.[0];
    const name = first?.symbol ?? first?.sym;
    if (name !== "Initialized") continue;
    const value = item.val as { bool?: boolean } | string | undefined;
    if (typeof value === "string") return value.includes("true");
    return value?.bool === true;
  }
  return false;
}

/** `Error(Contract, #2)` is the contract's `AlreadyInitialized`. */
function isAlreadyInitializedError(detail: string): boolean {
  return /Error\(Contract, #2\)/.test(detail) || detail.includes("error code: 2");
}

/**
 * Contract ID for `create_contract` with an explicit salt:
 * `sha256(HashIdPreimage::ContractId { network_id, preimage })`. Computing it
 * makes the deployment independent of transaction result-meta parsing, and the
 * result is confirmed by reading the instance back off the ledger.
 */
function predictContractId(params: {
  deployerPublicKey: string;
  salt: Buffer;
  networkPassphrase: string;
}): string {
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: createHash("sha256").update(params.networkPassphrase).digest(),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(
        new xdr.ContractIdPreimageFromAddress({
          address: new Address(params.deployerPublicKey).toScAddress(),
          salt: params.salt,
        }),
      ),
    }),
  );
  return StrKey.encodeContract(createHash("sha256").update(preimage.toXDR()).digest());
}

interface Submission {
  hash: string;
  ledger: number | null;
}

/**
 * The deployment's permanent transaction record.
 *
 * Records are write-once and preserved across runs: an idempotent re-run must
 * never replace a real hash with "reused" or null, because this record is the
 * only durable evidence of how the instance was created. `lastVerified` is
 * refreshed on every run by re-reading each hash from the RPC, so the record
 * stays independently checkable rather than being a claim frozen at deploy time.
 *
 * This holds the *one-time* bring-up transactions. Repeated actions — mints —
 * are not a slot in this map but the append-only `mints` list below, because a
 * repeated action on a fixed key is precisely how a hash gets lost.
 */
type TransactionKey =
  | "tokenCreate"
  | "guardDeploy"
  | "initialize"
  | "trustlineRecipient"
  | "trustlineOutsider"
  | "setPolicy"
  /**
   * Legacy single-mint slot, superseded by the append-only `mints` list. Nothing
   * writes it any more; it is read only so an existing fixture's mint hash can be
   * migrated into `mints` instead of being dropped.
   */
  | "mint";

interface TransactionRecord {
  hash: string;
  ledger: number | null;
  status: string;
  recordedAt: string;
  lastVerified?: { at: string; status: string; ledger: number | null };
}

/**
 * One mint that actually broadcast. Keyed by its own hash and only ever
 * appended: a top-up is a real transaction, and its hash is evidence that must
 * survive every later run.
 */
interface MintRecord extends TransactionRecord {
  /** Decimal string of the amount minted, when recorded by the append-only path. */
  amount?: string;
  /** Decimal string of the guard's balance immediately before this mint. */
  balanceBefore?: string;
}

type TransactionRecords = Partial<Record<TransactionKey, TransactionRecord>>;

interface FixtureFile {
  deployedAt?: string;
  phase1HistoricalInstance?: Record<string, unknown>;
  phase2EnforcementInstance?: Record<string, unknown> & {
    transactions?: TransactionRecords;
    mints?: MintRecord[];
  };
  runs?: Array<{ at: string; actions: string[] }>;
}

/**
 * Submit a single-operation transaction signed by one classic key.
 *
 * Host-function operations (contract creation, SAC deployment) must carry real
 * Soroban resource data — core rejects them as `tx_malformed` without it — so
 * every transaction goes through the RPC's own prepare step, which simulates
 * and folds in the footprint, resources and fee.
 */
async function submitSimple(
  server: rpc.Server,
  operation: xdr.Operation,
  signer: Keypair,
): Promise<Submission> {
  const account = await server.getAccount(signer.publicKey());
  const built = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: TESTNET_PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();
  // Only host-function operations carry Soroban resource data; the RPC's
  // prepare step rejects classic operations (changeTrust, payments, …).
  const isHostFunction =
    (operation as unknown as { body?: { type?: string } }).body?.type === "invokeHostFunction";
  const prepared = isHostFunction ? await server.prepareTransaction(built) : built;
  prepared.sign(signer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`submit rejected: ${json(sent.errorResult ?? sent)}`);
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const result = await server.getTransaction(sent.hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return { hash: sent.hash, ledger: result.ledger ?? null };
    }
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      const diagnostic = (result as unknown as { diagnosticEventsXdr?: unknown[] })
        .diagnosticEventsXdr ?? [];
      throw new Error(
        [`tx ${sent.hash} failed`, ...summarizeDiagnosticEvents(diagnostic)].join("\n  "),
      );
    }
  }
  throw new Error(`timed out waiting for ${sent.hash}`);
}

// ── main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  const rpcUrl = (flags.get("rpc") as string) ?? TESTNET_RPC;
  const server = new rpc.Server(rpcUrl);
  const env = await readEnv();
  const existing = await readFixture();
  const deployLog: string[] = [];
  /** Transactions created by *this* run; merged into the preserved record. */
  const createdTransactions: TransactionRecords = {};
  /** Mints broadcast by *this* run; appended to the preserved list. */
  const createdMints: MintRecord[] = [];
  const record = (key: TransactionKey, submission: Submission) => {
    createdTransactions[key] = {
      hash: submission.hash,
      ledger: submission.ledger,
      status: "SUCCESS",
      recordedAt: nowIso(),
    };
  };
  const step = (message: string) => {
    console.log(message);
    deployLog.push(message);
  };

  step("[0] Phase 1 artifact identity (must match before anything is deployed)");
  const phase1 = await verifyWasmIdentity(server, PHASE1_GUARD);
  step(
    `    phase 1 guard  ${PHASE1_GUARD}\n` +
      `    ledger hash    ${phase1.reportedWasmHash}\n` +
      `    sha256(bytes)  ${phase1.fetchedSha256} (${phase1.bytes} bytes)\n` +
      `    identity match ${phase1.reportedWasmHash === PHASE1_WASM_HASH}`,
  );
  if (phase1.reportedWasmHash !== PHASE1_WASM_HASH) {
    throw new Error("Phase 1 WASM hash mismatch — refusing to deploy");
  }

  // ── Keys: reuse what .env.phase2 already holds, fund only new keys ─────
  const fromEnv = (name: string): Keypair | null => {
    const secret = env[name];
    return secret ? Keypair.fromSecret(secret) : null;
  };
  const created: string[] = [];
  const keys: Keys = {
    admin: fromEnv(ENV_KEYS.admin) ?? (created.push("admin"), Keypair.random()),
    agent: fromEnv(ENV_KEYS.agent) ?? (created.push("agent"), Keypair.random()),
    issuer: fromEnv(ENV_KEYS.issuer) ?? (created.push("issuer"), Keypair.random()),
    recipient: fromEnv(ENV_KEYS.recipient) ?? (created.push("recipient"), Keypair.random()),
    outsider: fromEnv(ENV_KEYS.outsider) ?? (created.push("outsider"), Keypair.random()),
  };
  const agentRawPubkey = Buffer.from(StrKey.decodeEd25519PublicKey(keys.agent.publicKey()));
  step(`[1] keys: ${created.length === 0 ? "reused from .env.phase2" : `generated ${created.join(", ")}`}`);
  for (const name of created) {
    await fund(server, keys[name as keyof Keys].publicKey());
  }
  for (const [name, keypair] of Object.entries(keys)) {
    step(`    ${name.padEnd(9)} ${keypair.publicKey()}`);
  }
  step(`    agent raw ed25519 pubkey ${agentRawPubkey.toString("hex")}`);

  // ── Test token (SAC) ──────────────────────────────────────────────────
  const asset = new Asset(ASSET_CODE, keys.issuer.publicKey());
  // A SAC's address is derived from the asset, so it is known before deploy.
  let token = env[ENV_KEYS.token] ?? asset.contractId(TESTNET_PASSPHRASE);
  let decimals = await readContract(server, token, "decimals", [], keys.issuer.publicKey());
  if (decimals.error) {
    const existingGuard = env[ENV_KEYS.guard];
    if (existingGuard) {
      throw new Error(
        `configured token ${token} is not readable and keys are already deployed; ` +
          `refusing to silently replace it (${decimals.error})`,
      );
    }
    step(`[2] deploying SAC test token ${ASSET_CODE}:${keys.issuer.publicKey()}`);
    const submitted = await submitSimple(
      server,
      Operation.createStellarAssetContract({ asset }),
      keys.issuer,
    );
    record("tokenCreate", submitted);
    token = asset.contractId(TESTNET_PASSPHRASE);
    decimals = await readContract(server, token, "decimals", [], keys.issuer.publicKey());
    step(`    tx ${submitted.hash}\n    token ${token} (decimals ${String(decimals.value)})`);
  } else {
    step(`[2] SAC test token already deployed\n    token ${token} (decimals ${String(decimals.value)})`);
  }

  // ── Guard instance from the Phase 1 WASM hash ─────────────────────────
  const predicted = predictContractId({
    deployerPublicKey: keys.admin.publicKey(),
    salt: GUARD_SALT,
    networkPassphrase: TESTNET_PASSPHRASE,
  });
  let guard = env[ENV_KEYS.guard] ?? predicted;
  let identity = await verifyWasmIdentity(server, guard).catch(() => null);
  if (!identity) {
    step(`[3] deploying guard instance from WASM ${PHASE1_WASM_HASH}`);
    const submitted = await submitSimple(
      server,
      Operation.createCustomContract({
        address: Address.fromString(keys.admin.publicKey()),
        wasmHash: Buffer.from(PHASE1_WASM_HASH, "hex"),
        salt: GUARD_SALT,
        constructorArgs: [],
      }),
      keys.admin,
    );
    record("guardDeploy", submitted);
    guard = predicted;
    identity = await verifyWasmIdentity(server, guard);
    step(`    tx ${submitted.hash}\n    predicted == actual: ${guard === predicted}`);
  } else {
    step(`[3] guard instance already deployed at ${guard}`);
  }
  step(
    `    guard ${guard}\n` +
      `    ledger hash   ${identity.reportedWasmHash}\n` +
      `    sha256(bytes) ${identity.fetchedSha256} (${identity.bytes} bytes)\n` +
      `    SAME ARTIFACT AS PHASE 1: ${identity.fetchedSha256 === PHASE1_WASM_HASH}`,
  );
  if (identity.fetchedSha256 !== PHASE1_WASM_HASH) {
    throw new Error("deployed instance is not the Phase 1 artifact");
  }

  // Persist as soon as an instance exists, so a later failure resumes against
  // this same deployment instead of orphan-deploying a new one on each attempt.
  await writeEnv(keys, { guard, token }, rpcUrl);

  // ── initialize ─────────────────────────────────────────────────────────
  if (!(await isInitialized(server, guard))) {
    step("[4] initialize(admin, agent_pubkey)");
    const outcome = await invoke({
      server,
      source: keys.admin,
      call: {
        contract: guard,
        fn: "initialize",
        args: [
          new Address(keys.admin.publicKey()).toScVal(),
          xdr.ScVal.scvBytes(agentRawPubkey),
        ],
      },
      networkPassphrase: TESTNET_PASSPHRASE,
      accountSigners: [keys.admin],
    });
    if (outcome.kind !== "allowed") {
      // Belt and braces: if the instance turns out to be initialized already,
      // that is a no-op for bring-up, not a failure.
      if (outcome.kind === "blocked" && isAlreadyInitializedError(outcome.detail)) {
        step("    already initialized on-chain (contract returned #2)");
      } else {
        throw new Error(`initialize failed: ${json(outcome)}`);
      }
    } else {
      record("initialize", outcome.submission);
      step(`    tx ${outcome.submission.hash} (ledger ${outcome.submission.ledger})`);
    }
  } else {
    step("[4] initialize already recorded on the instance");
  }

  // ── Trustlines (changeTrust is a no-op when already present) ───────────
  step("[5] recipient + outsider trustlines");
  for (const role of ["recipient", "outsider"] as const) {
    const keypair = keys[role];
    const balance = await readContract(
      server,
      token,
      "balance",
      [new Address(keypair.publicKey()).toScVal()],
      keys.issuer.publicKey(),
    );
    if (balance.error) {
      const submitted = await submitSimple(
        server,
        Operation.changeTrust({ asset, limit: TRUSTLINE_LIMIT.toString() }),
        keypair,
      );
      record(role === "recipient" ? "trustlineRecipient" : "trustlineOutsider", submitted);
      step(`    ${role.padEnd(9)} trustline tx ${submitted.hash} (ledger ${submitted.ledger})`);
    } else {
      step(`    ${role.padEnd(9)} trustline already present (balance ${String(balance.value)})`);
    }
  }

  // ── Mint into the guard ────────────────────────────────────────────────
  const guardBalance = await readContract(
    server,
    token,
    "balance",
    [new Address(guard).toScVal()],
    keys.issuer.publicKey(),
  );
  const currentBalance = typeof guardBalance.value === "bigint" ? guardBalance.value : 0n;
  if (guardBalance.error || currentBalance < MINT_AMOUNT) {
    step(`[6] mint ${MINT_AMOUNT} to the guard (current ${currentBalance})`);
    const outcome = await invoke({
      server,
      source: keys.issuer,
      call: {
        contract: token,
        fn: "mint",
        args: [new Address(guard).toScVal(), nativeToScVal(MINT_AMOUNT, { type: "i128" })],
      },
      networkPassphrase: TESTNET_PASSPHRASE,
      accountSigners: [keys.issuer],
    });
    if (outcome.kind !== "allowed") throw new Error(`mint failed: ${json(outcome)}`);
    // Appended, never assigned to a fixed slot: this is a distinct transaction
    // from any earlier top-up and needs its own permanent record.
    createdMints.push({
      hash: outcome.submission.hash,
      ledger: outcome.submission.ledger,
      status: "SUCCESS",
      recordedAt: nowIso(),
      amount: MINT_AMOUNT.toString(),
      balanceBefore: currentBalance.toString(),
    });
    step(`    tx ${outcome.submission.hash} (ledger ${outcome.submission.ledger})`);
  } else {
    step(`[6] guard already holds ${currentBalance} of the test token`);
  }

  // ── Policy ─────────────────────────────────────────────────────────────
  const policy = enforcementPolicy(token, keys.recipient.publicKey());
  const installed = await readContract(server, guard, "policy", [], keys.admin.publicKey());
  // Compared canonically: the contract returns the map's entries in sorted key
  // order, while the desired policy is declared in field order, so a plain
  // JSON string comparison would report a difference that is not one.
  const installedJson = canonicalJson(installed.value ?? null);
  const desiredJson = canonicalJson(normalizePolicy(policy));
  if (installedJson !== desiredJson) {
    step("[7] set_policy(per-tx 1000, rolling window 150/60s, recipient allowlist)");
    const outcome = await invoke({
      server,
      source: keys.admin,
      call: { contract: guard, fn: "set_policy", args: [policyToScVal(policy)] },
      networkPassphrase: TESTNET_PASSPHRASE,
      accountSigners: [keys.admin],
    });
    if (outcome.kind !== "allowed") throw new Error(`set_policy failed: ${json(outcome)}`);
    record("setPolicy", outcome.submission);
    step(`    tx ${outcome.submission.hash} (ledger ${outcome.submission.ledger})`);
  } else {
    step("[7] policy already matches the desired enforcement policy");
  }

  // ── Verify ─────────────────────────────────────────────────────────────
  step("[8] verifying final on-chain state");
  const finalIdentity = await verifyWasmIdentity(server, guard);
  const phase1Live = await readContract(server, PHASE1_GUARD, "status", [], keys.admin.publicKey());
  const status = await readContract(server, guard, "status", [], keys.admin.publicKey());
  const policyNow = await readContract(server, guard, "policy", [], keys.admin.publicKey());
  const balanceNow = await readContract(
    server,
    token,
    "balance",
    [new Address(guard).toScVal()],
    keys.issuer.publicKey(),
  );

  // ── Fixture record: preserve, re-verify, append (never overwrite) ─────
  const previous = existing?.phase2EnforcementInstance;
  const mints = mergeMints(previousMints(existing), createdMints);
  const transactions = mergeTransactionRecords(previous?.transactions, createdTransactions);
  // The legacy single-mint slot now lives in `mints`; carrying it forward would
  // restore exactly the fixed shape that could silently lose a hash.
  delete transactions.mint;
  const verification = await verifyTransactionRecords(server, transactions);
  const mintVerification = await verifyMints(server, mints);
  const allSuccess = verification.allSuccess && mintVerification.allSuccess;
  const runs = [...(existing?.runs ?? []), { at: nowIso(), actions: deployLog }];
  if (!allSuccess) {
    console.warn("WARNING: at least one recorded transaction did not verify as SUCCESS");
  }
  step(
    `[9] recorded transactions re-verified: ${Object.values(verification.records)
      .map((entry) => `${entry?.lastVerified?.status ?? "?"}@${entry?.lastVerified?.ledger ?? "?"}`)
      .join(" ")}`,
  );
  step(
    `    mints on record: ${mintVerification.records.length} ` +
      `(${mintVerification.records
        .map((entry) => `${entry.hash.slice(0, 8)}… ${entry.lastVerified?.status ?? "?"}`)
        .join(", ")})`,
  );

  const fixtures = {
    network: "testnet",
    rpcUrl,
    networkPassphrase: TESTNET_PASSPHRASE,
    deployedAt: existing?.deployedAt ?? nowIso(),
    lastVerifiedAt: nowIso(),
    phase1HistoricalInstance: {
      note:
        "Phase 1 evidence. Deliberately untouched by Phase 2: it is the dead-man-switch " +
        "proof and is currently frozen by its own switch (heartbeat_expired).",
      guard: PHASE1_GUARD,
      wasmHash: phase1.reportedWasmHash,
      artifactIdentityMatch: phase1.reportedWasmHash === phase1.fetchedSha256,
      liveStatus: phase1Live.value ?? phase1Live.error ?? null,
    },
    phase2EnforcementInstance: {
      note:
        "Live Phase 2 instance: a fresh instance of the identical Phase 1 artifact " +
        "(byte-for-byte, hash-verified below), with keys held by this repo. Enforcement " +
        "integration tests run against this instance.",
      snapshotNote:
        "`status`, `policy` and `guardTokenBalance` below are a SNAPSHOT taken when this " +
        "script last ran — not current state. The integration suite spends funds and the " +
        "rolling window moves after every run, so these fields go stale immediately. " +
        "Query the instance directly for current values (`npm run inspect`). The " +
        "`transactions` and `mints` records are not snapshots: they are sealed, " +
        "append-only, and re-verified against the chain on every run.",
      guard,
      wasmHashLedger: finalIdentity.reportedWasmHash,
      wasmHashFetched: finalIdentity.fetchedSha256,
      wasmBytes: finalIdentity.bytes,
      artifactIdentityMatch: finalIdentity.fetchedSha256 === PHASE1_WASM_HASH,
      policySha256: createHash("sha256").update(json(policyNow.value)).digest("hex"),
      token,
      tokenIssuer: keys.issuer.publicKey(),
      addresses: {
        admin: keys.admin.publicKey(),
        agent: keys.agent.publicKey(),
        agentRawEd25519Pubkey: agentRawPubkey.toString("hex"),
        recipient: keys.recipient.publicKey(),
        outsider: keys.outsider.publicKey(),
      },
      transactions: verification.records,
      // Append-only: every mint that broadcast, keyed by hash. Never overwritten.
      mints: mintVerification.records,
      allRecordedTransactionsVerified: allSuccess,
      status: status.value ?? status.error ?? null,
      policy: policyNow.value ?? policyNow.error ?? null,
      guardTokenBalance: balanceNow.value ?? balanceNow.error ?? null,
    },
    runs,
  };

  assertFixtureSchema(fixtures);
  await mkdir(dirname(FIXTURES_PATH), { recursive: true });
  await writeFile(FIXTURES_PATH, `${json(fixtures)}\n`);
  await writeEnv(keys, { guard, token }, rpcUrl);

  step(`\nPhase 2 enforcement instance ready: ${guard}`);
  step(`token ${token}`);
  step(`secrets in ${ENV_PATH} (gitignored); public fixtures in ${FIXTURES_PATH}`);
  console.log(json(fixtures.phase2EnforcementInstance));
}

/**
 * Order-insensitive JSON with BigInts as decimal strings, for comparing a
 * desired policy against the one the contract returns.
 */
function canonicalJson(value: unknown): string {
  const normalise = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (Array.isArray(input)) return input.map(normalise);
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        out[key] = normalise((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(normalise(value));
}

/** Render a policy the way the contract returns it, for equality comparison. */
function normalizePolicy(policy: PolicyConfig): Record<string, unknown> {
  return {
    per_tx_cap: policy.per_tx_cap,
    window_secs: policy.window_secs,
    window_cap: policy.window_cap,
    assets: policy.assets,
    protocols: policy.protocols.map((rule) => ({ contract: rule.contract, fns: rule.fns })),
    recipients: policy.recipients,
    allow_any_recipient: policy.allow_any_recipient,
    active_from: policy.active_from,
    active_until: policy.active_until,
    paused: policy.paused,
    dms_grace_secs: policy.dms_grace_secs,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
