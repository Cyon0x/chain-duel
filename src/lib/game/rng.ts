/**
 * Two kinds of randomness, deliberately separated.
 *
 * 1. `mulberry32` / `hashSeed` — gameplay randomness. Fully deterministic so
 *    that both duelists receive an identical target stream and any party can
 *    replay a match and get the same result.
 * 2. `secureRandom` / `secureChance` — settlement randomness (e.g. the
 *    computer-opponent outcome draw). Backed by the platform CSPRNG and never
 *    by Math.random().
 */

export function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: string | number) {
    this.next = mulberry32(typeof seed === "number" ? seed : hashSeed(seed));
  }

  float(): number {
    return this.next();
  }

  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Weighted pick. Returns the index of the chosen entry. */
  weightedIndex(weights: number[]): number {
    const total = weights.reduce((sum, value) => sum + value, 0);
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i += 1) {
      roll -= weights[i];
      if (roll <= 0) return i;
    }
    return weights.length - 1;
  }
}

export function secureRandom(): number {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] / 4294967296;
}

export function secureChance(probability: number): boolean {
  return secureRandom() < Math.min(Math.max(probability, 0), 1);
}

export function secureSeed(bytes = 16): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return Array.from(buffer, (value) => value.toString(16).padStart(2, "0")).join("");
}

export function secureToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

const BASE64_URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64Url(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    output += BASE64_URL[a >> 2];
    output += BASE64_URL[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b !== undefined) output += BASE64_URL[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) output += BASE64_URL[c & 63];
  }
  return output;
}
