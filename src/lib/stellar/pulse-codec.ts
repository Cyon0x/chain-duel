import { Address } from "@stellar/stellar-sdk";
import type { HitRecord, MissRecord } from "../game/pulse";

export const PULSE_RULES_LABEL = "ChainDuel:Pulse:v1|FNV1a_UTF16|Mulberry32|60000|3200|pace=1.25|blue=10,62,1200|gold=25,18,920|red=-15,20,1360|spawn=496,.78,1.24|max_visible=4|pressure=1.9|min_reaction=70|combo=1760,3:1.2,5:1.5,8:2|VEX7=200,.915,.935,.015,.7,40|winner=score,combo,seat1";
export const PULSE_EVENT_BYTES = 6;
export const PULSE_MAX_EVENTS = 4000;
const encoder = new TextEncoder();

export const bytesHex = (bytes: Uint8Array): string => Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
export function hexBytes(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(value) || (length !== undefined && value.length !== length * 2)) throw new Error("Invalid Pulse authorization bytes.");
  return Uint8Array.from(value.match(/.{2}/g) ?? [], pair => Number.parseInt(pair, 16));
}
export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}
export async function pulseRulesHash(): Promise<string> { return bytesHex(await sha256(encoder.encode(PULSE_RULES_LABEL))); }
function concatenate(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function u32(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error("Invalid Pulse sequence or seat.");
  const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes;
}
function u64(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid Pulse deadline.");
  const bytes = new Uint8Array(8); new DataView(bytes.buffer).setBigUint64(0, BigInt(value)); return bytes;
}
const addressXdr = (address: string) => new Uint8Array(new Address(address).toScVal().toXdr());

/** Stable hit-first order exactly matches the existing TypeScript verifier. */
export function encodePulseTranscript(hits: HitRecord[], misses: MissRecord[]): Uint8Array<ArrayBuffer> {
  if (hits.length > 1500 || hits.length + misses.length > PULSE_MAX_EVENTS) throw new Error("The Pulse event log exceeds the existing game limit.");
  const events = [...hits.map(hit => ({ atMs: hit.atMs, targetId: hit.targetId })), ...misses.map(miss => ({ atMs: miss.atMs, targetId: 0 }))].sort((a, b) => a.atMs - b.atMs);
  const bytes = new Uint8Array(events.length * PULSE_EVENT_BYTES); const view = new DataView(bytes.buffer);
  events.forEach((event, index) => {
    if (!Number.isInteger(event.atMs) || event.atMs < 0 || event.atMs > 60400 || !Number.isInteger(event.targetId) || event.targetId < 0 || event.targetId > 65535) throw new Error("Invalid Pulse input.");
    view.setUint32(index * PULSE_EVENT_BYTES, event.atMs); view.setUint16(index * PULSE_EVENT_BYTES + 4, event.targetId);
  });
  if (hits.some(hit => hit.targetId === 0)) throw new Error("A hit must name a target.");
  return bytes;
}
export function decodePulseTranscript(bytes: Uint8Array): { hits: HitRecord[]; misses: MissRecord[] } {
  if (bytes.length % PULSE_EVENT_BYTES || bytes.length > PULSE_MAX_EVENTS * PULSE_EVENT_BYTES) throw new Error("Invalid Pulse transcript length.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hits: HitRecord[] = []; const misses: MissRecord[] = [];
  for (let offset = 0; offset < bytes.length; offset += PULSE_EVENT_BYTES) {
    const atMs = view.getUint32(offset); const targetId = view.getUint16(offset + 4);
    if (targetId) hits.push({ targetId, atMs }); else misses.push({ atMs });
  }
  return { hits, misses };
}

export interface PulseEnrollmentContext { networkPassphrase: string; contractId: string; gameIdHex: string; player: string; seat: number; publicKeyHex: string }
export async function pulseEnrollmentMessage(input: PulseEnrollmentContext): Promise<Uint8Array<ArrayBuffer>> {
  if (input.seat !== 1 && input.seat !== 2) throw new Error("Invalid Pulse participant seat.");
  return concatenate([encoder.encode("ChainDuel:Pulse:Enroll:v1\0"), await sha256(encoder.encode(input.networkPassphrase)), addressXdr(input.contractId), hexBytes(input.gameIdHex, 32), addressXdr(input.player), u32(input.seat), hexBytes(input.publicKeyHex, 32), hexBytes(await pulseRulesHash(), 32)]);
}
export interface PulseInputContext extends Omit<PulseEnrollmentContext, "publicKeyHex"> {
  seedHex: string; keyEpoch: number; sequence: number; previousCommitment: string; startedAtMs: number; deadlineMs: number; closed: boolean;
}
export interface SignedPulseInputs { version: 1; player: string; sequence: number; closed: boolean; transcriptHex: string; signatureHex: string }
export async function pulseInputMessage(input: PulseInputContext, transcript: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (input.seat !== 1 && input.seat !== 2) throw new Error("Invalid Pulse participant seat.");
  if (transcript.length > PULSE_MAX_EVENTS * PULSE_EVENT_BYTES || transcript.length % PULSE_EVENT_BYTES) throw new Error("Invalid Pulse transcript length.");
  return concatenate([encoder.encode("ChainDuel:Pulse:Input:v1\0"), await sha256(encoder.encode(input.networkPassphrase)), addressXdr(input.contractId), hexBytes(input.gameIdHex, 32), hexBytes(input.seedHex, 32), addressXdr(input.player), u32(input.seat), u32(input.keyEpoch), u32(input.sequence), hexBytes(input.previousCommitment, 32), u64(input.startedAtMs), u64(input.deadlineMs), Uint8Array.of(input.closed ? 1 : 0), await sha256(transcript), hexBytes(await pulseRulesHash(), 32)]);
}
