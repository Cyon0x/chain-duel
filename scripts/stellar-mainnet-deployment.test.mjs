import assert from "node:assert/strict";
import { test } from "node:test";
import { Account, Address, Networks, Operation, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { ADMIN, USDC, CONSTRUCTOR, MAX_SPEND, assertBudget, assertConfiguredRoles, assertDeploymentTransaction, assertIdentity, decimal, deploymentOperation, deriveContractId, digest, json, recoverAttempt, requireDeploymentReview, units } from "./stellar-mainnet-deployment.mjs";

// Public addresses, unsigned fixture envelopes and fake receipts only. These
// tests do not create deployment wallets, read signing keys or access Mainnet.
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
const salt = Buffer.alloc(32,1);
const identity = { admin: ADMIN, networkPassphrase: Networks.PUBLIC, wasmSha256: digest(wasm), sourceSha256: "ab".repeat(32), saltHex: salt.toString("hex"), contractId: deriveContractId(salt), constructor: CONSTRUCTOR };
const tx = operation => new TransactionBuilder(new Account(ADMIN,"1"), { fee: "100", networkPassphrase: Networks.PUBLIC }).addOperation(operation).setTimeout(180).build();
const attempt = { hash: "f1".repeat(32), signedXdr: "persisted-exact-envelope", maxTime: 1000 };
const missing = { status: "NOT_FOUND", latestLedger: 900, latestLedgerCloseTime: 1001 };
const included = { status: "SUCCESS", txHash: attempt.hash, ledger: 800, envelopeXdr: { toXDR: () => attempt.signedXdr } };
const horizon = { hash: attempt.hash, envelope_xdr: attempt.signedXdr, successful: true, ledger: 800, created_at: "1970-01-01T00:16:39Z", fee_charged: "100" };
const infrastructure = (receipt = missing, result = null, closeTime = 1001) => ({ rpcGet: async () => receipt, horizonGet: async () => result, horizonLatestLedger: async () => ({ sequence: 900, closed_at: new Date(closeTime*1000).toISOString() }) });

test("a funded plan preserves the USDC trustline reserve as well as the XLM fee cap", () => {
  assertBudget({ balance: units("54.8267381"), reserve: units("1.5"), nextFee: units("34.4780897") });
  assert.throws(() => assertBudget({ balance: units("41"), reserve: units("1.5"), nextFee: MAX_SPEND }), /reserves/);
  assert.throws(() => assertBudget({ balance: units("100"), reserve: units("1.5"), committedFees: units("31"), nextFee: units("10") }), /40 XLM/);
  assert.throws(() => assertBudget({ balance: units("54"), reserve: units("1.5"), liabilities: units("20"), nextFee: units("34") }), /liabilities/);
  const currentQuote = { balance: units("119.8267381"), reserve: units("1.5"), nextFee: units("52.6051212"), futureFees: units("44.0641465"), maxSpend: units("110") };
  assertBudget(currentQuote);
  assert.throws(() => assertBudget({ ...currentQuote, balance: units("54.8267381") }), /reserves/);
  assert.throws(() => assertBudget({ ...currentQuote, committedFees: units("20") }), /110 XLM/);
  assert.throws(() => units("1.00000001"), /seven-decimal/);
  assert.equal(decimal(units("54.8267381")), "54.8267381");
});

test("the contract address is bound to the exact designated source, Mainnet and saved salt", () => {
  assert.equal(identity.contractId,"CD62OJF23OMCTHHK2DAHQYWYVP6RKESYRR5QCBWU5VB4A4MWB4JTNEOP");
  assertIdentity(identity,digest(wasm),identity.sourceSha256);
  assert.throws(() => assertIdentity({ ...identity, admin: USDC },digest(wasm),identity.sourceSha256), /different deployment wallet/);
  assert.throws(() => assertIdentity({ ...identity, networkPassphrase: Networks.TESTNET },digest(wasm),identity.sourceSha256), /network mismatch/);
  assert.throws(() => assertIdentity(identity,digest(Buffer.from("changed")),identity.sourceSha256), /different artifact/);
  assert.throws(() => assertIdentity(identity,digest(wasm),"changed source"), /sources changed/);
  assert.throws(() => assertIdentity({ ...identity, constructor: { ...CONSTRUCTOR, token: ADMIN } },digest(wasm),identity.sourceSha256), /parameters differ/);
});

test("funding or the prior authorization cannot deploy a trusted oracle or bypass the new Testnet-first review", () => {
  const review = { deploymentFingerprint: digest(json(identity)), approvedForDeployment: true, ownerSettlementDecision: null, ownerDecisionReference: "Mainnet deployment is authorized", maxSpendXlm: "40.0000000", offlineChecksPassed: true };
  assert.throws(() => requireDeploymentReview(review,identity), /gameplay-verifier/);
  const rejectedOracle = { ...review, ownerSettlementDecision: "accepted-existing-trusted-backend-verifier" };
  assert.throws(() => requireDeploymentReview(rejectedOracle,identity), /not authorized/);
  const accepted = { ...review, verifierImplementation:"independent-contract-game-replay", independentOutcomeVerification:true, testnetEndToEndVerified:true, mainnetDeploymentApproved:true, mainnetApprovalReference:"Explicit owner Mainnet approval after reviewing the verified Testnet evidence." };
  requireDeploymentReview(accepted,identity);
  assert.throws(() => requireDeploymentReview(accepted, identity, units("110")), /different expenditure cap/);
  requireDeploymentReview({ ...accepted, maxSpendXlm: "110.0000000" }, identity, units("110"));
  assert.throws(() => requireDeploymentReview({...accepted,testnetEndToEndVerified:false},identity),/complete Testnet/);
  assert.throws(() => requireDeploymentReview({...accepted,mainnetDeploymentApproved:false},identity),/explicit owner Mainnet/);
  assert.throws(() => requireDeploymentReview({ ...accepted, deploymentFingerprint: "different" },identity), /exact prepared deployment/);
  assert.throws(() => requireDeploymentReview({ ...accepted, offlineChecksPassed: false },identity), /checks before/);
});

test("initialization cannot substitute another fee holder or silently change the game limits", () => {
  const config = { ...CONSTRUCTOR, protocol_fee_recipient: ADMIN, ecosystem_fee_recipient: ADMIN, ecosystem_beneficiary: ADMIN, protocol_fee_bps: 500, ecosystem_fee_bps: 500, paused: false, bot_enabled: true };
  assertConfiguredRoles(config);
  assert.throws(() => assertConfiguredRoles({ ...config, ecosystem_beneficiary: USDC }), /ecosystem_beneficiary/);
  assert.throws(() => assertConfiguredRoles({ ...config, protocol_fee_bps: 1000, ecosystem_fee_bps: 0 }), /protocol_fee_bps/);
  assert.throws(() => assertConfiguredRoles({ ...config, max_entry: "200000000000" }), /max_entry/);
});

test("an unsigned quote must contain only the exact upload or atomic constructor", () => {
  for (const kind of ["upload","deploy","trustline"]) assertDeploymentTransaction(tx(deploymentOperation(kind,identity,wasm)).toXDR(),kind,identity,wasm,{ requireSignature:false });
  assert.throws(() => assertDeploymentTransaction(tx(deploymentOperation("upload",identity,wasm)).toXDR(),"upload",identity,wasm), /valid signature/);
  const changed = Operation.createCustomContract({ address: new Address(ADMIN), wasmHash: Buffer.from(identity.wasmSha256,"hex"), salt, constructorArgs: [new Address(ADMIN).toScVal(),new Address(ADMIN).toScVal(),new Address(USDC).toScVal(),nativeToScVal(2000,{type:"u32"})] });
  assert.throws(() => assertDeploymentTransaction(tx(changed).toXDR(),"deploy",identity,wasm,{requireSignature:false}), /host function differs/);
  const multi = new TransactionBuilder(new Account(ADMIN,"1"),{fee:"200",networkPassphrase:Networks.PUBLIC}).addOperation(deploymentOperation("upload",identity,wasm)).addOperation(deploymentOperation("trustline",identity,wasm)).setTimeout(180);
  // An extra operation is rejected before its contents can receive authority.
  assert.throws(() => assertDeploymentTransaction(multi.build().toXDR(),"upload",identity,wasm,{requireSignature:false}), /exactly one/);
});

test("a lost submission response remains pending until both Mainnet indexers prove expiry", async () => {
  assert.equal((await recoverAttempt(attempt,infrastructure(),1_010_000)).status,"pending");
  assert.equal((await recoverAttempt(attempt,infrastructure(missing,null,999),1_030_000)).status,"pending");
  assert.equal((await recoverAttempt(attempt,infrastructure({ ...missing, latestLedgerCloseTime:999 }),1_030_000)).status,"pending");
  assert.equal((await recoverAttempt(attempt,infrastructure(),1_030_000)).status,"expired");
});

test("an included transaction is never retired while Horizon catches up", async () => {
  assert.equal((await recoverAttempt(attempt,infrastructure(included,null),2_000_000)).status,"pending");
  assert.equal((await recoverAttempt(attempt,infrastructure(included,horizon),2_000_000)).status,"confirmed");
});

test("old confirmed receipts recover through Horizon after falling outside the RPC retention window", async () => {
  const result = await recoverAttempt(attempt,infrastructure(missing,horizon),2_000_000);
  assert.equal(result.status,"confirmed");
  assert.equal(result.independentlyVerified,true);
  assert.equal(result.hash,attempt.hash);
});

test("different receipts, envelope substitutions and inconsistent infrastructure results stop recovery", async () => {
  await assert.rejects(recoverAttempt(attempt,infrastructure({ ...included, txHash:"a1".repeat(32) },horizon)),/RPC receipt hash/);
  await assert.rejects(recoverAttempt(attempt,infrastructure(included,{ ...horizon, envelope_xdr:"different-envelope" })),/different signed bytes/);
  await assert.rejects(recoverAttempt(attempt,infrastructure(included,{ ...horizon, successful:false })),/infrastructures disagree/);
  const failed = await recoverAttempt(attempt,infrastructure({ ...included, status:"FAILED" },{ ...horizon, successful:false }));
  assert.equal(failed.status,"failed");
});
