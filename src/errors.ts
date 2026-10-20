/**
 * Structured SDK failures.
 *
 * Callers should branch on an error class (or on the class attached to a result-
 * oriented `invoke` error outcome), not by matching human-readable messages that
 * may change as the Stellar SDK evolves. Every SDK-owned error extends
 * `GuardError`, so a single `instanceof GuardError` check remains sufficient for
 * integrations that do not need a finer category.
 */
import type { InvokeRetryMetadata } from "./retry.ts";

function causeOptions(cause: unknown): ErrorOptions | undefined {
  return cause === undefined ? undefined : { cause };
}

/** Base class for every error deliberately produced by this SDK. */
export class GuardError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A simulation could not run, or ran without producing a contract verdict. */
export class SimulationError extends GuardError {
  readonly stage: "probe" | "simulate" | "preflight";
  readonly diagnosticEvents: unknown[];

  constructor(
    message: string,
    options: {
      stage: SimulationError["stage"];
      cause?: unknown;
      diagnosticEvents?: readonly unknown[];
    },
  ) {
    super(message, causeOptions(options.cause));
    this.stage = options.stage;
    this.diagnosticEvents = [...(options.diagnosticEvents ?? [])];
  }
}

/** A transaction could not be signed for submission. */
export class SigningError extends GuardError {
  /** Account/contract whose authorization could not be produced, when known. */
  readonly address: string | null;

  constructor(message: string, options: { address?: string | null; cause?: unknown } = {}) {
    super(message, causeOptions(options.cause));
    this.address = options.address ?? null;
  }
}

export interface BroadcastFailurePayload {
  resultXdr: string | null;
  resultCode: string | null;
  message: string;
  diagnosticEvents: unknown[];
}

export interface BroadcastFailureParams {
  attempts: number;
  lastFee: bigint;
  failure: BroadcastFailurePayload;
  detail?: string | undefined;
  /** Structured retry metadata; additive, and safe to log. */
  retry?: InvokeRetryMetadata | undefined;
}

/** Submission failed after assembly, or the RPC rejected the send request. */
export class BroadcastError extends GuardError {
  readonly kind = "error" as const;
  /** Present once the RPC has assigned a hash; absent for pre-send failures. */
  readonly transactionHash: string | null;
  readonly attempts?: number | undefined;
  readonly lastFee?: bigint | undefined;
  readonly failure?: BroadcastFailurePayload | undefined;
  readonly detail?: string | undefined;
  /** Structured retry metadata; present when a retry budget was involved. */
  readonly retry?: InvokeRetryMetadata | undefined;

  constructor(
    message: string,
    options?: {
      transactionHash?: string | null;
      cause?: unknown;
      retry?: InvokeRetryMetadata | undefined;
    },
  );
  constructor(params: BroadcastFailureParams);
  constructor(
    messageOrParams: string | BroadcastFailureParams,
    options: {
      transactionHash?: string | null;
      cause?: unknown;
      retry?: InvokeRetryMetadata | undefined;
    } = {},
  ) {
    if (typeof messageOrParams === "string") {
      super(messageOrParams, causeOptions(options.cause));
      this.name = "BroadcastError";
      this.transactionHash = options.transactionHash ?? null;
      this.attempts = undefined;
      this.lastFee = undefined;
      this.failure = undefined;
      this.detail = undefined;
      this.retry = options.retry;
    } else {
      const detail = messageOrParams.detail ?? messageOrParams.failure.message;
      super(
        `stellar-agent-guard broadcast failed: minimum fee not met after ${messageOrParams.attempts} attempt(s) (last fee: ${messageOrParams.lastFee} stroops)\n${detail}`,
      );
      this.name = "BroadcastError";
      this.transactionHash = null;
      this.attempts = messageOrParams.attempts;
      this.lastFee = messageOrParams.lastFee;
      this.failure = messageOrParams.failure;
      this.detail = detail;
      this.retry = messageOrParams.retry;
    }
  }

  get error(): BroadcastError {
    return this;
  }
}

/** A contract response did not match the API shape the SDK understands. */
export class ContractResponseError extends GuardError {
  readonly field: string;

  constructor(message: string, options: { field: string; cause?: unknown }) {
    super(message, causeOptions(options.cause));
    this.field = options.field;
  }
}

/** A policy ScVal did not match the deployed `PolicyConfig` wire shape. */
export class PolicyDecodeError extends GuardError {
  /** Dotted field path at which decoding failed. */
  readonly path: string;

  constructor(message: string, options: { path: string; cause?: unknown }) {
    super(message, causeOptions(options.cause));
    this.path = options.path;
  }
}

/**
 * An adapter's call mapper could not produce a contract call.
 *
 * `toContractCall`/`toContractCalls` is application code: when it throws, or
 * returns something that is not a contract call, the adapter fails closed and
 * reports an `undetermined` halt rather than letting the action through. The
 * original failure is kept as `cause`, and `field` names the mapper to fix.
 */
export class AdapterMappingError extends GuardError {
  /** The mapper option that failed. */
  readonly field: "toContractCall" | "toContractCalls";

  constructor(
    message: string,
    options: { field: "toContractCall" | "toContractCalls"; cause?: unknown },
  ) {
    super(message, causeOptions(options.cause));
    this.field = options.field;
  }
}

/**
 * An adapter was constructed with misconfigured options.
 *
 * This is a programmer error, not a policy refusal: it is thrown at
 * construction time, before the adapter ever sees an agent action, so a code
 * bug in the integration fails fast instead of killing the first tool call of

 * production. The `field` names the offending option and `expected` describes
 * the shape it must have, so the fix is obvious without reading this SDK's
 * source.
 */
export class AdapterConfigError extends GuardError {
  /** Option key that was missing or had the wrong type. */
  readonly field: string;
  /** Human-readable description of the expected shape. */
  readonly expected: string;
  /** Adapter identifier, e.g. `"langchain"` or `"elizaos"`. */
  readonly adapter: string;

  constructor(
    message: string,
    options: { field: string; expected: string; adapter: string; cause?: unknown },
  ) {
    super(message, causeOptions(options.cause));
    this.field = options.field;
    this.expected = options.expected;
    this.adapter = options.adapter;
  }
}
