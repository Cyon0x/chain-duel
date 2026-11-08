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
}): void {
  const invalid = () => new ChainDuelError("The signed transaction does not match this duel's entry. Prepare the entry again.", "invalid_escrow_transaction");
  try {
    const envelope = TransactionBuilder.fromXDR(input.signedXdr, input.networkPassphrase);
    const transaction = "innerTransaction" in envelope ? (envelope as FeeBumpTransaction).innerTransaction : envelope as Transaction;
    if (transaction.source !== input.address || transaction.operations.length !== 1) throw invalid();
    const operation = transaction.operations[0];
    if (operation.type !== "invokeHostFunction" || (operation.source && operation.source !== input.address)) throw invalid();
    if (operation.func.type !== "hostFunctionTypeInvokeContract") throw invalid();
    const call = operation.func.invokeContract;
    const args = call.args.map((value) => scValToNative(value));
    const method = input.role === "creator" ? "create_game" : "join_game";
    if (Address.fromScAddress(call.contractAddress).toString() !== input.contractId || call.functionName.toString() !== method) throw invalid();
    if (args[0] !== input.address || !(args[1] instanceof Uint8Array) || Buffer.from(args[1]).toString("hex") !== input.gameIdHex) throw invalid();
    if (input.role === "creator") {
      if (args.length !== 5 || args[2] !== input.mode || BigInt(args[3]) !== BigInt(input.entryStroops)) throw invalid();
    } else if (args.length !== 2) throw invalid();
  } catch {
    throw invalid();
  }
}
