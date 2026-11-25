/** Mainnet deployment with bounded fees, atomic initialization and durable recovery.
 * Default/--prepare and --verify are read-only on-chain. --execute requires the
 * exact review record and the existing designated signing configuration. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, fsyncSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Address, Asset, Contract, Keypair, Networks, TransactionBuilder, rpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import { Pool } from "pg";
import { ROOT, loadEnvFile } from "./lib.mjs";
import { ADMIN, ISSUER, USDC, MAINNET_RPC, MAINNET_HORIZON, CONSTRUCTOR, CONSTRUCTOR_ESTIMATE, MAX_SPEND, assertBudget, assertConfiguredRoles, assertDeploymentTransaction, assertIdentity, decimal, deploymentOperation, deriveContractId, digest, json, recoverAttempt, requireDeploymentReview, units } from "./stellar-mainnet-deployment.mjs";

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const execute = args.includes("--execute");
const verify = args.includes("--verify");
const env = Object.fromEntries(Object.entries(loadEnvFile(option("--env-file", resolve(ROOT, ".env.local")))).map(([key,value]) => [key, /^".*"$/.test(value) ? JSON.parse(value) : value]));
const server = new rpc.Server(MAINNET_RPC, { timeout: 20_000 });
const wasmPath = resolve(ROOT, "contracts/chain_duel_mainnet/target/wasm32v1-none/release/chain_duel_mainnet.wasm");
const privateDir = resolve(option("--state-dir", resolve(homedir(), ".local/state/chain-duel/stellar-mainnet")));
const statePath = resolve(privateDir, "deployment.json");
const lockPath = resolve(privateDir, "deployment.lock");
const planPath = resolve(option("--output", resolve(ROOT, "docs/stellar-mainnet-deployments/prepared-mainnet.json")));
const reviewPath = resolve(option("--review-file", resolve(ROOT, "docs/stellar-mainnet-deployments/approved-review-mainnet.json")));
const deploymentPath = resolve(ROOT, "docs/stellar-mainnet-deployments/deployment-mainnet.json");
const inclusionFee = "1000";
const sourceFiles = ["contracts/chain_duel_mainnet/src/lib.rs", "contracts/chain_duel_mainnet/src/verification.rs", "contracts/chain_duel_mainnet/src/test.rs", "contracts/chain_duel_mainnet/Cargo.toml", "contracts/chain_duel_mainnet/Cargo.lock", "contracts/chain_duel_mainnet/rust-toolchain.toml", "contracts/pulse_replay/src/lib.rs", "contracts/pulse_replay/src/test.rs", "contracts/pulse_replay/Cargo.toml", "contracts/pulse_replay/Cargo.lock", "scripts/stellar-build.mjs"];
let stage = "configuration";
let state;
let unlock;
let coordinator;

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), cache: "no-store" });
  if (response.status === 404) return null;
  assert(response.ok, `Mainnet read failed with HTTP ${response.status}.`);
  return response.json();
}

function savePrivate() {
  if (existsSync(statePath)) assert(!lstatSync(statePath).isSymbolicLink(), "The private deployment state must not be a symlink.");
  const temporary = resolve(privateDir, `.deployment-${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, "wx", 0o600);
  try { writeFileSync(descriptor, `${json(state)}\n`); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  renameSync(temporary, statePath);
  chmodSync(statePath, 0o600);
}

function acquireLocalLock() {
  const record = { pid: process.pid, hostname: hostname(), nonce: randomUUID(), createdAt: new Date().toISOString() };
  if (existsSync(lockPath)) {
    assert(!lstatSync(lockPath).isSymbolicLink(), "Deployment lock must not be a symlink.");
    const previous = JSON.parse(readFileSync(lockPath, "utf8"));
    assert(previous.hostname === hostname() && Number.isSafeInteger(previous.pid), "An existing deployment lock needs review.");
    let running = true;
    try { process.kill(previous.pid, 0); } catch (error) { if (error.code === "ESRCH") running = false; }
    assert(!running, "Another deployment runner is active; do not sign concurrently.");
    unlinkSync(lockPath);
  }
  const descriptor = openSync(lockPath, "wx", 0o600);
  try { writeFileSync(descriptor, json(record)); } finally { closeSync(descriptor); }
  return () => {
    if (existsSync(lockPath) && JSON.parse(readFileSync(lockPath, "utf8")).nonce === record.nonce) unlinkSync(lockPath);
  };
}

async function accountSnapshot() {
  const [account, ledgers] = await Promise.all([getJson(`${MAINNET_HORIZON}/accounts/${ADMIN}`), getJson(`${MAINNET_HORIZON}/ledgers?order=desc&limit=1`)]);
  assert(account?.account_id === ADMIN, "The designated wallet is not funded on Stellar Mainnet.");
  assert(account.signers.length === 1 && account.signers[0].key === ADMIN, "The deployment wallet has an unexpected external signer.");
  assert(account.signers[0].weight > 0 && Object.values(account.thresholds).every(threshold => threshold <= account.signers[0].weight), "The existing signer cannot authorize required deployment operations.");
  const ledger = ledgers._embedded.records[0];
  const baseReserve = BigInt(ledger.base_reserve_in_stroops);
  const native = account.balances.find(balance => balance.asset_type === "native");
  const line = account.balances.find(balance => balance.asset_code === "USDC" && balance.asset_issuer === ISSUER);
  const reserve = BigInt(2 + account.subentry_count + (account.num_sponsoring ?? 0) - (account.num_sponsored ?? 0)) * baseReserve;
  if (line) assert(line.is_authorized, "The designated USDC trustline is not authorized.");
  return { address: ADMIN, xlmBalance: native.balance, reserveXlm: decimal(reserve), availableBeforeFeesXlm: decimal(units(native.balance) - reserve - units(native.selling_liabilities ?? "0")), nativeSellingLiabilities: native.selling_liabilities ?? "0", usdcTrustline: Boolean(line), usdcBalance: line?.balance ?? "0.0000000", baseReserveXlm: decimal(baseReserve), sequence: account.sequence, ledger: Number(ledger.sequence), checkedAt: new Date().toISOString() };
}

async function readCall(id, method, values = []) {
  const tx = new TransactionBuilder(await server.getAccount(ADMIN), { fee: inclusionFee, networkPassphrase: Networks.PUBLIC }).addOperation(new Contract(id).call(method, ...values)).setTimeout(180).build();
  const simulation = await server.simulateTransaction(tx);
  assert(!rpc.Api.isSimulationError(simulation), `Mainnet simulation failed for ${method}.`);
  assert(!rpc.Api.isSimulationRestore(simulation), `Archived state needs restoration and fresh fee simulations before ${method}.`);
  assert(simulation.result?.retval, `No independent result for ${method}.`);
  return scValToNative(simulation.result.retval);
}

async function ledgerEntries() {
  const code = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(state.identity.wasmSha256, "hex") }));
  const instance = new Contract(state.identity.contractId).getFootprint();
  const result = await server.getLedgerEntries(code, instance);
  const find = key => result.entries.find(entry => entry.key.toXDR("base64") === key.toXDR("base64"));
  const codeEntry = find(code);
  const instanceEntry = find(instance);
  if (codeEntry) assert.equal(digest(await server.getContractWasmByHash(state.identity.wasmSha256)), state.identity.wasmSha256, "Mainnet uploaded code differs from the local reviewed artifact.");
  return { code: codeEntry ? { liveUntilLedger: codeEntry.liveUntilLedgerSeq, lastModifiedLedger: codeEntry.lastModifiedLedgerSeq } : null, instance: instanceEntry ? { liveUntilLedger: instanceEntry.liveUntilLedgerSeq, lastModifiedLedger: instanceEntry.lastModifiedLedgerSeq } : null, latestLedger: result.latestLedger };
}

async function verifyDeployment() {
  const entries = await ledgerEntries();
  assert(entries.code && entries.instance, "The exact prepared escrow is not independently present on Mainnet.");
  assert.equal(digest(await server.getContractWasmByContractId(state.identity.contractId)), state.identity.wasmSha256, "The Mainnet escrow executes a different WASM artifact.");
  const methods = ["get_config", "get_stats", "get_bot_liquidity", "get_locked_escrow", "get_protocol_fees", "get_ecosystem_fees", "get_contract_balance"];
  const values = await Promise.all(methods.map(method => readCall(state.identity.contractId, method)));
  const reads = Object.fromEntries(methods.map((method,index) => [method, values[index]]));
  assertConfiguredRoles(reads.get_config);
  const [isAdmin, playerIsAdmin] = await Promise.all([readCall(state.identity.contractId, "is_admin", [new Address(ADMIN).toScVal()]), readCall(state.identity.contractId, "is_admin", [new Address("GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK").toScVal()])]);
  assert.equal(isAdmin, true, "The designated wallet lacks Mainnet administration.");
  assert.equal(playerIsAdmin, false, "An ordinary player has Mainnet administration.");
  const accounted = BigInt(reads.get_bot_liquidity) + BigInt(reads.get_locked_escrow) + BigInt(reads.get_protocol_fees) + BigInt(reads.get_ecosystem_fees);
  assert(BigInt(reads.get_contract_balance) >= accounted, "Escrow liabilities exceed its official USDC balance.");
  if (!state.completedAt) for (const method of methods.slice(2)) assert.equal(BigInt(reads[method]), 0n, `Fresh initialization has nonzero ${method}; investigate before activating users.`);
  return { verifiedAt: new Date().toISOString(), ledgerEntries: entries, reads, administratorVerified: isAdmin, ordinaryPlayerIsAdmin: playerIsAdmin, accountingSolvent: true };
}

async function feeQuote(kind, wasm) {
  const unsigned = new TransactionBuilder(await server.getAccount(ADMIN), { fee: inclusionFee, networkPassphrase: Networks.PUBLIC }).addOperation(deploymentOperation(kind, state.identity, wasm)).setTimeout(180).build();
  if (kind === "trustline") return { transaction: unsigned, fee: BigInt(unsigned.fee), resourceFee: "0" };
  const simulation = await server.simulateTransaction(unsigned);
  assert(!rpc.Api.isSimulationError(simulation), `Exact Mainnet ${kind} simulation failed; no transaction was signed.`);
  assert(!rpc.Api.isSimulationRestore(simulation), `The ${kind} footprint needs restoration and a revised fee plan.`);
  const transaction = rpc.assembleTransaction(unsigned, simulation).build();
  assertDeploymentTransaction(transaction.toXDR(), kind, state.identity, wasm, { requireSignature: false });
  if (kind === "deploy") assert.equal(scValToNative(simulation.result.retval), state.identity.contractId, "Constructor simulation returned an unexpected contract address.");
  return { transaction, fee: BigInt(transaction.fee), resourceFee: simulation.minResourceFee, ledger: simulation.latestLedger };
}

const committedFees = () => state.attempts.filter(attempt => attempt.status !== "expired").reduce((total, attempt) => total + BigInt(attempt.feeUnits), 0n);
const receiptInfrastructure = {
  rpcGet: hash => server.getTransaction(hash),
  horizonGet: hash => getJson(`${MAINNET_HORIZON}/transactions/${hash}`),
  horizonLatestLedger: async () => (await getJson(`${MAINNET_HORIZON}/ledgers?order=desc&limit=1`))._embedded.records[0],
};

// This is the same durable lease/intent schema used by the application. The
// deployer must not race game settlement, payments or bridging for this account.
async function sharedCoordinator() {
  assert(env.STELLAR_SIGNER_DATABASE_URL && !env.STELLAR_SIGNER_DATABASE_URL.includes("[SENSITIVE]"), "Configure the existing shared Mainnet signing database before deployment.");
  const pool = new Pool({ connectionString: env.STELLAR_SIGNER_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, ssl: env.STELLAR_SIGNER_DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });
  const lease = `deployment:${randomUUID()}`;
  let heartbeat;
  try {
    await pool.query("CREATE TABLE IF NOT EXISTS stellar_signer_state(network_id TEXT NOT NULL,address TEXT NOT NULL,lease_owner TEXT,lease_until BIGINT,active_intent_id TEXT,PRIMARY KEY(network_id,address))");
    await pool.query("CREATE TABLE IF NOT EXISTS stellar_signer_intents(id TEXT PRIMARY KEY,network_id TEXT NOT NULL,address TEXT NOT NULL,contract_id TEXT NOT NULL,method TEXT NOT NULL,args_hash TEXT NOT NULL,signed_xdr TEXT,tx_hash TEXT,max_time BIGINT,status TEXT NOT NULL,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
    await pool.query("CREATE TABLE IF NOT EXISTS stellar_signer_attempts(tx_hash TEXT PRIMARY KEY,intent_id TEXT NOT NULL,signed_xdr TEXT NOT NULL,max_time BIGINT,status TEXT NOT NULL,archived_at TEXT NOT NULL)");
    await pool.query("INSERT INTO stellar_signer_state(network_id,address) VALUES('mainnet',$1) ON CONFLICT(network_id,address) DO NOTHING", [ADMIN]);
    const acquired = await pool.query("UPDATE stellar_signer_state SET lease_owner=$1,lease_until=$2 WHERE network_id='mainnet' AND address=$3 AND (lease_until IS NULL OR lease_until < $4) RETURNING active_intent_id", [lease, Date.now()+300000, ADMIN, Date.now()]);
    assert.equal(acquired.rowCount, 1, "Another application is signing for the designated Mainnet wallet; wait for its receipt.");
    const prefix = `stellar-mainnet-deployment:${digest(json(state.identity))}:`;
    assert(!acquired.rows[0].active_intent_id || acquired.rows[0].active_intent_id.startsWith(prefix), "A prior application transaction must be resolved before deployment.");
    heartbeat = setInterval(() => { void pool.query("UPDATE stellar_signer_state SET lease_until=$1 WHERE network_id='mainnet' AND address=$2 AND lease_owner=$3 AND lease_until > $4", [Date.now()+300000, ADMIN, lease, Date.now()]).catch(() => undefined); }, 15000);
    const assertLease = async () => {
      const owned = await pool.query("SELECT 1 FROM stellar_signer_state WHERE network_id='mainnet' AND address=$1 AND lease_owner=$2 AND lease_until > $3", [ADMIN,lease,Date.now()]);
      assert.equal(owned.rowCount, 1, "The deployment signing lease expired; recover the saved transaction before signing anything else.");
    };
    const intentId = kind => `${prefix}${kind}`;
    return {
      assertLease,
      persist: async attempt => {
        await assertLease();
        const id = intentId(attempt.kind);
        const current = (await pool.query("SELECT tx_hash FROM stellar_signer_intents WHERE id=$1", [id])).rows[0];
        assert(!current?.tx_hash || current.tx_hash === attempt.hash, "A different signed deployment attempt exists in the coordinator; investigate its receipt.");
        await pool.query("BEGIN");
        try {
          const now = new Date().toISOString();
          await pool.query("INSERT INTO stellar_signer_intents(id,network_id,address,contract_id,method,args_hash,signed_xdr,tx_hash,max_time,status,created_at,updated_at) VALUES($1,'mainnet',$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$9) ON CONFLICT(id) DO UPDATE SET signed_xdr=EXCLUDED.signed_xdr,tx_hash=EXCLUDED.tx_hash,max_time=EXCLUDED.max_time,status='prepared',updated_at=EXCLUDED.updated_at", [id,ADMIN,state.identity.contractId,`deployment:${attempt.kind}`,digest(json(state.identity)),attempt.signedXdr,attempt.hash,attempt.maxTime,now]);
          await pool.query("UPDATE stellar_signer_state SET active_intent_id=$1 WHERE network_id='mainnet' AND address=$2 AND lease_owner=$3", [id,ADMIN,lease]);
          await pool.query("COMMIT");
        } catch (error) { await pool.query("ROLLBACK"); throw error; }
      },
      finish: async attempt => {
        if (attempt.status === "pending") return;
        await assertLease();
        const id = intentId(attempt.kind);
        const result = attempt.status === "confirmed" ? json({ hash: attempt.hash, ledger: attempt.receipt.ledger, returnValue: null, status: "SUCCESS" }) : null;
        await pool.query("BEGIN");
        try {
          const now = new Date().toISOString();
          if (["expired","failed"].includes(attempt.status)) {
            await pool.query("INSERT INTO stellar_signer_attempts(tx_hash,intent_id,signed_xdr,max_time,status,archived_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tx_hash) DO NOTHING", [attempt.hash,id,attempt.signedXdr,attempt.maxTime,attempt.status,now]);
            await pool.query("UPDATE stellar_signer_intents SET tx_hash=NULL,signed_xdr=NULL,max_time=NULL,status='preparing',error=$1,updated_at=$2 WHERE id=$3 AND tx_hash=$4", [attempt.status,now,id,attempt.hash]);
          } else await pool.query("UPDATE stellar_signer_intents SET status='confirmed',result_json=$1,updated_at=$2 WHERE id=$3 AND tx_hash=$4", [result,now,id,attempt.hash]);
          await pool.query("UPDATE stellar_signer_state SET active_intent_id=NULL WHERE network_id='mainnet' AND address=$1 AND lease_owner=$2 AND active_intent_id=$3", [ADMIN,lease,id]);
          await pool.query("COMMIT");
        } catch (error) { await pool.query("ROLLBACK"); throw error; }
      },
      close: async () => { clearInterval(heartbeat); try { await pool.query("UPDATE stellar_signer_state SET lease_owner=NULL,lease_until=NULL WHERE network_id='mainnet' AND address=$1 AND lease_owner=$2", [ADMIN,lease]); } finally { await pool.end(); } },
    };
  } catch (error) {
    clearInterval(heartbeat);
    try { await pool.query("UPDATE stellar_signer_state SET lease_owner=NULL,lease_until=NULL WHERE network_id='mainnet' AND address=$1 AND lease_owner=$2", [ADMIN,lease]); } finally { await pool.end(); }
    throw error;
  }
}

async function recoverSaved(wasm) {
  for (const attempt of state.attempts) {
    assertDeploymentTransaction(attempt.signedXdr, attempt.kind, state.identity, wasm);
    if (attempt.status === "expired") continue;
    const receipt = await recoverAttempt(attempt, receiptInfrastructure);
    attempt.status = receipt.status;
    attempt.receipt = receipt;
    savePrivate();
    if (coordinator) await coordinator.finish(attempt);
    assert(receipt.status !== "pending", `Deployment transaction ${attempt.hash} still needs confirmation. Rerun --execute to rebroadcast the identical saved envelope.`);
  }
}

async function perform(kind, wasm, signer, { recoverOnly = false } = {}) {
  let attempt = state.attempts.findLast(item => item.kind === kind);
  if (attempt?.status === "confirmed") return;
  if (attempt && ["prepared","pending"].includes(attempt.status)) {
    const recovered = await recoverAttempt(attempt, receiptInfrastructure);
    attempt.status = recovered.status;
    attempt.receipt = recovered;
    savePrivate();
    if (recovered.status === "confirmed") { await coordinator.finish(attempt); return; }
    if (recovered.status !== "pending") {
      await coordinator.finish(attempt);
      if (recoverOnly) return;
      attempt = null;
    }
  } else attempt = null;
  if (!attempt && recoverOnly) return;
  if (!attempt) {
    const quote = await feeQuote(kind, wasm);
    const balance = await accountSnapshot();
    const reserve = units(balance.reserveXlm) + (kind === "trustline" && !balance.usdcTrustline ? units(balance.baseReserveXlm) : 0n);
    assertBudget({ balance: units(balance.xlmBalance), reserve, liabilities: units(balance.nativeSellingLiabilities), committedFees: committedFees(), nextFee: quote.fee });
    await coordinator.assertLease();
    assert(Number(quote.transaction.timeBounds.maxTime) > Date.now()/1000 + 30, "The simulated deployment envelope is too close to expiry; quote it again.");
    quote.transaction.sign(signer);
    const transaction = assertDeploymentTransaction(quote.transaction.toXDR(), kind, state.identity, wasm);
    attempt = { kind, hash: Buffer.from(transaction.hash()).toString("hex"), signedXdr: transaction.toXDR(), sequence: transaction.sequence, maxTime: Number(transaction.timeBounds.maxTime), feeUnits: transaction.fee, resourceFeeUnits: quote.resourceFee, simulatedAtLedger: quote.ledger ?? null, status: "prepared", preparedAt: new Date().toISOString() };
    state.attempts.push(attempt);
    savePrivate(); // Always persist exact bytes before any broadcast.
  }
  await coordinator.persist(attempt);
  const transaction = assertDeploymentTransaction(attempt.signedXdr, kind, state.identity, wasm);
  const deadline = Date.now()+100000;
  let lastSend = 0;
  while (Date.now() < deadline) {
    await coordinator.assertLease();
    if (Date.now()-lastSend > 12000 && Date.now() < attempt.maxTime*1000) {
      attempt.status = "pending";
      savePrivate();
      lastSend = Date.now();
      // A send error leaves the signed intent pending, never authorizes a fresh
      // salt, sequence or envelope. Resolve through both Mainnet infrastructures.
      await server.sendTransaction(transaction).catch(() => undefined);
    }
    const receipt = await recoverAttempt(attempt, receiptInfrastructure);
    if (receipt.status !== "pending") {
      attempt.status = receipt.status; attempt.receipt = receipt; savePrivate();
      await coordinator.finish(attempt);
      if (recoverOnly && receipt.status !== "confirmed") return;
      assert.equal(receipt.status, "confirmed", `The ${kind} transaction did not succeed; its receipt is saved for a bounded retry.`);
      console.log(json({ stage: kind, status: "SUCCESS", hash: attempt.hash, ledger: receipt.ledger, maxFeeXlm: decimal(BigInt(attempt.feeUnits)) }));
      return;
    }
    await new Promise(done => setTimeout(done, 1500));
  }
  throw new Error(`Deployment transaction ${attempt.hash} is unresolved. Its exact signed envelope remains private and must be recovered before another attempt.`);
}

try {
  assert(!(execute && verify), "Choose either execution or read-only verification.");
  assert.equal(env.ADMIN_WALLET_ADDRESS, ADMIN, "Configured deployment wallet differs from the designated wallet.");
  assert(env.SETTLEMENT_SECRET_KEY && !env.SETTLEMENT_SECRET_KEY.includes("[SENSITIVE]"), "The existing secure deployment signing configuration is unavailable.");
  const signer = Keypair.fromSecret(env.SETTLEMENT_SECRET_KEY.trim());
  assert.equal(signer.publicKey(), ADMIN, "The existing secret does not belong to the designated deployment wallet.");
  assert.equal(new Asset("USDC", ISSUER).contractId(Networks.PUBLIC), USDC, "Official USDC derivation mismatch.");
  assert(existsSync(wasmPath), "Build and test the Mainnet WASM before preparing deployment.");
  const wasm = readFileSync(wasmPath);
  assert(wasm.subarray(0,8).equals(Buffer.from([0,97,115,109,1,0,0,0])), "Invalid Mainnet WASM artifact.");
  const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file,digest(readFileSync(resolve(ROOT,file)))]));
  const sourceSha256 = digest(json(sourceHashes));
  const wasmSha256 = digest(wasm);
  assert(isAbsolute(privateDir), "Private deployment state requires an absolute path.");
  mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const stateRelative = relative(realpathSync(ROOT), realpathSync(privateDir));
  assert(stateRelative.startsWith("..") || isAbsolute(stateRelative), "Signed deployment state must be outside Git and the repository.");
  assert((lstatSync(privateDir).mode & 0o077) === 0, "The deployment state directory must be private (mode 0700).");
  unlock = acquireLocalLock();
  if (existsSync(statePath)) {
    assert(!lstatSync(statePath).isSymbolicLink() && (lstatSync(statePath).mode & 0o077) === 0, "Existing deployment state must be a private regular file.");
    state = JSON.parse(readFileSync(statePath,"utf8"));
    assertIdentity(state.identity, wasmSha256, sourceSha256);
  } else {
    assert(!verify, "No existing prepared deployment state is available for verification.");
    const salt = randomBytes(32); // Contract-address salt, never a wallet/keypair.
    state = { schemaVersion: 1, preparedAt: new Date().toISOString(), identity: { admin: ADMIN, networkPassphrase: Networks.PUBLIC, wasmSha256, sourceSha256, saltHex: salt.toString("hex"), contractId: deriveContractId(salt), constructor: CONSTRUCTOR }, sourceHashes, attempts: [] };
    savePrivate();
  }
  stage = "Mainnet infrastructure";
  const [network, horizonNetwork] = await Promise.all([server.getNetwork(),getJson(MAINNET_HORIZON)]);
  assert.equal(network.passphrase, Networks.PUBLIC, "RPC is not on Stellar Mainnet.");
  assert.equal(horizonNetwork.network_passphrase, Networks.PUBLIC, "Horizon is not on Stellar Mainnet.");
  const tokenIdentity = await Promise.all(["decimals","symbol","name"].map(method => readCall(USDC,method)));
  assert.deepEqual(tokenIdentity, [7,"USDC",`USDC:${ISSUER}`], "On-chain official USDC identity could not be verified.");
  const balance = await accountSnapshot();
  if (!state.initialAccount) { state.initialAccount=balance; savePrivate(); }
  const entries = await ledgerEntries();
  if (verify || state.completedAt) {
    stage = "independent on-chain verification";
    const onchain = await verifyDeployment();
    await recoverSaved(wasm);
    state.latestVerification=onchain; savePrivate();
    console.log(json({ readOnly: true, contractId: state.identity.contractId, administrator: ADMIN, wasmSha256, onchain }));
  } else if (!execute) {
    stage = "read-only spending plan";
    const upload = entries.code ? null : await feeQuote("upload",wasm);
    const constructor = entries.instance ? null : entries.code ? await feeQuote("deploy",wasm) : { fee: CONSTRUCTOR_ESTIMATE, estimatedOnly: true };
    const trustlineFee = balance.usdcTrustline ? 0n : BigInt(inclusionFee);
    const estimatedFuture = (upload?.fee ?? 0n) + (constructor?.fee ?? 0n) + trustlineFee;
    const reserveAfter = units(balance.reserveXlm) + (balance.usdcTrustline ? 0n : units(balance.baseReserveXlm));
    assertBudget({ balance: units(balance.xlmBalance), reserve: reserveAfter, liabilities: units(balance.nativeSellingLiabilities), committedFees: committedFees(), nextFee: estimatedFuture });
    const plan = { schemaVersion: 1, checkedAt: new Date().toISOString(), readOnly: true, submitted: false, deploymentFingerprint: digest(json(state.identity)), identity: state.identity, sourceHashes, artifact: { path: relative(ROOT,wasmPath), bytes: wasm.length, sha256: wasmSha256 }, initialAccount: state.initialAccount, currentAccount: balance, uploadFeeXlm: upload ? decimal(upload.fee) : "0.0000000", constructorFeeXlm: constructor ? decimal(constructor.fee) : "0.0000000", constructorIsLocalEstimate: Boolean(constructor?.estimatedOnly), trustlineFeeXlm: decimal(trustlineFee), reserveAfterTrustlineXlm: decimal(reserveAfter), estimatedRemainingExpenditureXlm: decimal(estimatedFuture), maxSpendXlm: decimal(MAX_SPEND), committedMaximumFeesXlm: decimal(committedFees()), existingLedgerEntries: entries, deploymentAuthorized: true, settlementTrustDecisionPending: true, publicMainnetGamingEnabled: false };
    mkdirSync(dirname(planPath), { recursive: true }); writeFileSync(planPath, `${json(plan)}\n`);
    console.log(json({ report: relative(ROOT,planPath), readOnly: true, contractId: state.identity.contractId, status: "PREPARED_ONLY", xlmBalance: balance.xlmBalance, estimatedRemainingExpenditureXlm: plan.estimatedRemainingExpenditureXlm, maxSpendXlm: plan.maxSpendXlm, settlementTrustDecisionPending: true }));
  } else {
    stage = "immutable contract deployment review";
    assert(existsSync(reviewPath), "Resolve and record the owner verifier decision and exact deployment review before --execute.");
    requireDeploymentReview(JSON.parse(readFileSync(reviewPath,"utf8")),state.identity);
    const uploadFee = entries.code ? 0n : (await feeQuote("upload",wasm)).fee;
    const constructorFee = entries.instance ? 0n : entries.code ? (await feeQuote("deploy",wasm)).fee : CONSTRUCTOR_ESTIMATE;
    const trustlineFee = balance.usdcTrustline ? 0n : BigInt(inclusionFee);
    const reserveAfter = units(balance.reserveXlm) + (balance.usdcTrustline ? 0n : units(balance.baseReserveXlm));
    // Count an unresolved envelope once: its fee is already committed and it
    // will be recovered byte-for-byte rather than prepared a second time.
    const pendingFee = kind => state.attempts.findLast(attempt => attempt.kind===kind && ["prepared","pending"].includes(attempt.status)) ? 0n : 1n;
    assertBudget({ balance: units(balance.xlmBalance), reserve: reserveAfter, liabilities: units(balance.nativeSellingLiabilities), committedFees: committedFees(), nextFee: uploadFee*pendingFee("upload") + constructorFee*pendingFee("deploy") + trustlineFee*pendingFee("trustline") });
    coordinator = await sharedCoordinator();
    // Pending attempts are recovered in perform(), which resubmits only their
    // identical saved bytes. Definitive old failures are retired before retries.
    for (const attempt of state.attempts) if (["failed","expired"].includes(attempt.status)) await coordinator.finish(attempt);
    for (const kind of ["trustline","upload","deploy"]) {
      const saved = state.attempts.findLast(attempt => attempt.kind===kind);
      if (saved && ["prepared","pending"].includes(saved.status)) { stage=`recover ${kind}`; await perform(kind,wasm,signer,{recoverOnly:true}); }
    }
    if (!(await accountSnapshot()).usdcTrustline) { stage="official USDC trustline"; await perform("trustline",wasm,signer); assert((await accountSnapshot()).usdcTrustline, "The USDC trustline was not independently verified."); }
    if (!(await ledgerEntries()).code) { stage="WASM upload"; await perform("upload",wasm,signer); }
    assert((await ledgerEntries()).code, "Uploaded code was not independently verified.");
    if (!(await ledgerEntries()).instance) { stage="atomic deployment and constructor"; await perform("deploy",wasm,signer); }
    stage="independent code, configuration and receipt verification";
    const onchain = await verifyDeployment();
    await recoverSaved(wasm);
    const remaining = await accountSnapshot();
    assert(remaining.usdcTrustline, "The designated fee-recipient USDC trustline is missing.");
    state.completedAt=new Date().toISOString(); state.latestVerification=onchain; savePrivate();
    const receipt = kind => state.attempts.findLast(attempt => attempt.kind===kind && attempt.status==="confirmed")?.receipt ?? null;
    const report = { schemaVersion: 1, deployedAt: receipt("deploy")?.createdAt ?? null, recordedAt: state.completedAt, contractName: "Chain Duel Mainnet USDC Escrow", contractId: state.identity.contractId, deploymentWallet: ADMIN, administrator: ADMIN, wasmSha256, wasmUploadTransaction: receipt("upload"), deploymentTransaction: receipt("deploy"), initializationTransaction: receipt("deploy"), initializationIsAtomicConstructor: true, trustlineTransaction: receipt("trustline"), constructor: CONSTRUCTOR, dependencies: [{ contractId: USDC, asset: "USDC", issuer: ISSUER, decimals: 7 }], initialAccount: state.initialAccount, remainingAccount: remaining, maximumCommittedFeesXlm: decimal(committedFees()), observedBalanceChangeXlm: decimal(units(state.initialAccount.xlmBalance)-units(remaining.xlmBalance)), balanceChangeIncludesAnyExternalWalletActivity: true, onchain, publicMainnetGamingEnabled: false, readiness: "NOT READY: MAINNET APPLICATION AND FINANCIAL VERIFICATION REMAIN" };
    mkdirSync(dirname(deploymentPath),{recursive:true}); writeFileSync(deploymentPath,`${json(report)}\n`);
    console.log(json({ report: relative(ROOT,deploymentPath), contractId: state.identity.contractId, administrator: ADMIN, independentlyVerified: true, remainingXlm: remaining.xlmBalance, publicMainnetGamingEnabled: false }));
  }
} catch (error) {
  let diagnostic = String(error?.message ?? "Deployment did not complete.");
  for (const value of Object.values(env)) if (value && value.length > 12) diagnostic = diagnostic.replaceAll(value,"[REDACTED]");
  diagnostic = diagnostic.replace(/S[A-Z2-7]{55}/g,"[REDACTED]");
  console.error(json({ stage, error: diagnostic, code: error?.code ?? error?.cause?.code ?? error?.name ?? "deployment_failed", signedAttemptsPersisted: state?.attempts?.length ?? 0, publicMainnetGamingEnabled: false }));
  process.exitCode=1;
} finally {
  try { if (coordinator) await coordinator.close(); }
  catch (error) { console.error(json({ stage: "signing coordinator cleanup", error: "Coordinator lease cleanup needs review.", code: error?.code ?? "cleanup_failed" })); process.exitCode=1; }
  finally { if (unlock) unlock(); }
}
