/** Shared, independently testable guards for Mainnet deployment. No key storage. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Account, Address, Asset, Keypair, Networks, Operation, StrKey, Transaction, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";

export const ADMIN = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
export const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
export const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";
export const MAINNET_RPC = "https://mainnet.sorobanrpc.com";
export const MAINNET_HORIZON = "https://horizon.stellar.org";
export const MAX_SPEND = 400_000_000n;
export const CONSTRUCTOR = Object.freeze({ admin: ADMIN, treasury: ADMIN, token: USDC, fee_bps: 1000, max_entry: "100000000000", max_payout: "200000000000", min_treasury_balance: "1000000000" });
export const digest = value => createHash("sha256").update(value).digest("hex");
export const json = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);

export function units(value) {
  assert(typeof value === "string" && /^\d+(?:\.\d{1,7})?$/.test(value), "Expected a nonnegative seven-decimal amount.");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0"));
}
export function decimal(value) {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  return `${sign}${absolute / 10_000_000n}.${(absolute % 10_000_000n).toString().padStart(7, "0")}`;
}

export function deriveContractId(salt) {
  assert(Buffer.from(salt).length === 32, "Deployment salt must have 32 bytes.");
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: Buffer.from(digest(Networks.PUBLIC), "hex"),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Address(ADMIN).toScAddress(), salt })),
  }));
  return StrKey.encodeContract(Buffer.from(digest(preimage.toXDR()), "hex"));
}

export function deploymentOperation(kind, identity, wasm) {
  if (kind === "trustline") return Operation.changeTrust({ asset: new Asset("USDC", ISSUER) });
  if (kind === "upload") {
    assert.equal(digest(wasm), identity.wasmSha256, "The upload bytes differ from the prepared artifact.");
    return Operation.uploadContractWasm({ wasm });
  }
  assert.equal(kind, "deploy", "Unknown deployment operation.");
  return Operation.createCustomContract({ address: new Address(ADMIN), salt: Buffer.from(identity.saltHex, "hex"), wasmHash: Buffer.from(identity.wasmSha256, "hex"), constructorArgs: [
    new Address(ADMIN).toScVal(), new Address(ADMIN).toScVal(), new Address(USDC).toScVal(),
    nativeToScVal(CONSTRUCTOR.fee_bps, { type: "u32" }),
    ...[CONSTRUCTOR.max_entry, CONSTRUCTOR.max_payout, CONSTRUCTOR.min_treasury_balance].map(value => nativeToScVal(BigInt(value), { type: "i128" })),
  ] });
}

export function assertIdentity(identity, artifactSha256, sourceSha256) {
  assert.equal(identity.networkPassphrase, Networks.PUBLIC, "Deployment network mismatch.");
  assert.equal(identity.admin, ADMIN, "A different deployment wallet is forbidden.");
  assert.equal(identity.wasmSha256, artifactSha256, "The prepared deployment uses a different artifact.");
  assert.equal(identity.sourceSha256, sourceSha256, "Contract sources changed after preparation; review the new artifact before deployment.");
  assert.deepEqual(identity.constructor, CONSTRUCTOR, "Deployment parameters differ from the authorized Mainnet configuration.");
  assert.equal(identity.contractId, deriveContractId(Buffer.from(identity.saltHex, "hex")), "The prepared contract ID does not match its source and salt.");
}

export function requireDeploymentReview(review, identity, maxSpend = MAX_SPEND) {
  assert.equal(review?.deploymentFingerprint, digest(json(identity)), "The deployment review does not identify this exact prepared deployment.");
  assert.equal(review.approvedForDeployment, true, "The immutable Mainnet contract has not cleared its deployment review.");
  assert.equal(review.verifierImplementation, "independent-contract-game-replay", "A trusted gameplay-verifier signature is not authorized for Mainnet settlement.");
  assert.equal(review.independentOutcomeVerification, true, "Independent contract game verification must pass before Mainnet deployment.");
  assert.equal(review.testnetEndToEndVerified, true, "The owner requires complete Testnet verification before Mainnet deployment.");
  assert.equal(review.mainnetDeploymentApproved, true, "The new architecture requires explicit owner Mainnet approval after security review.");
  assert(typeof review.mainnetApprovalReference === "string" && review.mainnetApprovalReference.trim().length > 20, "The explicit owner Mainnet approval must be recorded.");
  assert.equal(review.maxSpendXlm, decimal(maxSpend), "Deployment review has a different expenditure cap.");
  assert.equal(review.offlineChecksPassed, true, "Complete the contract and application checks before Mainnet deployment.");
}

export function assertBudget({ balance, reserve, liabilities = 0n, committedFees = 0n, nextFee, futureFees = 0n, maxSpend = MAX_SPEND }) {
  assert(nextFee >= 0n && committedFees >= 0n && futureFees >= 0n && maxSpend > 0n, "Invalid deployment fee budget.");
  assert(committedFees + nextFee + futureFees <= maxSpend, `The deployment would exceed the total ${decimal(maxSpend).replace(/\.0+$/, "")} XLM expenditure cap.`);
  assert(balance - reserve - liabilities >= nextFee + futureFees, "The designated wallet cannot cover deployment while preserving its account reserves and liabilities.");
}

export function assertConfiguredRoles(config) {
  for (const name of ["admin", "treasury", "protocol_fee_recipient", "ecosystem_fee_recipient", "ecosystem_beneficiary"]) assert.equal(config[name], ADMIN, `Unexpected ${name} on the deployed contract.`);
  assert.equal(config.token, USDC, "Deployed token is not the official Mainnet USDC SAC.");
  for (const [name, value] of Object.entries({ fee_bps: 1000, protocol_fee_bps: 500, ecosystem_fee_bps: 500, max_entry: CONSTRUCTOR.max_entry, max_payout: CONSTRUCTOR.max_payout, min_treasury_balance: CONSTRUCTOR.min_treasury_balance })) assert.equal(String(config[name]), String(value), `Unexpected deployed ${name}.`);
  assert.equal(config.paused, false, "The fresh contract is unexpectedly paused.");
  assert.equal(config.bot_enabled, true, "The fresh contract has changed the existing computer-game configuration.");
}

export function assertDeploymentTransaction(signedXdr, kind, identity, wasm, { requireSignature = true, maxSpend = MAX_SPEND } = {}) {
  const tx = TransactionBuilder.fromXDR(signedXdr, Networks.PUBLIC);
  assert(tx instanceof Transaction, "Fee-bumped or unrelated transaction envelopes are not allowed by the deployment runner.");
  assert.equal(tx.source, ADMIN, "The deployment transaction has another source wallet.");
  assert.equal(tx.operations.length, 1, "A deployment transaction must contain exactly one approved operation.");
  const expectedOp = deploymentOperation(kind, identity, wasm);
  const expected = new TransactionBuilder(new Account(ADMIN, "0"), { fee: "100", networkPassphrase: Networks.PUBLIC }).addOperation(expectedOp).setTimeout(180).build().operations[0];
  const actual = tx.operations[0];
  assert(!actual.source || actual.source === ADMIN, "A deployment operation uses a different source wallet.");
  assert.equal(actual.type, expected.type, "The signed deployment operation changed type.");
  if (actual.type === "invokeHostFunction") {
    assert.equal(actual.func.toXDR("base64"), expected.func.toXDR("base64"), "The signed host function differs from the approved deployment.");
    assert((actual.auth ?? []).every(entry => entry.credentials.type === "sorobanCredentialsSourceAccount"), "Deployment authorization must come only from its designated source account.");
  } else {
    assert.equal(tx.toEnvelope().value.tx.operations[0].toXDR("base64"), expectedOp.toXDR("base64"), "The trustline operation differs from the official Mainnet USDC asset.");
  }
  assert(tx.timeBounds && Number(tx.timeBounds.maxTime) > 0, "Deployment transactions must expire.");
  if (requireSignature) {
    assert(tx.signatures.some(signature => Keypair.fromPublicKey(ADMIN).verify(tx.hash(), signature.signature)), "The transaction lacks the designated wallet's valid signature.");
    assert(BigInt(tx.fee) <= maxSpend, "The saved deployment transaction exceeds the expenditure cap.");
  }
  return tx;
}

/** A lost send response is never evidence of failure. Only an included receipt,
 * or absence on both infrastructures after they have passed the expiry time,
 * permits retirement of a previously signed attempt. */
