import "server-only";
import { Address, authorizeEntry, type Keypair, type xdr } from "@stellar/stellar-sdk";
import { STELLAR_DEPLOYMENT_ADMIN } from "./shared";

export function authorizationAddress(entry: xdr.SorobanAuthorizationEntry): string | null {
  const credentials = entry.credentials;
  if (credentials.type === "sorobanCredentialsSourceAccount") return null;
  if (credentials.type === "sorobanCredentialsAddress" || credentials.type === "sorobanCredentialsAddressV2") return Address.fromScAddress(credentials.value.address).toString();
  throw new Error("Unsupported Stellar authorization credentials.");
}

export function checkEntryApproval(entry: xdr.SorobanAuthorizationEntry, contractId: string, method: string, args: xdr.ScVal[]) {
  const fn = entry.rootInvocation.function;
  if (fn.type !== "sorobanAuthorizedFunctionTypeContractFn" || Address.fromScAddress(fn.value.contractAddress).toString() !== contractId || fn.value.functionName.toString() !== method || fn.value.args.length !== args.length || fn.value.args.some((arg, index) => Buffer.from(arg.toXdr()).toString("hex") !== Buffer.from(args[index].toXdr()).toString("hex"))) {
    throw new Error("The Stellar authorization does not match the approved game entry.");
  }
}

export async function authorizeGameEntry(entry: xdr.SorobanAuthorizationEntry, admin: Keypair, contractId: string, method: string, args: xdr.ScVal[], validUntil: number, passphrase: string) {
  if (authorizationAddress(entry) !== STELLAR_DEPLOYMENT_ADMIN) return entry;
  if (admin.publicKey() !== STELLAR_DEPLOYMENT_ADMIN || !["create_game", "join_game"].includes(method)) throw new Error("Invalid Stellar administrator approval.");
  checkEntryApproval(entry, contractId, method, args);
  if (entry.rootInvocation.subInvocations.length !== 0) throw new Error("A game approval cannot authorize additional administrator operations.");
  return authorizeEntry(entry, admin, validUntil, passphrase, STELLAR_DEPLOYMENT_ADMIN);
}
