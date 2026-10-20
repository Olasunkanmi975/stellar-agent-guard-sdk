/**
 * Construction-time options validation shared by the framework adapters.
 *
 * Every adapter here is wiring, not policy: a missing `toContractCall` or an
 * object masquerading as an interceptor is a programmer error, not a refusal.
 * So the validators below collect *all* the problems in one pass and the
 * adapter throws a single `AdapterConfigError` naming each offending field,
 * before the first agent action ever reaches the guard.
 *
 * Keeping the checks here -- rather than inline in `langchain.ts` and
 * `elizaos.ts` -- means the two adapters fail with the same wording and the
 * same error type, and a new adapter gets the checks for free.
 */
import { AdapterConfigError } from "../errors.ts";

/**
 * One option that was missing or had the wrong type.
 *
 * `field` is the option key to fix, `expected` describes the shape it should
 * have, and `message` is the ready-to-read line used when the issues are
 * reported.
 */
export interface AdapterConfigIssue {
  /** Option key that was missing or had the wrong type. */
  field: string;
  /** Human-readable description of the expected shape. */
  expected: string;
  /** Full sentence describing this issue, used in the thrown error. */
  message: string;
}

/** Describe a value's type for an error message, without ever echoing its contents. */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return `a ${typeof value}`;
}

/** A required option that must be a function. */
export function validateRequiredFunction(
  field: string,
  value: unknown,
): AdapterConfigIssue | undefined {
  if (typeof value === "function") return undefined;
  return {
    field,
    expected: "a function",
    message: `\`${field}\` is required and must be a function (got ${describeValue(value)}).`,
  };
}

/** An optional option that, when present, must be a function. */
export function validateOptionalFunction(
  field: string,
  value: unknown,
): AdapterConfigIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "function") return undefined;
  return {
    field,
    expected: "a function when provided",
    message: `\`${field}\` must be a function when provided (got ${describeValue(value)}).`,
  };
}

/**
 * A call-mapping pair: at least one of the single or batch form is required.
 *
 * The batch form is additive (issue #318), so `toContractCall` is no longer
 * mandatory on its own; either mapper satisfies the requirement, and supplying
 * both is valid (`toContractCalls` takes precedence).
 */
export function validateContractMapping(options: {
  toContractCall?: unknown;
  toContractCalls?: unknown;
}): AdapterConfigIssue[] {
  if (options.toContractCall === undefined && options.toContractCalls === undefined) {
    return [
      {
        field: "toContractCall",
        expected: "a function, or a `toContractCalls` batch mapper",
        message:
          "`toContractCall` or `toContractCalls` is required; supply one to map the action " +
          "to the guarded contract call(s).",
      },
    ];
  }
  const issues: AdapterConfigIssue[] = [];
  const single = validateOptionalFunction("toContractCall", options.toContractCall);
  if (single) issues.push(single);
  const batch = validateOptionalFunction("toContractCalls", options.toContractCalls);
  if (batch) issues.push(batch);
  return issues;
}

/** An optional explicit sink for a swallowed `onBlocked` failure. */
export function validateBlockedHookLogger(value: unknown): AdapterConfigIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof (value as { error?: unknown } | null)?.error === "function") return undefined;
  return {
    field: "blockedHookLogger",
    expected: "an object exposing an `error(message, ...rest)` method when provided",
    message:
      "`blockedHookLogger` must be an object exposing an `error(message, ...rest)` method " +
      `when provided (got ${describeValue(value)}).`,
  };
}

/** An interceptor, duck-typed on the `check(...)` method the adapters call. */
export function validateInterceptor(value: unknown): AdapterConfigIssue | undefined {
  const candidate = value as { check?: unknown } | null | undefined;
  if (candidate != null && typeof candidate.check === "function") return undefined;
  return {
    field: "interceptor",
    expected: "an object exposing a `check(...)` method",
    message:
      "`interceptor` is required and must be a PreFlightInterceptor " +
      "(an object exposing a `check(...)` method).",
  };
}

/**
 * An optional `AbortSignal` forwarded to the pre-flight check (issue #315).
 * Duck-typed, so any `AbortSignal` (Node, browser, a polyfill) is accepted.
 */
export function validateOptionalSignal(value: unknown): AdapterConfigIssue | undefined {
  if (value === undefined) return undefined;
  const candidate = value as { aborted?: unknown; addEventListener?: unknown } | null;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof candidate.aborted === "boolean" &&
    typeof candidate.addEventListener === "function"
  ) {
    return undefined;
  }
  return {
    field: "signal",
    expected: "an AbortSignal when provided",
    message: `\`signal\` must be an AbortSignal when provided (got ${describeValue(value)}).`,
  };
}

/** An optional per-RPC timeout forwarded to the pre-flight check (issue #315). */
export function validateOptionalTimeout(value: unknown): AdapterConfigIssue | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return undefined;
  return {
    field: "timeoutMs",
    expected: "a finite, non-negative number of milliseconds when provided",
    message: `\`timeoutMs\` must be a finite, non-negative number of milliseconds when provided (got ${describeValue(
      value,
    )}).`,
  };
}

/**
 * A batch-capable interceptor: the adapters call `checkBatch(...)` when a
 * `toContractCalls` mapper produces more than one call.
 */
export function validateBatchInterceptor(value: unknown): AdapterConfigIssue | undefined {
  const candidate = value as { checkBatch?: unknown } | null | undefined;
  if (candidate != null && typeof candidate.checkBatch === "function") return undefined;
  return {
    field: "interceptor",
    expected: "an object exposing a `checkBatch(...)` method when `toContractCalls` is used",
    message:
      "`interceptor` must expose a `checkBatch(...)` method when `toContractCalls` is used " +
      "(a PreFlightInterceptor does).",
  };
}

/**
 * Throw a single `AdapterConfigError` when `issues` is non-empty; otherwise do
 * nothing, so it can be called unconditionally at the end of a validation pass.
 */
export function throwAdapterConfigError(
  adapter: string,
  issues: readonly AdapterConfigIssue[],
): void {
  const first = issues[0];
  if (first === undefined) return;

  const fields = issues.map((issue) => `\`${issue.field}\``).join(", ");
  const message =
    `${adapter} adapter options are invalid: ${issues.length} problem(s) found (${fields}).\n` +
    issues.map((issue) => `  - ${issue.message}`).join("\n");

  throw new AdapterConfigError(message, {
    field: first.field,
    expected: first.expected,
    adapter,
  });
}