export async function recoverAttempt(attempt, infrastructure, now = Date.now()) {
  const [receipt, horizon] = await Promise.all([
    infrastructure.rpcGet(attempt.hash), infrastructure.horizonGet(attempt.hash),
  ]);
  if (receipt.status !== "NOT_FOUND") {
    assert.equal(receipt.txHash, attempt.hash, "The RPC receipt hash differs from the saved deployment.");
    assert.equal(receipt.envelopeXdr.toXDR("base64"), attempt.signedXdr, "The RPC receipt contains different signed bytes.");
  }
  if (horizon) {
    assert.equal(horizon.hash, attempt.hash, "The Horizon receipt hash differs from the saved deployment.");
    assert.equal(horizon.envelope_xdr, attempt.signedXdr, "The Horizon receipt contains different signed bytes.");
    if (receipt.status !== "NOT_FOUND") assert.equal(horizon.successful, receipt.status === "SUCCESS", "Mainnet infrastructures disagree about the transaction result.");
    return { status: horizon.successful ? "confirmed" : "failed", hash: attempt.hash, ledger: Number(horizon.ledger), createdAt: horizon.created_at, horizonFeeChargedUnits: String(horizon.fee_charged), independentlyVerified: true };
  }
  // Wait for Horizon even if RPC reports inclusion. Never retire an included
  // transaction merely because a second indexer has not caught up yet.
  if (receipt.status !== "NOT_FOUND" || !attempt.maxTime || now <= Number(attempt.maxTime) * 1000 + 20000) return { status: "pending", hash: attempt.hash };
  const ledger = await infrastructure.horizonLatestLedger();
  if (Date.parse(ledger.closed_at) <= Number(attempt.maxTime) * 1000 || receipt.latestLedgerCloseTime <= Number(attempt.maxTime)) return { status: "pending", hash: attempt.hash };
  return { status: "expired", hash: attempt.hash, independentlyVerified: true, horizonLedger: Number(ledger.sequence), rpcLedger: receipt.latestLedger };
}
