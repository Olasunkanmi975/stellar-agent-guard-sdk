/**
 * Shared deterministic generators for seeded property tests.
 *
 * A red CI run must replay identically on a developer machine, so tests never
 * use `Math.random`. Each suite prints its own seed in the failure context.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A `bits`-wide unsigned bigint drawn from `rand`, exactly in `[0, 2**bits - 1]`. */
export function randomUint(rand: () => number, bits: number): bigint {
  let value = 0n;
  for (let remaining = bits; remaining > 0; remaining -= 32) {
    value = (value << 32n) | BigInt(Math.floor(rand() * 0x1_0000_0000));
  }
  const excess = (32 - (bits % 32)) % 32;
  return excess === 0 ? value : value >> BigInt(excess);
}
