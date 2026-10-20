/**
 * Optional, injectable logging — silent unless a host asks otherwise.
 *
 * A library that prints to stdout is a bad citizen in an agent runtime: it
 * pollutes structured-log pipelines, ignores the host's level filtering, and
 * cannot be redirected per-component. This module exists so that the SDK's
 * diagnostics are available to a host that wants them and invisible to one that
 * does not.
 *
 * The contract, in three lines:
 *
 * - **Silent by default.** No logger means no output — not to the console, not
 *   to stdout or stderr, not through an implicit process-level logger.
 * - **Structural, not a dependency.** A host passes any object with the four
 *   levels; `console` itself satisfies the interface, as does a pino/winston
 *   child logger.
 * - **Redacted by default.** SDK-owned metadata is copied before delivery and
 *   fields that commonly contain keys, signer output, caller arguments, or raw
 *   RPC payloads are omitted. Public errors, callbacks, and telemetry are not
 *   mutated; this boundary only controls what the logger receives.
 * - **Never fatal.** A logger that throws — or a level the host did not
 *   implement — cannot change an outcome, break a pipeline stage, or surface as
 *   an error. Observability is advisory, the same way `onStep` and `onGap` are.
 */

/**
 * Structured detail attached to a log line, e.g. the retry index or the ledger
 * a cached verdict came from.
 *
 * Deliberately loose: the SDK does not dictate a schema to the host, and a
 * host that ignores `meta` still gets a complete one-line message. Values are
 * copied and redacted at the logger boundary; `bigint` fee amounts are
 * rendered as strings, because a JSON logger cannot serialise a `bigint`.
 */
export type GuardLogMeta = Record<string, unknown>;

const SENSITIVE_META_KEY = /(?:private|secret|signer|signature|raw|diagnostic|payload|argument|args)/i;

/**
 * Copy logger metadata while removing fields that are unsafe to forward by
 * default. This is intentionally a logger-only transform: callers still get
 * the original errors, callbacks, and `includeRaw` telemetry payloads.
 */
export function redactLogMeta(meta: GuardLogMeta | undefined): GuardLogMeta | undefined {
  if (meta === undefined) return undefined;
  return sanitizeLogValue(meta, new WeakSet<object>(), 0) as GuardLogMeta;
}

function sanitizeLogValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function") return undefined;
  if (depth >= 8) return "[redacted: metadata depth limit]";
  if (value instanceof Uint8Array) return "[redacted: binary payload]";
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[redacted: circular metadata]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeLogValue(item, seen, depth + 1))
      .filter((item): item is unknown => item !== undefined);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_META_KEY.test(key)) continue;
    const safe = sanitizeLogValue(item, seen, depth + 1);
    if (safe !== undefined) copy[key] = safe;
  }
  return copy;
}

/**
 * The four levels the SDK emits on.
 *
 * Every method takes a complete, human-readable message plus optional structured
 * detail, so a host can log the message as-is and never has to reconstruct a
 * sentence from fields.
 */
export interface GuardLogger {
  debug(message: string, meta?: GuardLogMeta): void;
  info(message: string, meta?: GuardLogMeta): void;
  warn(message: string, meta?: GuardLogMeta): void;
  error(message: string, meta?: GuardLogMeta): void;
}

/**
 * A host-supplied logger: any subset of the levels.
 *
 * Supplying only `warn`, say, is a supported configuration — the levels the host
 * left out are dropped rather than routed somewhere else.
 */
export type GuardLoggerInput = Partial<GuardLogger>;

/** The levels, in ascending severity. */
export const GUARD_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

/** One of the four levels the SDK emits on. */
export type GuardLogLevel = (typeof GUARD_LOG_LEVELS)[number];

function noop(): void {
  /* the whole point: nothing to do, nowhere to write */
}

/**
 * The logger a caller gets when they supplied none: every level is a no-op.
 *
 * Exported so a host can use it as an explicit "off" value (or as the identity
 * when composing loggers) without inventing its own empty object.
 */
export const SILENT_LOGGER: GuardLogger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
});

/**
 * Bind one host-supplied level, preserving its receiver and isolating its
 * failures.
 *
 * The method is invoked as `sink.call(input, ...)` rather than called detached:
 * real loggers (pino, winston, most wrappers) rely on `this` being the logger
 * instance, and extracting the function would break them in a way that only
 * shows up at runtime.
 *
 * A throw is swallowed. There is nowhere to report it — reporting it would mean
 * writing to the console, which is exactly what this module exists to stop — and
 * more importantly, a logging failure must never become the SDK's failure: it
 * cannot turn an admissible verdict into an error or a successful broadcast into
 * a rejected one.
 */
function bindLevel(
  input: GuardLoggerInput,
  level: GuardLogLevel,
): (message: string, meta?: GuardLogMeta) => void {
  const sink = input[level];
  if (typeof sink !== "function") return noop;
  return (message: string, meta?: GuardLogMeta): void => {
    try {
      sink.call(input, message, redactLogMeta(meta));
    } catch {
      /* advisory only: a broken sink must not decide whether a transaction runs */
    }
  };
}

/**
 * Resolve a caller's logger into the fully-populated, failure-isolated logger
 * the SDK calls.
 *
 * `undefined`/`null` yields `SILENT_LOGGER`, so callers never branch on whether
 * a logger exists. Missing levels become no-ops. Idempotent in effect: passing
 * an already-resolved logger back in produces an equivalent one.
 */
export function resolveLogger(input?: GuardLoggerInput | null): GuardLogger {
  if (!input) return SILENT_LOGGER;
  return {
    debug: bindLevel(input, "debug"),
    info: bindLevel(input, "info"),
    warn: bindLevel(input, "warn"),
    error: bindLevel(input, "error"),
  };
}
