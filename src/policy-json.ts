/**
 * Lossless in-memory JSON representation for PolicyConfig.
 *
 * This module is deliberately separate from policy.ts: JSON transport is not
 * contract enforcement or ScVal encoding, and must not be mistaken for either.
 * It performs no filesystem I/O.
 */
import { PolicyDecodeError } from "./errors.ts";
import {
  isAccountAddress,
  isContractAddress,
  type AccountAddress,
  type ContractAddress,
  type PolicyConfig,
  type ProtocolRule,
  type ReadonlyPolicyConfig,
} from "./policy.ts";

/** Version of the lossless, in-memory JSON policy representation. */
export const POLICY_JSON_VERSION = 1 as const;

export interface PolicyJsonProtocolRule {
  contract: string;
  fns: string[] | null;
}

export interface PolicyJsonRecipientWindowCap {
  recipient: string;
  cap: string;
}

/** JSON-safe policy shape; every integer is a decimal string. */
export interface PolicyJson {
  version: typeof POLICY_JSON_VERSION;
  per_tx_cap: string;
  window_secs: string;
  window_cap: string;
  assets: string[];
  protocols: PolicyJsonProtocolRule[];
  recipients: string[];
  allow_any_recipient: boolean;
  active_from: string;
  active_until: string;
  paused: boolean;
  dms_grace_secs: string;
  recipient_window_caps?: PolicyJsonRecipientWindowCap[];
  blocked_recipients?: string[];
}

const REQUIRED_FIELDS = [
  "version",
  "per_tx_cap",
  "window_secs",
  "window_cap",
  "assets",
  "protocols",
  "recipients",
  "allow_any_recipient",
  "active_from",
  "active_until",
  "paused",
  "dms_grace_secs",
] as const;
const OPTIONAL_FIELDS = ["recipient_window_caps", "blocked_recipients"] as const;
const I128_MIN = -(2n ** 127n);
const I128_MAX = 2n ** 127n - 1n;
const U64_MAX = 2n ** 64n - 1n;

/** Encode a policy into a JSON-safe object without narrowing bigint fields. */
export function policyToJson(policy: ReadonlyPolicyConfig): PolicyJson {
  return {
    version: POLICY_JSON_VERSION,
    per_tx_cap: policy.per_tx_cap.toString(),
    window_secs: policy.window_secs.toString(),
    window_cap: policy.window_cap.toString(),
    assets: [...policy.assets],
    protocols: policy.protocols.map((rule) => ({
      contract: rule.contract,
      fns: rule.fns === null ? null : [...rule.fns],
    })),
    recipients: [...policy.recipients],
    allow_any_recipient: policy.allow_any_recipient,
    active_from: policy.active_from.toString(),
    active_until: policy.active_until.toString(),
    paused: policy.paused,
    dms_grace_secs: policy.dms_grace_secs.toString(),
    ...(policy.recipient_window_caps === undefined
      ? {}
      : {
          recipient_window_caps: policy.recipient_window_caps.map((cap) => ({
            recipient: cap.recipient,
            cap: cap.cap.toString(),
          })),
        }),
    ...(policy.blocked_recipients === undefined
      ? {}
      : { blocked_recipients: [...policy.blocked_recipients] }),
  };
}

