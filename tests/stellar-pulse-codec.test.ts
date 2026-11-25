import { describe, expect, it } from "vitest";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { encodePulseTranscript, decodePulseTranscript, bytesHex, pulseEnrollmentMessage, pulseInputMessage, pulseRulesHash, hexBytes } from "@/lib/stellar/pulse-codec";

const contract = StrKey.encodeContract(new Uint8Array(32).fill(52));
const player = Keypair.fromRawEd25519Seed(new Uint8Array(32).fill(51));
const enrollment = { networkPassphrase: Networks.TESTNET, contractId: contract, gameIdHex: "22".repeat(32), player: player.publicKey(), seat: 1, publicKeyHex: bytesHex(player.rawPublicKey()) };
const input = { ...enrollment, seedHex: "33".repeat(32), keyEpoch: 0, sequence: 0, previousCommitment: "00".repeat(32), startedAtMs: 100000, deadlineMs: 180000, closed: true };
describe("Pulse authorization wire protocol", () => {
  it("uses the exact contract rules identifier", async () => expect(await pulseRulesHash()).toBe("afee79977ae6fcae953dbe98af5095a0546eb3d4c7bcbf28ff5906b5836689f1"));
  it("encodes stable hit-first order using exactly six bytes per event", () => {
    const encoded = encodePulseTranscript([{ targetId: 5, atMs: 500 }, { targetId: 2, atMs: 400 }], [{ atMs: 500 }, { atMs: 0 }]);
    expect(bytesHex(encoded)).toBe("000000000000000001900002000001f40005000001f40000");
    expect(decodePulseTranscript(encoded)).toEqual({ hits: [{ targetId: 2, atMs: 400 }, { targetId: 5, atMs: 500 }], misses: [{ atMs: 0 }, { atMs: 500 }] });
    expect(encodePulseTranscript([], Array.from({ length: 4000 }, () => ({ atMs: 0 })))).toHaveLength(24000);
  });
  it("rejects malformed timestamps, hit identifiers and excessive transcript size", () => {
    expect(() => encodePulseTranscript([{ targetId: 0, atMs: 10 }], [])).toThrow();
    expect(() => encodePulseTranscript([{ targetId: 2, atMs: 1.5 }], [])).toThrow();
    expect(() => encodePulseTranscript([], [{ atMs: 60401 }])).toThrow();
    expect(() => decodePulseTranscript(new Uint8Array(5))).toThrow();
    expect(() => hexBytes("AB", 1)).toThrow();
  });
  it("domain-separates enrollment from gameplay inputs", async () => {
    const transcript = encodePulseTranscript([], [{ atMs: 0 }]);
    const enrollmentBytes = await pulseEnrollmentMessage(enrollment); const inputBytes = await pulseInputMessage(input, transcript);
    expect(player.verify(inputBytes, player.sign(enrollmentBytes))).toBe(false);
    expect(player.verify(inputBytes, player.sign(inputBytes))).toBe(true);
  });
  it("binds every replay-sensitive field and the transcript to the player signature", async () => {
    const transcript = encodePulseTranscript([], [{ atMs: 0 }]); const message = await pulseInputMessage(input, transcript); const signature = player.sign(message);
    for (const patch of [{ networkPassphrase: Networks.PUBLIC }, { contractId: StrKey.encodeContract(new Uint8Array(32).fill(53)) }, { gameIdHex: "21".repeat(32) }, { seedHex: "34".repeat(32) }, { seat: 2 }, { keyEpoch: 1 }, { sequence: 1 }, { previousCommitment: "11".repeat(32) }, { startedAtMs: 100001 }, { deadlineMs: 180001 }, { closed: false }]) expect(player.verify(await pulseInputMessage({ ...input, ...patch }, transcript), signature)).toBe(false);
    expect(player.verify(await pulseInputMessage(input, encodePulseTranscript([], [{ atMs: 1 }])), signature)).toBe(false);
  });
});
