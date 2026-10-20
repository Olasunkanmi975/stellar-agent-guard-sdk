/**
 * Admin operations helpers for stellar-agent-guard smart accounts.
 *
 * Provides typed transaction submission and call construction helpers for
 * operator actions:
 *  - `submitSetPolicy` (updates spend caps, rolling windows, allowlists)
 *  - `submitFreeze` (emergency panic-button freeze)
 *  - `submitUnfreeze` (unfreezes account and re-arms heartbeat)
 *  - `submitRotateAgentKey` (re-binds the agent's Ed25519 public key)
 *
 * Policy encoding strictly reuses canonical `policyToScVal` from `src/policy.ts`
 * to guarantee identical field mapping, validation, and sorted ScMap serialization
 * with zero duplicated encoder logic.
 */
import { Keypair, StrKey, rpc, xdr } from "@stellar/stellar-sdk";
import { invoke, type InvokeOutcome } from "./invoke.ts";
import { hexToBytes } from "./hash.ts";
import { policyToScVal, type ContractAddress, type ReadonlyPolicyConfig } from "./policy.ts";
import type { AdminSigner, ContractCall } from "./tx.ts";

export const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** Convert a keypair, StrKey ('G...'), raw Uint8Array, or hex string to Soroban BytesN<32> ScVal. */
export function agentPubkeyToScVal(newAgent: string | Uint8Array | Keypair): xdr.ScVal {
  if (
    typeof newAgent === "object" &&
    newAgent !== null &&
    "rawPublicKey" in newAgent &&
    typeof (newAgent as Keypair).rawPublicKey === "function"
  ) {
    return xdr.ScVal.scvBytes((newAgent as Keypair).rawPublicKey());
  }
  if (newAgent instanceof Uint8Array) {
    if (newAgent.length !== 32) {
      throw new Error(`agent public key byte length must be 32, received ${newAgent.length}`);
    }
    return xdr.ScVal.scvBytes(Uint8Array.from(newAgent));
  }
  if (typeof newAgent === "string") {
    if (newAgent.startsWith("G") && newAgent.length === 56) {
      return xdr.ScVal.scvBytes(StrKey.decodeEd25519PublicKey(newAgent));
    }
    if (/^[0-9a-fA-F]{64}$/.test(newAgent)) {
      return xdr.ScVal.scvBytes(hexToBytes(newAgent));
    }
  }
  throw new Error(`invalid agent public key format for rotation: ${String(newAgent)}`);
}

/** Build a contract call for set_policy, reusing canonical policyToScVal. */
export function buildSetPolicyCall(guard: ContractAddress, policy: ReadonlyPolicyConfig): ContractCall {
  return {
    contract: guard,
    fn: "set_policy",
    args: [policyToScVal(policy)],
  };
}

/** Build a contract call for freeze. */
export function buildFreezeCall(guard: ContractAddress): ContractCall {
  return {
    contract: guard,
    fn: "freeze",
    args: [],
  };
}

/** Build a contract call for unfreeze. */
export function buildUnfreezeCall(guard: ContractAddress): ContractCall {
  return {
    contract: guard,
    fn: "unfreeze",
    args: [],
  };
}

/** Build a contract call for rotate_agent_key. */
export function buildRotateAgentKeyCall(
  guard: ContractAddress,
  newAgent: string | Uint8Array | Keypair,
): ContractCall {
  return {
    contract: guard,
    fn: "rotate_agent_key",
    args: [agentPubkeyToScVal(newAgent)],
  };
}

export interface AdminOpParams {
  server: rpc.Server;
  guard: ContractAddress;
  admin: Keypair | AdminSigner;
  source?: Keypair | AdminSigner | undefined;
  networkPassphrase?: string | undefined;
  dryRun?: boolean | undefined;
  pollAttempts?: number | undefined;
  pollIntervalMs?: number | undefined;
  /**
   * Caller-owned cancellation, forwarded to `invoke()` unchanged.
   *
   * An already-aborted signal short-circuits before any RPC call and produces
   * the same documented typed outcome an aborted `invoke()` produces: the
   * `error` arm carrying an `RpcTimeoutError` with `aborted: true`. A
   * mid-flight abort stops the operation at the next RPC boundary.
   *
   * Cancellation never relaxes the guard: it can only stop the SDK from
   * waiting, never turn a refusal into an approval.
   */
  signal?: AbortSignal | undefined;
  /**
   * Bound on each individual RPC call, in milliseconds, forwarded to
   * `invoke()` unchanged. Defaults to `DEFAULT_RPC_TIMEOUT_MS` (30s); pass
   * `0` to disable the bound and rely solely on `signal`.
   */
  timeoutMs?: number | undefined;
}

export interface SetPolicyParams extends AdminOpParams {
  policy: ReadonlyPolicyConfig;
}

export interface RotateAgentKeyParams extends AdminOpParams {
  newAgent: string | Uint8Array | Keypair;
}

/**
 * Submit set_policy to the guard contract with an admin signer.
 * Reuses canonical policyToScVal without duplicating encoding logic.
 */
export async function submitSetPolicy(params: SetPolicyParams): Promise<InvokeOutcome> {
  const call = buildSetPolicyCall(params.guard, params.policy);
  return invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Submit freeze to the guard contract with an admin signer.
 */
export async function submitFreeze(params: AdminOpParams): Promise<InvokeOutcome> {
  const call = buildFreezeCall(params.guard);
  return invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Submit unfreeze to the guard contract with an admin signer.
 */
export async function submitUnfreeze(params: AdminOpParams): Promise<InvokeOutcome> {
  const call = buildUnfreezeCall(params.guard);
  return invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}

/**
 * Submit rotate_agent_key to the guard contract with an admin signer.
 */
export async function submitRotateAgentKey(params: RotateAgentKeyParams): Promise<InvokeOutcome> {
  const call = buildRotateAgentKeyCall(params.guard, params.newAgent);
  return invoke({
    server: params.server,
    source: params.source ?? params.admin,
    call,
    networkPassphrase: params.networkPassphrase ?? DEFAULT_NETWORK_PASSPHRASE,
    accountSigners: [params.admin],
    dryRun: params.dryRun,
    pollAttempts: params.pollAttempts,
    pollIntervalMs: params.pollIntervalMs,
    signal: params.signal,
    timeoutMs: params.timeoutMs,
  });
}