/** Parse and validate a JSON object or JSON string without floating-point conversion. */
export function policyFromJson(input: unknown): PolicyConfig {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input) as unknown;
    } catch (error) {
      throw policyJsonFailure("policy", "is not valid JSON", error);
    }
  }

  const root = jsonObject(value, "policy");
  assertJsonFields(root, "policy", REQUIRED_FIELDS, OPTIONAL_FIELDS);
  if (root.version !== POLICY_JSON_VERSION) {
    throw policyJsonFailure("policy.version", `expected version ${POLICY_JSON_VERSION}`);
  }

  const protocols = jsonArray(root.protocols, "policy.protocols").map((value, index) => {
    const path = `policy.protocols[${index}]`;
    const rule = jsonObject(value, path);
    assertJsonFields(rule, path, ["contract", "fns"]);
    return {
      contract: jsonAddress(rule.contract, `${path}.contract`, "contract") as ContractAddress,
      fns: jsonFunctions(rule.fns, `${path}.fns`),
    } satisfies ProtocolRule;
  });

  const policy: PolicyConfig = {
    per_tx_cap: jsonInteger(root.per_tx_cap, "policy.per_tx_cap", "i128", I128_MIN, I128_MAX),
    window_secs: jsonInteger(root.window_secs, "policy.window_secs", "u64", 0n, U64_MAX),
    window_cap: jsonInteger(root.window_cap, "policy.window_cap", "i128", I128_MIN, I128_MAX),
    assets: jsonArray(root.assets, "policy.assets").map((value, index) =>
      jsonAddress(value, `policy.assets[${index}]`, "contract") as ContractAddress,
    ),
    protocols,
    recipients: jsonArray(root.recipients, "policy.recipients").map((value, index) =>
      jsonAddress(value, `policy.recipients[${index}]`, "account") as AccountAddress,
    ),
    allow_any_recipient: jsonBoolean(root.allow_any_recipient, "policy.allow_any_recipient"),
    active_from: jsonInteger(root.active_from, "policy.active_from", "u64", 0n, U64_MAX),
    active_until: jsonInteger(root.active_until, "policy.active_until", "u64", 0n, U64_MAX),
    paused: jsonBoolean(root.paused, "policy.paused"),
    dms_grace_secs: jsonInteger(root.dms_grace_secs, "policy.dms_grace_secs", "u64", 0n, U64_MAX),
  };

  if (root.recipient_window_caps !== undefined) {
    policy.recipient_window_caps = jsonArray(
      root.recipient_window_caps,
      "policy.recipient_window_caps",
    ).map((value, index) => {
      const path = `policy.recipient_window_caps[${index}]`;
      const cap = jsonObject(value, path);
      assertJsonFields(cap, path, ["recipient", "cap"]);
      return {
        recipient: jsonAddress(cap.recipient, `${path}.recipient`, "account") as AccountAddress,
        cap: jsonInteger(cap.cap, `${path}.cap`, "i128", I128_MIN, I128_MAX),
      };
    });
  }
  if (root.blocked_recipients !== undefined) {
    policy.blocked_recipients = jsonArray(root.blocked_recipients, "policy.blocked_recipients").map(
      (value, index) =>
        jsonAddress(value, `policy.blocked_recipients[${index}]`, "account") as AccountAddress,
    );
  }
  return policy;
}

/** Explicit aliases for callers who prefer encode/decode naming. */
export const encodePolicyJson = policyToJson;
export const decodePolicyJson = policyFromJson;

function jsonObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw policyJsonFailure(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function assertJsonFields(
  object: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) throw policyJsonFailure(`${path}.${key}`, "unknown field");
  }
  for (const key of required) {
    if (!(key in object)) throw policyJsonFailure(`${path}.${key}`, "missing field");
  }
}

function jsonArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw policyJsonFailure(path, "expected an array");
  return value;
}

function jsonBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw policyJsonFailure(path, "expected a boolean");
  return value;
}

function jsonAddress(value: unknown, path: string, kind: "account" | "contract"): string {
  const valid = kind === "account" ? isAccountAddress(value) : isContractAddress(value);
  if (!valid || typeof value !== "string") {
    throw policyJsonFailure(path, `expected a valid Stellar ${kind} address`);
  }
  return value;
}

function jsonFunctions(value: unknown, path: string): string[] | null {
  if (value === null) return null;
  return jsonArray(value, path).map((fn, index) => {
    if (typeof fn !== "string") throw policyJsonFailure(`${path}[${index}]`, "expected a string");
    return fn;
  });
}

function jsonInteger(
  value: unknown,
  path: string,
  wireType: "u64" | "i128",
  min: bigint,
  max: bigint,
): bigint {
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value)) {
    throw policyJsonFailure(path, `expected a base-10 decimal string for ${wireType}`);
  }
  let parsed: bigint;
  try {
    parsed = BigInt(value);
  } catch (error) {
    throw policyJsonFailure(path, "is not a valid integer", error);
  }
  if (parsed < min || parsed > max) {
    throw policyJsonFailure(path, `${parsed} is outside the supported [${min}, ${max}] range`);
  }
  return parsed;
}

function policyJsonFailure(path: string, detail: string, cause?: unknown): PolicyDecodeError {
  return new PolicyDecodeError(`cannot decode policy JSON field ${path}: ${detail}`, {
    path,
    ...(cause === undefined ? {} : { cause }),
  });
}
