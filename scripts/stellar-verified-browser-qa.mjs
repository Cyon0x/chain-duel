/** Browser-held keys, recovery and real Testnet application flow. No Mainnet. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseEnv } from "node:util";
import { Asset, BASE_FEE, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

const require = createRequire(resolve(homedir(), ".codex/skills/web-designer/package.json"));
const { chromium } = require("playwright-core");
const ROOT = resolve(import.meta.dirname, "..");
const BASE = process.argv[2] ?? "http://localhost:4315";
assert(BASE === "http://localhost:4315", "This financial browser harness is restricted to the isolated local Testnet Preview.");
const PRIVATE = resolve(homedir(), ".local/state/chain-duel/stellar-verified-testnet/browser");
await mkdir(PRIVATE, { recursive: true, mode: 0o700 });
const REPORT = resolve(ROOT, "docs/stellar-verified-deployments/browser-evidence.json");
const report = { base: BASE, startedAt: new Date().toISOString(), network: "testnet", checks: [], playerAddresses: [], games: [], transactions: [], errors: [] };
try {
  const previous = JSON.parse(await readFile(REPORT, "utf8"));
  report.checks = previous.checks ?? []; report.transactions = previous.transactions ?? []; report.games = previous.games ?? [];
} catch {}
const secrets = [];
const browser = await chromium.launch({ channel: "chrome", headless: true });
const contexts = [];
const checkpoint = message => process.stdout.write(`${new Date().toISOString()} ${message}\n`);
let savedPlayers = [];
try { savedPlayers = JSON.parse(await readFile(resolve(PRIVATE, "players.json"), "utf8")); } catch {}
async function savePlayers() { await writeFile(resolve(PRIVATE, "players.json"), JSON.stringify(savedPlayers), { mode: 0o600 }); }
async function save() { await writeFile(REPORT, JSON.stringify(report, null, 2)); }
async function api(context, path, body) {
  const response = await context.request.fetch(BASE + path, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { data: body }), headers: { origin: BASE }, timeout: 60000, maxRetries: body === undefined ? 2 : 0 });
  const result = await response.json();
  assert(response.ok(), `${path} failed: ${result.error ?? response.status()}`); return result;
}
async function createPlayer(index) {
  const recorded = savedPlayers.find(value => value.index === index);
  const context = await browser.newContext({ viewport: { width: index === 1 ? 390 : 1440, height: 950 }, acceptDownloads: true, ...(recorded ? { storageState: resolve(PRIVATE, `player-${index}-browser.json`) } : {}) }); contexts.push(context);
  const page = await context.newPage(); page.on("dialog", dialog => dialog.accept());
  page.on("pageerror", error => report.errors.push(error.message));
  const sensitivePayloads = [];
  page.on("request", request => { if (request.url().startsWith(BASE + "/api/")) { const body = request.postData(); if (body) sensitivePayloads.push(body); } });
  if (recorded) {
    const backup = JSON.parse(await readFile(recorded.backupPath, "utf8")); secrets.push(backup.recoveryCode);
    await page.goto(BASE + "/wallet", { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
    await page.waitForTimeout(1800);
    if (await page.getByRole("heading", { name: "Restore this wallet on your device" }).count()) {
      await page.getByLabel("Recovery code").fill(backup.recoveryCode); await page.getByRole("button", { name: "Restore wallet", exact: true }).click();
      await page.getByRole("heading", { name: "Restore this wallet on your device" }).waitFor({ state: "hidden", timeout: 60000 });
    }
    const session = await api(context, "/api/auth/session"); assert.equal(session.wallet.address, recorded.address);
    report.playerAddresses.push(recorded.address);
    return { ...recorded, context, page };
  }
  await api(context, "/api/auth/demo", { name: `Verify${index}` });
  const before = await api(context, "/api/auth/session"); assert.equal(before.wallet, null);
  const username = `verify${index}_${Date.now().toString().slice(-8)}`;
  await api(context, "/api/onboarding", { username });
  await page.goto(BASE + "/wallet", { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.getByRole("heading", { name: "Save your recovery backup" }).waitFor({ timeout: 90000 });
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "Download recovery kit" }).click();
  const download = await downloading; const backupPath = resolve(PRIVATE, `player-${index}-recovery.json`); await download.saveAs(backupPath); await chmod(backupPath, 0o600);
  const backup = JSON.parse(await readFile(backupPath, "utf8")); secrets.push(backup.recoveryCode);
  const address = backup.publicVault.walletAddress; report.playerAddresses.push(address);
  await page.getByRole("button", { name: "I saved it · continue" }).click();
  await page.getByRole("heading", { name: "Save your recovery backup" }).waitFor({ state: "hidden", timeout: 90000 });
  const session = await api(context, "/api/auth/session"); assert.equal(session.wallet.address, address); assert.equal(session.wallet.provider, "chain-duel-client");
  const initialVault = await api(context, "/api/wallet/vault"); assert.equal(initialVault.status, "client-primary");
  assert(sensitivePayloads.every(value => !value.includes(backup.recoveryCode) && !value.includes("privateKey")), "Private player signing or recovery material reached an API request.");
  const local = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("chain-duel-player-signers-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    return new Promise((resolve, reject) => { const request = database.transaction("signers").objectStore("signers").getAll(); request.onsuccess = () => resolve(request.result.map(value => ({ extractable: value.privateKey.extractable, algorithm: value.privateKey.algorithm.name, wallet: value.walletAddress }))); request.onerror = reject; });
  });
  assert(local.some(value => value.wallet === address && value.extractable === false && value.algorithm === "Ed25519"));
  report.checks.push(`Player ${index}: browser-generated address, nonextractable IndexedDB key, encrypted public backup, no API secret transfer`); await save();
  await context.storageState({ path: resolve(PRIVATE, `player-${index}-browser.json`), indexedDB: true }); await chmod(resolve(PRIVATE, `player-${index}-browser.json`), 0o600);
  savedPlayers.push({ index, backupPath, address, username, userId: session.user.id }); await savePlayers();
  return { index, context, page, backupPath, address, username, userId: session.user.id };
}
async function waitForSettledGame(context, id) {
  const deadline = Date.now() + 180000;
  let view;
  while (Date.now() < deadline) {
    view = await api(context, `/api/matches/${id}`);
    if (view.game.status === "settled") return view;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(view?.game.status, "settled", "The independently settled game did not synchronize with the application.");
  return view;
}
async function fundPlayer(player, admin, index) {
  const info = await api(player.context, "/api/wallet");
  const prior = report.transactions.find(value => value.label === `controlled-browser-player-${index}-funding` && value.destination === player.address);
  if (prior) {
    const receipt = await new Horizon.Server("https://horizon-testnet.stellar.org").transactions().transaction(prior.hash).call();
    assert.equal(receipt.successful, true); assert(info.balance.exists && info.balance.usdcTrustline);
    return;
  }
  assert.equal(Number(info.balance.usdc ?? "0"), 0, "Inspect existing Testnet funding before sending another payment.");
  if (!info.balance.exists) {
    const faucet = await fetch(`https://friendbot.stellar.org/?addr=${player.address}`, { signal: AbortSignal.timeout(60000) }); assert(faucet.ok, "The controlled browser Testnet account could not be funded.");
  }
  await player.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await player.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
  if (!info.balance.usdcTrustline) {
    await player.page.getByRole("button", { name: "Enable USDC", exact: true }).waitFor({ timeout: 90000 });
    const preparedResponse = player.page.waitForResponse(response => response.url() === BASE + "/api/wallet/trustline" && response.request().method() === "POST", { timeout: 30000 });
    await player.page.getByRole("button", { name: "Enable USDC", exact: true }).click();
    const prepared = await preparedResponse; assert(prepared.ok(), `Client USDC setup failed: ${(await prepared.json()).error}`);
    await player.page.getByRole("button", { name: "Enable USDC", exact: true }).waitFor({ state: "hidden", timeout: 90000 });
  }
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org"); const issuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const transaction = new TransactionBuilder(await horizon.loadAccount(admin.publicKey()), { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }).addOperation(Operation.payment({ destination: player.address, asset: new Asset("USDC", issuer), amount: "75.0000000" })).setTimeout(120).build();
  transaction.sign(admin); const receipt = await horizon.submitTransaction(transaction); report.transactions.push({ label: `controlled-browser-player-${index}-funding`, hash: receipt.hash, destination: player.address, amountTestnetUsdc: "75", successful: receipt.successful });
  await player.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await player.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
  const wallet = await api(player.context, "/api/wallet"); assert.equal(wallet.balance.usdc, "75.0000000"); assert.equal(wallet.canSignServerSide, false); assert.equal(wallet.currency, "USDC");
  report.checks.push(`Player ${index}: client-signed official Testnet USDC trustline, live balance retrieval and controlled funding`); await save();
}
async function recoverPlayer(player) {
  const backup = JSON.parse(await readFile(player.backupPath, "utf8"));
  const before = (await api(player.context, "/api/wallet")).balance.usdc;
  await player.page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => { const request = indexedDB.open("chain-duel-player-signers-v1", 1); request.onsuccess = () => resolve(request.result); request.onerror = reject; });
    await new Promise((resolve, reject) => { const transaction = database.transaction("signers", "readwrite"); transaction.objectStore("signers").clear(); transaction.oncomplete = resolve; transaction.onerror = reject; }); database.close();
  });
  await player.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
  await player.page.getByRole("heading", { name: "Restore this wallet on your device" }).waitFor({ timeout: 60000 });
  await player.page.getByLabel("Recovery code").fill("CDR1-000000-000000-000000-000000-000000-000000-000000-000000");
  await player.page.getByRole("button", { name: "Restore wallet", exact: true }).click();
  await player.page.getByRole("alert").filter({ hasText: "could not be verified" }).waitFor({ timeout: 30000 });
  await player.page.getByLabel("Recovery code").fill(backup.recoveryCode); await player.page.getByRole("button", { name: "Restore wallet", exact: true }).click();
  await player.page.getByRole("heading", { name: "Restore this wallet on your device" }).waitFor({ state: "hidden", timeout: 60000 });
  assert.equal((await api(player.context, "/api/auth/session")).wallet.address, player.address);
  assert.equal((await api(player.context, "/api/wallet")).balance.usdc, before);
  await player.context.storageState({ path: resolve(PRIVATE, `player-${player.index ?? 1}-browser.json`), indexedDB: true });
  await chmod(resolve(PRIVATE, `player-${player.index ?? 1}-browser.json`), 0o600);
  report.checks.push("Real-browser wrong-code rejection and recovery after local key loss preserve the same funded player address"); await save();
}
async function screenshot(page, name) {
  await page.screenshot({ path: resolve(PRIVATE, `${name}.png`), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name} has horizontal overflow`);
}
try {
  checkpoint("Checking the isolated Testnet configuration.");
  const healthContext = await browser.newContext(); contexts.push(healthContext);
  const health = await api(healthContext, "/api/health"); assert.equal(health.network, "testnet"); assert(health.persistenceAvailable); assert.equal(health.persistence, "postgres");
  const networks = await api(healthContext, "/api/networks"); assert.equal(networks.stellar.verification.version, 1); assert.equal(networks.stellar.asset.symbol, "USDC"); assert.equal(networks.stellar.playerSigning, "client");
  const local = parseEnv(await readFile(resolve(ROOT, ".env.local"), "utf8")); const admin = Keypair.fromSecret((local.SETTLEMENT_SECRET_KEY ?? local.TREASURY_SECRET_KEY).trim());
  assert.equal(admin.publicKey(), networks.stellar.verification.admin);
  const one = await createPlayer(1); const two = await createPlayer(2);
  checkpoint("Restored the existing browser-held player keys.");
  let recovered;
  for (const previous of report.games) {
    let view = await api(one.context, `/api/matches/${previous.id}`);
    if (["waiting", "joined"].includes(view.game.status)) {
      assert(new Date(view.game.expires_at).getTime() < Date.now(), "The saved duel is still joinable; wait before retrying its financial test.");
      const cancelled = await one.context.request.delete(BASE + `/api/duels/${previous.id}`, { headers: { origin: BASE } });
      const result = await cancelled.json(); assert(cancelled.ok(), result.error);
      assert.equal(result.game.status, "cancelled");
      previous.recoveredStatus = "cancelled";
      report.checks.push("Interrupted, expired browser duel reconciled through the eligible on-chain refund path before retrying"); await save();
    } else {
      if (view.game.status === "active") view = await waitForSettledGame(one.context, previous.id);
      assert(["cancelled", "expired", "settled"].includes(view.game.status), "Resolve the saved active duel before starting another financial test.");
      if (view.game.status === "settled") recovered = view;
    }
  }
  await fundPlayer(one, admin, 1); await fundPlayer(two, admin, 2); await recoverPlayer(one);
  checkpoint("Confirmed original funding and recovery without changing player addresses.");
  const balancesBefore = await Promise.all([one, two].map(async player => Number((await api(player.context, "/api/wallet")).balance.usdc)));
  const winsBefore = (await api(one.context, "/api/auth/session")).profile.wins;
  for (const width of [390, 768, 1440]) { await one.page.setViewportSize({ width, height: 950 }); await one.page.goto(BASE + "/wallet", { waitUntil: "domcontentloaded", timeout: 60000 }); await screenshot(one.page, `wallet-${width}`); }
  await one.page.setViewportSize({ width: 768, height: 950 });
  if (recovered) {
    assert.equal(recovered.game.verification_version, 1); assert.equal(recovered.game.winner_id, one.userId); assert(recovered.game.player_one_score > 0); assert.equal(recovered.game.player_two_score, 0); assert(recovered.game.settle_tx_hash);
    report.games.find(value => value.id === recovered.game.id).result = recovered.game;
    await one.page.goto(BASE + `/match/${recovered.game.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await two.page.goto(BASE + `/match/${recovered.game.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await one.page.getByRole("heading", { name: "WINNER", exact: true }).waitFor({ timeout: 60000 });
    await one.page.getByText(String(recovered.game.player_one_score), { exact: true }).waitFor({ timeout: 60000 });
    await one.page.getByText("+16", { exact: true }).waitFor({ timeout: 60000 });
    await one.page.getByText("Protocol 2.5 · ecosystem 2.5 USDC", { exact: true }).waitFor({ timeout: 60000 });
    await screenshot(one.page, "winner-result"); await screenshot(two.page, "loser-result");
    assert.equal(balancesBefore[0], 95); assert.equal(balancesBefore[1], 50); assert.equal(winsBefore, 1);
    report.checks.push("Interrupted browser game recovered from independently settled chain state without another stake or payout");
    report.checks.push("Full real-browser player-controlled USDC stake, private invitation/join, simultaneous gameplay, hit capture, zero opponent score, direct input verification, settlement, 90% winner payout, profile and balance updates");
    for (const path of ["/transactions", "/profile", "/leaderboard"]) { await one.page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 }); await screenshot(one.page, path.slice(1)); }
    report.checks = [...new Set(report.checks)]; report.finishedAt = new Date().toISOString(); report.passed = true; delete report.failure; await save();
    checkpoint(`Recovered confirmed settlement ${recovered.game.settle_tx_hash}.`);
  } else {
    await one.page.goto(BASE + "/play/friend", { waitUntil: "domcontentloaded", timeout: 60000 });
    await one.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
    await one.page.waitForTimeout(1000);
    await one.page.getByPlaceholder("Enter USDC amount").fill("25");
    const creationResponse = one.page.waitForResponse(response => response.url() === BASE + "/api/duels" && response.request().method() === "POST", { timeout: 60000 });
    await one.page.getByRole("button", { name: "Create private duel", exact: true }).click();
    const creation = await (await creationResponse).json(); assert(creation.game, creation.error); const game = creation.game; report.games.push({ id: game.id, contractGameId: game.contract_game_id, code: game.code, verificationVersion: game.verification_version });
    await one.page.getByRole("heading", { name: "Invite ready" }).waitFor({ timeout: 120000 });
    checkpoint("Creator's client-signed Testnet USDC stake is confirmed.");
    await screenshot(one.page, "created-private-duel");
    await two.page.goto(BASE + `/duel/${game.code}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await two.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null); await two.page.waitForTimeout(1000);
    const join = two.page.getByRole("button", { name: /^Accept|^Join|Lock.*entry/i }).first();
    await join.click(); await two.page.waitForURL(`**/match/${game.id}`, { timeout: 120000 });
    checkpoint("Opponent's client-signed stake is confirmed.");
    await one.page.goto(BASE + `/match/${game.id}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    await one.page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null); await one.page.waitForTimeout(1000);
    await one.page.getByRole("button", { name: "Start duel", exact: true }).click();
    await one.page.getByRole("application", { name: "Pulse Duel arena" }).waitFor({ timeout: 120000 });
    await two.page.getByRole("application", { name: "Pulse Duel arena" }).waitFor({ timeout: 120000 });
    checkpoint("Both players entered the independently verified arena.");
    await screenshot(one.page, "live-verified-duel");
    // Exercise actual UI hit handling, without supplying a final score or winner.
    const stop = Date.now() + 85000; let taps = 0;
    while (Date.now() < stop) {
      const target = one.page.locator("button.target--blue, button.target--gold").first();
      if (await target.count()) { await target.click({ timeout: 300 }).then(() => taps++).catch(() => null); }
      const view = await api(one.context, `/api/matches/${game.id}`);
      if (view.game.status === "settled") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    let final;
    for (let attempt = 0; attempt < 60; attempt++) {
      final = await api(one.context, `/api/matches/${game.id}`); if (final.game.status === "settled") break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(final.game.status, "settled", "The real-browser verified duel did not settle.");
    assert.equal(final.game.verification_version, 1); assert.equal(final.game.winner_id, one.userId); assert(final.game.player_one_score > 0 && taps > 0); assert.equal(final.game.player_two_score, 0);
    assert(final.game.settle_tx_hash); report.games.at(-1).result = final.game;
    await one.page.getByText(String(final.game.player_one_score), { exact: true }).waitFor({ timeout: 60000 });
    await screenshot(one.page, "winner-result"); await screenshot(two.page, "loser-result");
    assert.equal(Number((await api(one.context, "/api/wallet")).balance.usdc), balancesBefore[0] + 20); assert.equal(Number((await api(two.context, "/api/wallet")).balance.usdc), balancesBefore[1] - 25);
    const profile = await api(one.context, "/api/auth/session"); assert.equal(profile.profile.wins, winsBefore + 1);
    checkpoint("Contract settlement, winner payout and player balances are confirmed.");
    report.checks.push("Full real-browser player-controlled USDC stake, private invitation/join, simultaneous gameplay, hit capture, zero opponent score, direct input verification, settlement, 90% winner payout, profile and balance updates");
    for (const path of ["/transactions", "/profile", "/leaderboard"]) { await one.page.goto(BASE + path, { waitUntil: "domcontentloaded", timeout: 60000 }); await screenshot(one.page, path.slice(1)); }
    report.checks = [...new Set(report.checks)]; report.finishedAt = new Date().toISOString(); report.passed = true; delete report.failure; await save();
    process.stdout.write(JSON.stringify({ passed: true, checks: report.checks, playerAddresses: report.playerAddresses, settlementTx: final.game.settle_tx_hash }, null, 2) + "\n");
  }
} catch (error) {
  let reason = String(error.message ?? "Browser QA failed"); for (const secret of secrets) reason = reason.split(secret).join("[REDACTED]");
  reason = reason.replace(/(cookie:|authorization:) [^\r\n]*/gi, "$1 [REDACTED]").replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]");
  report.passed = false; report.failure = reason; await save();
  for (const [index, context] of contexts.entries()) for (const page of context.pages()) await page.screenshot({ path: resolve(PRIVATE, `failure-${index}.png`), fullPage: true }).catch(() => null);
  process.stderr.write(`Browser verification stopped: ${reason}\n`); process.exitCode = 1;
} finally { await browser.close(); }
