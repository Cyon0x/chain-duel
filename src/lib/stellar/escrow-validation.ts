import { Address, TransactionBuilder, type Transaction, type FeeBumpTransaction, scValToNative } from "@stellar/stellar-sdk";
import { ChainDuelError } from "../services/errors";

/** Check the signed invocation against the server's game before sending any funds. */
export function validateEscrowTransaction(input: {
  signedXdr: string;
  networkPassphrase: string;
  contractId: string;
  address: string;
  gameIdHex: string;
  role: "creator" | "joiner";
  mode: number;
  entryStroops: number;
  preparedHash?: string | null;
  expiryLedger?: number | null;
  verificationVersion?: number;
  inputKeyHex?: string | null;
}): void {
  const invalid = () => new ChainDuelError("The signed transaction does not match this duel's entry. Prepare the entry again.", "invalid_escrow_transaction");
  try {
    const envelope = TransactionBuilder.fromXDR(input.signedXdr, input.networkPassphrase);
    const transaction = "innerTransaction" in envelope ? (envelope as FeeBumpTransaction).innerTransaction : envelope as Transaction;
    if (transaction.source !== input.address || transaction.operations.length !== 1) throw invalid();
    if (input.preparedHash && Buffer.from(transaction.hash()).toString("hex") !== input.preparedHash) throw invalid();
    const operation = transaction.operations[0];
    if (operation.type !== "invokeHostFunction" || (operation.source && operation.source !== input.address)) throw invalid();
    if (operation.func.type !== "hostFunctionTypeInvokeContract") throw invalid();
    const call = operation.func.invokeContract;
    const args = call.args.map((value) => scValToNative(value));
    const method = input.role === "creator" ? "create_game" : "join_game";
    if (Address.fromScAddress(call.contractAddress).toString() !== input.contractId || call.functionName.toString() !== method) throw invalid();
    if (args[0] !== input.address || !(args[1] instanceof Uint8Array) || Buffer.from(args[1]).toString("hex") !== input.gameIdHex) throw invalid();
    if (input.role === "creator") {
      if (args.length !== (input.verificationVersion === 1 ? 7 : 5) || args[2] !== input.mode || BigInt(args[3]) !== BigInt(input.entryStroops)) throw invalid();
      if (input.expiryLedger != null && args[4] !== input.expiryLedger) throw invalid();
    } else if (args.length !== (input.verificationVersion === 1 ? 4 : 2)) throw invalid();
    if (input.verificationVersion === 1) {
      const offset = input.role === "creator" ? 5 : 2;
      if (!(args[offset] instanceof Uint8Array) || args[offset].length !== 32 || !(args[offset + 1] instanceof Uint8Array) || args[offset + 1].length !== 64 || (input.inputKeyHex && Buffer.from(args[offset]).toString("hex") !== input.inputKeyHex)) throw invalid();
    }
  } catch {
    throw invalid();
  }
}
