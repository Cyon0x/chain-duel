/** Controlled Testnet deployment and verification. There is no Mainnet path. */
import assert from "node:assert/strict";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import { createRequire } from "node:module";
import Module from "node:module";
import ts from "typescript";
import { Address, BASE_FEE, Contract, Keypair, Networks, Operation, StrKey, TransactionBuilder, authorizeEntry, nativeToScVal, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";

globalThis.crypto ??= webcrypto;
const ROOT = resolve(import.meta.dirname, "..");
const ADMIN = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
const PLAYER = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const RPC = "https://soroban-testnet.stellar.org";
const HORIZON = "https://horizon-testnet.stellar.org";
const NETWORK = Networks.TESTNET;
const server = new rpc.Server(RPC);
const STATE_PATH = resolve(homedir(), ".local/state/chain-duel/stellar-verified-testnet/state.json");
const REPORT = resolve(ROOT, "docs/stellar-verified-deployments/testnet-evidence.json");
const WASM = resolve(ROOT, "contracts/chain_duel_mainnet/target/wasm32v1-none/release/chain_duel_mainnet.wasm");
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2);
const hex = value => Buffer.from(value).toString("hex");
const unit = value => { const [whole, fraction = ""] = value.split("."); return BigInt(whole) * 10000000n + BigInt(fraction.padEnd(7, "0")); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Run the actual shared TypeScript codecs/engine, never a copied JS verifier. */
const loaded = new Map();
function sharedModule(relative) {
  const path = resolve(ROOT, relative);
  if (loaded.has(path)) return loaded.get(path).exports;
  const compiled = new Module(path); loaded.set(path, compiled);
  const original = createRequire(path);
  compiled.require = name => name.startsWith(".") ? sharedModule(resolve(dirname(path), name) + (name.endsWith(".ts") ? "" : ".ts")) : original(name);
  const source = ts.sys.readFile(path); assert(source, "Shared verification source is unavailable.");
  compiled._compile(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, path);
  return compiled.exports;
}
const codec = sharedModule("src/lib/stellar/pulse-codec.ts");
const pulse = sharedModule("src/lib/game/pulse.ts");
const botEngine = sharedModule("src/lib/game/bot.ts");
const gameConfig = sharedModule("src/lib/config/game.ts");
const vault = sharedModule("src/lib/wallet/vault-crypto.ts");
const decodeState = sharedModule("src/lib/stellar/pulse-state.ts").decodeVerifiedPulseState;
let state;
async function save() {
  await mkdir(dirname(STATE_PATH), { recursive: true, mode: 0o700 });
  await writeFile(STATE_PATH, json(state), { mode: 0o600 });
  await mkdir(dirname(REPORT), { recursive: true });
  const { pending, ...publicState } = state;
  void pending;
  await writeFile(REPORT, json({ ...publicState, generatedAt: new Date().toISOString(), mainnetDeployed: false, walletAuthorityMigrated: false }));
}
async function horizon(path) {
  let response;
  for (let attempt = 0; attempt < 4; attempt++) {
    try { response = await fetch(`${HORIZON}/${path}`, { signal: AbortSignal.timeout(20000) }); if (response.ok || response.status === 404) break; }
    catch (error) { if (attempt === 3) throw error; }
    await pause(1000);
  }
  if (response.status === 404) return null;
  assert(response.ok, `Testnet Horizon returned HTTP ${response.status}`); return response.json();
}
async function balances(address) {
  const account = await horizon(`accounts/${address}`); assert(account?.account_id === address, "The designated Testnet account is unavailable.");
  const native = account.balances.find(value => value.asset_type === "native");
  const usdc = account.balances.find(value => value.asset_code === "USDC" && value.asset_issuer === ISSUER);
  return { address, xlm: native.balance, usdc: usdc?.balance ?? "0", usdcAuthorized: usdc?.is_authorized === true, subentries: account.subentry_count, signers: account.signers, thresholds: account.thresholds };
}
async function latestSequence() {
  // The SDK's public raw response avoids decoding an unused new SCP extension.
  const value = await server._getLatestLedger();
  assert(Number.isSafeInteger(value.sequence) && value.sequence > 0, "The current Testnet ledger sequence is invalid.");
  return value.sequence;
}
async function adminSigner() {
  const env = parseEnv(await readFile(resolve(ROOT, ".env.local"), "utf8"));
  try {
    const signer = Keypair.fromSecret((env.SETTLEMENT_SECRET_KEY ?? env.TREASURY_SECRET_KEY ?? "").trim());
    assert.equal(signer.publicKey(), ADMIN, "The existing signing configuration does not match the designated deployment wallet.");
    return signer;
  } catch { throw new Error("The existing designated deployment signing configuration is inaccessible; no replacement wallet is permitted."); }
}
async function controlledPlayerSigner() {
  // Owner-provided controlled Testnet signing material stays outside the game backend.
  const path = "/private/tmp/chain-duel-funded-stellar-export/export-result.json";
  assert.equal((await stat(path)).mode & 0o077, 0, "The controlled signing file must be private.");
  try {
    const material = JSON.parse(await readFile(path, "utf8")); const signer = Keypair.fromSecret(material.secretSeed);
    assert.equal(signer.publicKey(), PLAYER, "The controlled Testnet signer does not match the funded player address."); return signer;
  } catch { throw new Error("The existing controlled player signer is inaccessible. No signing secret will be exported or displayed."); }
}
const scBytes = value => nativeToScVal(Buffer.from(value, "hex"));
const scAddress = value => new Address(value).toScVal();
const scU32 = value => nativeToScVal(value, { type: "u32" });
const scAmount = value => nativeToScVal(BigInt(value), { type: "i128" });
async function read(method, args = []) {
  const transaction = new TransactionBuilder(await server.getAccount(ADMIN), { fee: BASE_FEE, networkPassphrase: NETWORK }).addOperation(new Contract(state.contractId).call(method, ...args)).setTimeout(120).build();
  const simulation = await server.simulateTransaction(transaction); assert(!rpc.Api.isSimulationError(simulation) && simulation.result, `Testnet read failed: ${method}`);
  return scValToNative(simulation.result.retval);
}
async function game(id) { return decodeState(await read("get_game", [scBytes(id)])); }
async function independentlyVerifyReceipt(txHash, expectedSuccess) {
  const stop = Date.now() + 90000;
  while (Date.now() < stop) {
    const [receipt, history] = await Promise.all([server.getTransaction(txHash), horizon(`transactions/${txHash}`)]);
    if (receipt.status !== "NOT_FOUND" && history) {
      assert.equal(receipt.txHash, txHash); assert.equal(history.hash, txHash);
      assert.equal(receipt.status === "SUCCESS", expectedSuccess); assert.equal(history.successful, expectedSuccess);
      return { hash: txHash, ledger: receipt.ledger, successful: expectedSuccess, horizonFeeChargedUnits: history.fee_charged, timestamp: history.created_at, rpcAndHorizonVerified: true };
    }
    await pause(1000);
  }
  throw new Error(`Testnet receipt confirmation is pending for ${txHash}; retain the saved envelope.`);
}
async function submit(label, transaction, signer, expectedSuccess = true, simulation = null) {
  assert.equal(transaction.networkPassphrase, NETWORK); assert([ADMIN, PLAYER].includes(transaction.source), "A controlled Testnet source is required.");
  assert(BigInt(transaction.fee) <= 1000000000n, "A Testnet transaction exceeds the 100-XLM verification fee cap.");
  const balanceBefore = await balances(transaction.source);
  assert(unit(balanceBefore.xlm) - BigInt(2 + balanceBefore.subentries) * 5000000n >= BigInt(transaction.fee), "The controlled wallet cannot cover this exact transaction quote while preserving reserves.");
  transaction.sign(signer); const signedXdr = transaction.toXdr(); const txHash = hex(transaction.hash());
  state.pending = { label, hash: txHash, signedXdr, expectedSuccess }; await save();
  const result = await server.sendTransaction(transaction);
  assert(result.status !== "ERROR", `Testnet rejected ${label} before inclusion.`);
  const receipt = await independentlyVerifyReceipt(txHash, expectedSuccess);
  const balanceAfter = await balances(transaction.source);
  state.transactions.push({ label, ...receipt, maxFeeUnits: transaction.fee, envelopeBytes: transaction.toEnvelope().toXdr().length,
    ...(simulation ? { simulatedMinResourceFeeUnits: simulation.minResourceFee, simulatedInstructions: simulation.transactionData?.build().resources.instructions } : {}) });
  Object.assign(state.transactions.at(-1), { source: transaction.source, sourceXlmBefore: balanceBefore.xlm, sourceXlmAfter: balanceAfter.xlm, sourceXlmSpentUnits: String(unit(balanceBefore.xlm) - unit(balanceAfter.xlm)) });
  state.pending = null; await save();
  process.stdout.write(`${label}: ${expectedSuccess ? "PASS" : "REJECTED AS EXPECTED"} ${txHash}\n`);
  return receipt;
}
async function assembled(source, operation) {
  const transaction = new TransactionBuilder(await server.getAccount(source), { fee: BASE_FEE, networkPassphrase: NETWORK }).addOperation(operation).setTimeout(180).build();
  const simulation = await server.simulateTransaction(transaction);
  assert(!rpc.Api.isSimulationError(simulation), `Testnet simulation rejected the prepared operation: ${rpc.Api.isSimulationError(simulation) ? simulation.error : ""}`);
  return { transaction: rpc.assembleTransaction(transaction, simulation).build(), simulation, original: transaction };
}
async function call(label, signer, method, args, admin) {
  const saved = state.transactions.find(value => value.label === label && value.successful);
  if (saved) return saved;
  const prepared = await assembled(signer.publicKey(), new Contract(state.contractId).call(method, ...args));
  const operation = prepared.original.operations[0]; const validUntil = await latestSequence() + 200;
  const auth = await Promise.all((prepared.simulation.result?.auth ?? []).map(async entry => {
    if (entry.credentials.type === "sorobanCredentialsSourceAccount") return entry;
    const address = Address.fromScAddress(entry.credentials.value.address).toString();
    assert.equal(address, ADMIN, "An unrelated external authorization appeared in a controlled game.");
    assert(admin && ["create_game", "join_game"].includes(method), "Only the designated administrator can co-authorize game entry.");
    const root = entry.rootInvocation.function;
    assert(root.type === "sorobanAuthorizedFunctionTypeContractFn" && Address.fromScAddress(root.value.contractAddress).toString() === state.contractId && root.value.functionName.toString() === method && root.value.args.every((arg, index) => hex(arg.toXdr()) === hex(args[index].toXdr())) && entry.rootInvocation.subInvocations.length === 0, "Unexpected administrator authorization tree.");
    return authorizeEntry(entry, admin, validUntil, NETWORK, ADMIN);
  }));
  const transaction = rpc.assembleTransaction(prepared.original, prepared.simulation).clearOperations().addOperation(Operation.invokeHostFunction({ func: operation.func, auth })).build();
  return submit(label, transaction, signer, true, prepared.simulation);
}
async function rejected(label, signer, method, args) {
  if (state.attacks.some(value => value.label === label && value.passed)) return;
  const transaction = new TransactionBuilder(await server.getAccount(signer.publicKey()), { fee: BASE_FEE, networkPassphrase: NETWORK }).addOperation(new Contract(state.contractId).call(method, ...args)).setTimeout(120).build();
  const simulation = await server.simulateTransaction(transaction); assert(rpc.Api.isSimulationError(simulation), `${label} unexpectedly passed contract simulation`);
  state.attacks.push({ label, expected: "REJECT", actual: "REJECT", passed: true, submitted: false, transactionHash: null, reason: simulation.error }); await save();
  process.stdout.write(`${label}: rejected by contract simulation\n`);
}
async function failedIncluded(label, signer, validMethod, validArgs, invalidMethod, invalidArgs) {
  const saved = state.transactions.find(value => value.label === label && !value.successful); if (saved) return saved;
  const prepared = await assembled(signer.publicKey(), new Contract(state.contractId).call(validMethod, ...validArgs));
  const bad = rpc.assembleTransaction(prepared.original, prepared.simulation).clearOperations().addOperation(new Contract(state.contractId).call(invalidMethod, ...invalidArgs)).build();
  return submit(label, bad, signer, false, prepared.simulation);
}
async function waitLedgerTime(timestampMs) {
  while (true) {
    const latest = await horizon("ledgers?order=desc&limit=1");
    if (Date.parse(latest._embedded.records[0].closed_at) >= timestampMs) return;
    await pause(Math.min(5000, Math.max(1000, timestampMs - Date.now())));
  }
}
async function createControlledGame(label, creator, opponent, admin, mode = 0, entry = 500000000n, expiryDelta = 500) {
  let recorded = state.games.find(value => value.label === label);
  if (!recorded) {
    const receipt = state.transactions.find(value => value.label === `${label}:create` && value.successful);
    if (receipt) {
      const transaction = await server.getTransaction(receipt.hash);
      assert(transaction.status === "SUCCESS" && transaction.returnValue, "The interrupted game creation receipt is unavailable.");
      const raw = scValToNative(transaction.returnValue); const id = hex(raw.id);
      recorded = { label, id, mode, creator: creator.publicKey(), opponent: opponent?.publicKey() ?? null, entryUnits: entry.toString() };
      state.games.push(recorded); await save();
    }
  }
  const id = recorded?.id ?? randomBytes(32).toString("hex");
  if (!recorded) { recorded = { label, id, mode, creator: creator.publicKey(), opponent: opponent?.publicKey() ?? null, entryUnits: entry.toString() }; state.games.push(recorded); await save(); }
  const credentials = [await vault.createStellarInputKey(creator.publicKey(), "testnet"), opponent ? await vault.createStellarInputKey(opponent.publicKey(), "testnet") : null];
  const proof = async (signer, seat, credential) => vault.signWithClientVault(credential, await codec.pulseEnrollmentMessage({ networkPassphrase: NETWORK, contractId: state.contractId, gameIdHex: id, player: signer.publicKey(), seat, publicKeyHex: credential.publicKeyHex }));
  const expiry = await latestSequence() + expiryDelta;
  await call(`${label}:create`, creator, "create_game", [scAddress(creator.publicKey()), scBytes(id), scU32(mode), scAmount(entry), scU32(expiry), scBytes(credentials[0].publicKeyHex), nativeToScVal(await proof(creator, 1, credentials[0]))], admin);
  if (opponent) await call(`${label}:join`, opponent, "join_game", [scAddress(opponent.publicKey()), scBytes(id), scBytes(credentials[1].publicKeyHex), nativeToScVal(await proof(opponent, 2, credentials[1]))], admin);
  // Input keys are never persisted. A resumed controlled test may rotate only
  // its own ephemeral game credential using the unchanged account authority.
  let current = await game(id);
  for (const [index, signer] of [creator, opponent].entries()) {
    if (!signer || !credentials[index] || current.status === 4 || current.status === 5 || current.status === 6) continue;
    const input = index === 0 ? current.one : current.two;
    if (!input.closed && input.publicKeyHex !== credentials[index].publicKeyHex) {
      const signature = await proof(signer, index + 1, credentials[index]);
      await call(`${label}:recover-input-epoch-${index + 1}-${input.keyEpoch + 1}`, signer, "rotate_input_key", [scBytes(id), scAddress(signer.publicKey()), scBytes(credentials[index].publicKeyHex), nativeToScVal(signature)]);
      current = await game(id);
    }
  }
  await save();
  return { label, id, credentials, creator, opponent };
}
async function signedInput(fixture, signer, seat, hits, misses, closed = true) {
  const current = await game(fixture.id); const input = seat === 1 ? current.one : current.two;
  const transcript = codec.encodePulseTranscript(hits, misses);
  const message = await codec.pulseInputMessage({ networkPassphrase: NETWORK, contractId: state.contractId, gameIdHex: fixture.id, seedHex: current.seedHex, player: signer.publicKey(), seat,
    keyEpoch: input.keyEpoch, sequence: input.sequence, previousCommitment: input.commitment, startedAtMs: current.startedAtMs, deadlineMs: current.deadlineMs, closed }, transcript);
  const signature = await vault.signWithClientVault(fixture.credentials[seat - 1], message);
  return { current, message, transcript, signature, args: [scBytes(fixture.id), scAddress(signer.publicKey()), scU32(input.sequence), nativeToScVal(closed), nativeToScVal(transcript), nativeToScVal(signature)] };
}
async function acceptInputs(fixture, signer, seat, hits, misses, closed = true) {
  const current = await game(fixture.id); const input = seat === 1 ? current.one : current.two;
  if (input.closed || state.transactions.some(value => value.label === `${fixture.label}:inputs-seat-${seat}` && value.successful)) return current;
  const authorization = await signedInput(fixture, signer, seat, hits, misses, closed);
  await call(`${fixture.label}:inputs-seat-${seat}`, signer, "submit_inputs", authorization.args);
  const result = await game(fixture.id); const accepted = seat === 1 ? result.one : result.two;
  assert.equal(accepted.commitment, hex(await codec.sha256(authorization.message)), "Accepted inputs differ from the player-authorized bytes.");
  return result;
}
function perfect(seed) { return pulse.buildTargetSchedule(seed, 60000).filter(target => target.points > 0 && target.spawnAtMs + 70 <= 60000).map(target => ({ targetId: target.id, atMs: Math.ceil(target.spawnAtMs + 70) })); }
async function verifyConfig() {
  const config = await read("get_config");
  for (const field of ["admin", "treasury", "protocol_fee_recipient", "ecosystem_fee_recipient", "ecosystem_beneficiary"]) assert.equal(config[field], ADMIN);
  assert.equal(config.token, USDC); assert.equal(config.fee_bps, 1000); assert.equal(config.protocol_fee_bps, 500); assert.equal(config.ecosystem_fee_bps, 500);
  assert.equal(hex(await read("get_rules_hash")), await codec.pulseRulesHash());
  const instance = (await server.getLedgerEntries(new Contract(state.contractId).getFootprint())).entries[0]?.val;
  assert(instance?.type === "contractData" && instance.contractData.val.type === "scvContractInstance");
  assert.equal(hex(instance.contractData.val.instance.executable.wasmHash.value), state.wasmSha256);
  assert.equal(await read("is_admin", [scAddress(ADMIN)]), true); assert.equal(await read("is_admin", [scAddress(PLAYER)]), false);
  state.onChainConfiguration = config; state.wasmIndependentlyVerified = true; await save();
}
async function runFinancialTests(admin, player) {
  assert(state.deployed && state.testStatus !== "complete", "This deployed Testnet test run was already completed; do not repeat transfers.");
  const initial = await Promise.all([balances(ADMIN), balances(PLAYER)]); assert(initial.every(value => value.usdcAuthorized && unit(value.usdc) >= 2500000000n), "Both controlled wallets need at least 250 official Testnet USDC.");
  state.initialFinancialBalances ??= initial; state.testStatus = "running"; await save();
  await call("bot-pool:fund-controlled-test-liquidity", admin, "fund_bot_pool", [scAddress(ADMIN), scAmount(2000000000n)]);
  const full = await createControlledGame("pvp-100-pot", admin, player, admin);
  await call(`${full.label}:start`, admin, "start_game", [scBytes(full.id)]);
  const fullState = await game(full.id);
  await waitLedgerTime(fullState.playStartMs + 1000);
  const legitimate = await signedInput(full, admin, 1, [], [{ atMs: 0 }], false);
  const forged = [...legitimate.args]; forged[5] = nativeToScVal(Buffer.alloc(64));
  const before = await read("get_contract_balance");
  const forgedAlreadyVerified = state.transactions.some(value => value.label === "forged-input:included-failure" && !value.successful);
  await failedIncluded("forged-input:included-failure", admin, "submit_inputs", legitimate.args, "submit_inputs", forged);
  if (!forgedAlreadyVerified) { assert.equal(await read("get_contract_balance"), before); assert.equal((await game(full.id)).one.sequence, 0); }
  const fabricated = [scBytes(full.id), scAddress(PLAYER), nativeToScVal(9999999, { type: "i64" }), nativeToScVal(0, { type: "i64" }), nativeToScVal(999999, { type: "i64" }), nativeToScVal(0, { type: "i64" }), scBytes("11".repeat(32))];
  const fabricatedAlreadyVerified = state.transactions.some(value => value.label === "original-fabricated-result:included-failure" && !value.successful);
  await failedIncluded("original-fabricated-result:included-failure", admin, "submit_inputs", legitimate.args, "settle_game", fabricated);
  if (!fabricatedAlreadyVerified) { assert.equal((await game(full.id)).status, 2); assert.equal(await read("get_contract_balance"), before); }
  await rejected("premature-settlement", admin, "settle_game", [scBytes(full.id)]);
  await acceptInputs(full, admin, 1, [], Array.from({ length: 4000 }, () => ({ atMs: 0 })));
  await waitLedgerTime(fullState.endAtMs + 1000);
  const inputs = perfect(fullState.seedHex);
  const expected = pulse.scoreMatch(fullState.seedHex, { hits: inputs, misses: [] }, { durationMs: 60000 });
  await acceptInputs(full, player, 2, inputs, []);
  await call("pvp-100-pot:settle", player, "settle_game", [scBytes(full.id)]);
  const settledFull = await game(full.id);
  assert.equal(settledFull.winner, PLAYER); assert.equal(settledFull.playerTwoScore, expected.score); assert.equal(settledFull.payout, "900000000"); assert.equal(settledFull.protocolFee, "50000000"); assert.equal(settledFull.ecosystemFee, "50000000");
  if (!state.winnerPayoutBalanceVerified) {
    const payoutTx = state.transactions.find(value => value.label === "pvp-100-pot:settle");
    const effects = await horizon(`transactions/${payoutTx.hash}/effects?limit=200`);
    assert(effects._embedded.records.some(value => value.type === "account_credited" && value.account === PLAYER && value.asset_code === "USDC" && value.asset_issuer === ISSUER && value.amount === "90.0000000"), "The winner did not receive the full verified 90-USDC payout."); state.winnerPayoutBalanceVerified = true; await save();
  }
  state.games.find(value => value.id === full.id).result = settledFull;
  await rejected("duplicate-settlement", admin, "settle_game", [scBytes(full.id)]);
  await rejected("closed-input-replay", admin, "submit_inputs", legitimate.args);
  const bot = await createControlledGame("independent-vex7", player, null, admin, 1, 250000000n);
  await call(`${bot.label}:start`, admin, "start_game", [scBytes(bot.id)]);
  const botState = await game(bot.id); await waitLedgerTime(botState.endAtMs + 1000);
  const humanInputs = perfect(botState.seedHex); await acceptInputs(bot, player, 1, humanInputs, []);
  await call("independent-vex7:settle", player, "settle_game", [scBytes(bot.id)]);
  const computer = new botEngine.PulseBot(botState.seedHex, gameConfig.DEFAULT_BOT, 60000); computer.update(60000);
  const botResult = await game(bot.id); assert.equal(botResult.playerTwoScore, computer.snapshot().score); assert.equal(botResult.playerTwoCombo, computer.snapshot().maxCombo);
  const humanScore = pulse.scoreMatch(botState.seedHex, { hits: humanInputs, misses: [] }, { durationMs: 60000 });
  assert.equal(botResult.playerOneScore, humanScore.score); assert.equal(botResult.playerOneCombo, humanScore.maxCombo);
  assert.equal(botResult.winner, humanScore.score > computer.snapshot().score || (humanScore.score === computer.snapshot().score && humanScore.maxCombo >= computer.snapshot().maxCombo) ? PLAYER : ADMIN);
  assert.equal(botResult.payout, "450000000"); assert.equal(botResult.protocolFee, "25000000"); assert.equal(botResult.ecosystemFee, "25000000");
  state.games.find(value => value.id === bot.id).result = botResult;
  const missing = await createControlledGame("missing-seat-two", admin, player, admin, 0, 250000000n);
  await call(`${missing.label}:start`, admin, "start_game", [scBytes(missing.id)]);
  const missingState = await game(missing.id);
  const first = perfect(missingState.seedHex)[0]; assert(first, "A realistic positive target is required by the controlled timeout test.");
  await waitLedgerTime(missingState.playStartMs + first.atMs + 1000);
  await acceptInputs(missing, admin, 1, [first], [], false);
  await rejected("unverified-active-refund", admin, "claim_refund", [scBytes(missing.id)]);
  await waitLedgerTime(missingState.deadlineMs + 1000); await call("missing-seat-two:deadline-settlement", player, "settle_game", [scBytes(missing.id)]);
  const absent = await game(missing.id); assert.equal(absent.playerTwoScore, 0); assert.equal(absent.winner, ADMIN);
  state.games.find(value => value.id === missing.id).result = absent;
  const tie = await createControlledGame("seat-one-tie", admin, player, admin, 0, 250000000n);
  await call(`${tie.label}:start`, admin, "start_game", [scBytes(tie.id)]);
  await waitLedgerTime((await game(tie.id)).playStartMs + 1000);
  await acceptInputs(tie, admin, 1, [], []); await acceptInputs(tie, player, 2, [], []);
  const refund = await createControlledGame("eligible-refund", player, null, admin, 0, 250000000n);
  await call("eligible-refund:cancel", player, "cancel_game", [scAddress(PLAYER), scBytes(refund.id)]);
  assert.equal((await game(refund.id)).status, 5);
  await waitLedgerTime((await game(tie.id)).endAtMs + 1000);
  await call("seat-one-tie:settle", player, "settle_game", [scBytes(tie.id)]); assert.equal((await game(tie.id)).winner, ADMIN);
  const protocol = BigInt(await read("get_protocol_fees")); const ecosystem = BigInt(await read("get_ecosystem_fees"));
  assert.equal(protocol, ecosystem); const adminBefore = unit((await balances(ADMIN)).usdc);
  await failedIncluded("unauthorized-protocol-withdrawal:included-failure", player, "withdraw_protocol_fees", [scBytes("31".repeat(32)), scAmount(1n)], "withdraw_protocol_fees", [scBytes("31".repeat(32)), scAmount(1n)]);
  await rejected("admin-cannot-withdraw-reserved-bot-liquidity", admin, "withdraw_bot_liquidity", [scAmount(BigInt(await read("get_bot_liquidity")) - 1000000000n + 1n), scBytes("32".repeat(32))]);
  await call("protocol-fees:withdraw-to-designated-wallet", admin, "withdraw_protocol_fees", [scBytes("33".repeat(32)), scAmount(protocol)]);
  await call("ecosystem-fees:withdraw-to-designated-wallet", admin, "withdraw_ecosystem_fees", [scBytes("34".repeat(32)), scAmount(ecosystem)]);
  assert.equal(unit((await balances(ADMIN)).usdc) - adminBefore, protocol + ecosystem);
  assert.equal(await read("get_protocol_fees"), 0n); assert.equal(await read("get_ecosystem_fees"), 0n); assert.equal(await read("get_locked_escrow"), 0n);
  await rejected("duplicate-fee-collection", admin, "withdraw_protocol_fees", [scBytes("33".repeat(32)), scAmount(1n)]);
  state.financialVerification = { winnerBps: 9000, protocolBps: 500, ecosystemBps: 500, totalAdminBps: 1000, feeRecipient: ADMIN,
    protocolWithdrawnUnits: protocol, ecosystemWithdrawnUnits: ecosystem, activeEscrowUnits: 0, feesAndLiabilitiesSeparated: true,
    fabricatedResultIncludedTransactionRejected: true, forgedInputIncludedTransactionRejected: true, botIndependentParity: true, missingInputsScoreZero: true,
    custodyLimitation: "Controlled owner signing tests use existing Testnet account authority. No legacy master was revoked; production player-custody cutover remains separately gated." };
  state.finalFinancialBalances = await Promise.all([balances(ADMIN), balances(PLAYER)]);
  state.testStatus = "complete"; await verifyConfig(); await save();
}

try {
  assert.equal((await server.getNetwork()).passphrase, NETWORK, "The deployment endpoint is not Stellar Testnet.");
  const wasm = await readFile(WASM); const wasmSha256 = hash(wasm);
  try { state = JSON.parse(await readFile(STATE_PATH, "utf8")); } catch { state = null; }
  if (!state) {
    const salt = randomBytes(32);
    const preimage = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({ networkId: Buffer.from(hash(NETWORK), "hex"), contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Address(ADMIN).toScAddress(), salt })) }));
    state = { network: "testnet", networkPassphrase: NETWORK, rpc: RPC, horizon: HORIZON, admin: ADMIN, token: USDC, issuer: ISSUER, wasmSha256, wasmBytes: wasm.length,
      saltHex: hex(salt), contractId: StrKey.encodeContract(Buffer.from(hash(preimage.toXdr()), "hex")), deployed: false, transactions: [], attacks: [], games: [], pending: null };
  }
  assert.equal(state.networkPassphrase, NETWORK); assert.equal(state.admin, ADMIN); assert.equal(state.wasmSha256, wasmSha256, "The artifact changed after preparation; reconcile the existing deployment first.");
  if (state.pending) {
    const envelope = TransactionBuilder.fromXDR(state.pending.signedXdr, NETWORK);
    await server.sendTransaction(envelope).catch(() => null);
    const receipt = await independentlyVerifyReceipt(state.pending.hash, state.pending.expectedSuccess);
    state.transactions.push({ label: state.pending.label, ...receipt, maxFeeUnits: envelope.fee, recovered: true }); state.pending = null; await save();
  }
  const action = process.argv[2] ?? "--prepare";
  assert(["--prepare", "--deploy", "--test", "--verify"].includes(action), "Use --prepare, --deploy, --test or --verify.");
  const admin = await adminSigner();
  if (action === "--prepare") {
    const account = await balances(ADMIN); const upload = await assembled(ADMIN, Operation.uploadContractWasm({ wasm }));
    state.preparation = { deploymentWallet: ADMIN, initialBalances: account, uploadMaxFeeUnits: upload.transaction.fee, constructorCostEstimateUnits: "60000000", totalFeeCapXlm: "100", rulesHash: await codec.pulseRulesHash(), irreversibleWalletChanges: false };
    assert(unit(account.xlm) - BigInt(2 + account.subentries) * 5000000n > BigInt(upload.transaction.fee) + 60000000n, "The existing Testnet wallet cannot cover the proposed deployment.");
    await save(); process.stdout.write(json({ ...state.preparation, contractId: state.contractId, wasmSha256 }) + "\n");
  } else if (action === "--deploy") {
    assert(state.preparation, "Prepare the exact Testnet artifact before deployment.");
    if (!state.transactions.some(value => value.label === "wasm:upload")) {
      const upload = await assembled(ADMIN, Operation.uploadContractWasm({ wasm })); await submit("wasm:upload", upload.transaction, admin, true, upload.simulation);
    }
    if (state.transactions.some(value => value.label === "escrow:atomic-deploy-and-initialize" && value.successful)) state.deployed = true;
    if (!state.deployed) {
      const operation = Operation.createCustomContract({ address: new Address(ADMIN), wasmHash: Buffer.from(wasmSha256, "hex"), salt: Buffer.from(state.saltHex, "hex"), constructorArgs: [scAddress(ADMIN), scAddress(ADMIN), scAddress(USDC), scU32(1000), scAmount(100000000000n), scAmount(200000000000n), scAmount(1000000000n)] });
      const deploy = await assembled(ADMIN, operation); await submit("escrow:atomic-deploy-and-initialize", deploy.transaction, admin, true, deploy.simulation);
      state.deployed = true; await save();
    }
    await verifyConfig(); process.stdout.write(`Verified Testnet escrow: ${state.contractId}\n`);
  } else if (action === "--verify") { assert(state.deployed); await verifyConfig(); process.stdout.write(`Testnet deployment independently verified: ${state.contractId}\n`); }
  else { assert(state.deployed); await verifyConfig(); await runFinancialTests(admin, await controlledPlayerSigner()); }
} catch (error) {
  const reason = String(error?.message ?? "Verification interrupted").replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED]");
  if (state) { state.lastError = reason; await save().catch(() => null); }
  process.stderr.write(`Testnet verification stopped: ${reason}\n`); process.exitCode = 1;
}
