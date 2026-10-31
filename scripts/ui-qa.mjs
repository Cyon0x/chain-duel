/** Browser regression checks. Run against an isolated local demo database.
 * Requires playwright-core in this project or UI_QA_PLAYWRIGHT_ROOT.
 * node scripts/ui-qa.mjs --out /tmp/chain-duel-qa
 * Creates no-stake demo identities/matches, never wallet transactions.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const arg = (key, fallback) => argv.includes(key) ? argv[argv.indexOf(key) + 1] : fallback;
const base = arg("--base", "http://localhost:4310");
assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname), "Use an isolated local database for UI QA.");
const out = path.resolve(arg("--out", "/tmp/chain-duel-qa"));
await fs.mkdir(out, { recursive: true });
let pw;
for (const root of [process.cwd(), process.env.UI_QA_PLAYWRIGHT_ROOT, path.join(os.homedir(), ".codex/skills/web-designer")].filter(Boolean)) {
  try { pw = createRequire(path.join(root, "package.json"))("playwright-core"); break; } catch { /* next installation */ }
}
assert(pw, "Install playwright-core or set UI_QA_PLAYWRIGHT_ROOT.");
const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
const report = { viewports: [], checks: [], errors: [] };
const sizes = [[320,700], [375,812], [390,844], [430,932], [768,1024], [1440,900], [1920,1080]];
const routeSizes = argv.includes("--flows-only") ? [] : sizes;
const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
const watch = (page) => {
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/ExperimentalWarning|Failed to load resource/.test(msg.text())) report.errors.push(msg.text());
  });
};
async function request(context, route, method = "GET", data) {
  const response = await context.request.fetch(`${base}${route}`, { method, data });
  assert(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`);
  return response.json();
}
async function capture(page, name) {
  await page.evaluate(() => document.fonts.ready);
  const width = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
  assert(width.content <= width.viewport + 1, `${name} horizontal overflow: ${JSON.stringify(width)}`);
  await page.screenshot({ path: path.join(out, `${name}.png`), fullPage: true });
  report.viewports.push({ name, ...width });
}
async function demo(context, username) {
  await request(context, "/api/auth/demo", "POST", { name: username });
  await request(context, "/api/onboarding", "POST", { username, theme: "neon" });
}
try {
  const context = await browser.newContext({ viewport: { width:390, height:844 }, hasTouch:true, isMobile:true });
  const page = await context.newPage(); watch(page);
  for (const [width,height] of routeSizes) {
    await page.setViewportSize({ width,height });
    await page.goto(base, { waitUntil: "networkidle" });
    await page.locator('.target').first().waitFor();
    const cta = await page.getByRole("link", { name: "Enter the arena", exact:true }).first().boundingBox();
    assert(cta.y + cta.height < height, `CTA below fold at ${width}`);
    await capture(page, `home-${width}`);
    if (width < 1200) {
      await page.getByRole("button", { name:"Open navigation menu" }).click();
      assert(await page.locator("#mobile-navigation").isVisible());
      await capture(page, `menu-${width}`);
      await page.keyboard.press("Escape");
      assert(await page.getByRole("button", { name:"Open navigation menu" }).evaluate(el => el === document.activeElement));
    }
  }
  if (routeSizes.length) check("Homepage CTA and responsive navigation at all seven requested sizes");
  await page.setViewportSize({ width:390,height:844 });
  await page.goto(base, { waitUntil:"networkidle" });
  const positive = page.locator('.target--blue, .target--gold');
  await positive.first().waitFor();
  await positive.first().dispatchEvent("pointerdown", { bubbles:true });
  await page.waitForFunction(() => /Practice score [1-9]/.test(document.body.textContent));
  await page.getByRole("button", { name:"Pause practice preview" }).click();
  assert(await page.getByText("Practice paused", { exact:true }).isVisible());
  await capture(page, "practice-paused");
  await page.getByRole("button", { name:"Resume practice preview" }).click();
  await page.locator(".target").first().waitFor();
  check("Practice target scoring and pause/resume");
  await page.getByRole("button", { name:"Sign in", exact:true }).click();
  const dialog = page.getByRole("dialog"); await dialog.waitFor();
  await dialog.getByText("Freighter", { exact:true }).waitFor();
  await capture(page, "auth-390");
  await dialog.getByRole("button", { name:"Close", exact:true }).focus();
  await page.keyboard.press("Shift+Tab");
  assert(await dialog.evaluate(el => el.contains(document.activeElement)), "Dialog focus escaped");
  await page.keyboard.press("Escape");
  assert(await page.getByRole("button", { name:"Sign in", exact:true }).evaluate(el => el === document.activeElement));
  check("Sign-in providers, modal focus trap, Escape, and focus restoration");
  await page.getByRole("button", { name:"Sign in", exact:true }).click();
  await dialog.getByRole("button", { name:"Try demo mode" }).click();
  await page.waitForURL("**/onboarding");
  const suffix = Date.now().toString(36);
  const name = `qa_${suffix}`.padEnd(18, "x");
  await page.getByLabel("Username", { exact:true }).fill(name);
  await page.getByRole("button", { name:"Create profile" }).click();
  await page.waitForURL("**/dashboard");
  check("Demo sign-in and onboarding through real UI handlers");
  const rivalContext = await browser.newContext({ viewport:{ width:375,height:812 }, hasTouch:true,isMobile:true });
  const rival = await rivalContext.newPage(); watch(rival);
  const rivalName = `rival_${suffix}`.padEnd(18, "x");
  await demo(rivalContext, rivalName);
  for (const [width,height] of sizes) {
    await page.setViewportSize({ width,height });
    for (const route of ["/profile", "/dashboard", `/players/${rivalName}`]) {
      await page.goto(`${base}${route}`, { waitUntil:"networkidle" });
      const identity = page.locator(".profile-identity");
      const heading = await identity.getByRole("heading", { level:1 }).boundingBox();
      const status = await identity.locator(".profile-identity__status").boundingBox();
      assert(heading && status && (heading.x + heading.width <= status.x || heading.y + heading.height <= status.y), `${route} username overlaps status at ${width}`);
      await capture(page, `identity-${route.slice(1).replaceAll("/","-")}-${width}`);
    }
  }
  check("18-character profile names and separate status/actions at all requested sizes");
  for (const [width,height] of routeSizes) {
    await page.setViewportSize({ width,height });
    for (const route of ["/play", "/play/online", "/play/friend", "/play/computer", "/players", `/players/${rivalName}`, "/leaderboard", "/profile", "/dashboard", "/wallet", "/settings", "/transactions", "/how-to-play", "/rules", "/terms", "/privacy"]) {
      const response = await page.goto(`${base}${route}`, { waitUntil:"networkidle" });
      assert(!response || response.ok(), `${route} failed`);
      assert(new URL(page.url()).pathname === route, `${route} unexpectedly redirected`);
      await capture(page, `${route.slice(1).replaceAll("/","-")}-${width}`);
    }
  }
  if (routeSizes.length) check("All public/account/mode/supporting routes at seven requested sizes");
  await page.setViewportSize({ width:390,height:844 });
  await page.goto(`${base}/play/online`, { waitUntil:"networkidle" });
  await page.getByLabel("Custom amount").focus();
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Find random player" && button.disabled));
  assert(await page.getByRole("button",{ name:"Find random player",exact:true }).isDisabled());
  await page.getByLabel("Custom amount").fill("7.125");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Find random player" && !button.disabled));
  assert(await page.getByRole("button",{ name:"Find random player",exact:true }).isEnabled());
  await page.getByLabel("Custom amount").fill("251");
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some(button => button.textContent.trim() === "Find random player" && button.disabled));
  assert(await page.getByRole("button",{ name:"Find random player",exact:true }).isDisabled());
  await page.getByRole("radio").first().focus(); await page.keyboard.press("ArrowRight");
  assert(await page.getByRole("radio").nth(1).getAttribute("aria-checked") === "true");
  check("Custom stake validation and keyboard preset selection");
  await page.getByRole("button",{ name:"Demo off",exact:true }).click();
  await page.getByRole("button",{ name:"Find random player",exact:true }).click();
  await page.getByRole("button",{ name:"Cancel search" }).waitFor();
  await capture(page,"queue-searching");
  await page.getByRole("button",{ name:"Cancel search" }).click();
  await page.getByRole("button",{ name:"Find random player",exact:true }).waitFor();
  assert((await request(context,"/api/matchmaking")).status !== "searching");
  check("Real demo queue join and cancellation");
  await page.goto(`${base}/play/friend`, { waitUntil:"networkidle" });
  await page.getByRole("button",{ name:"Demo off",exact:true }).click();
  await page.getByRole("button",{ name:"Create private duel",exact:true }).click();
  await page.getByRole("heading",{ name:"Invite ready" }).waitFor();
  await capture(page,"private-invite");
  assert(await page.locator("svg[role=img]").count() > 0, "Invite QR missing");
  const lobbyHref = await page.getByRole("link",{ name:"Open duel lobby" }).getAttribute("href");
  const id = lobbyHref.split("/").at(-1);
  const view = await request(context,`/api/matches/${id}`);
  await rival.goto(`${base}/duel/${view.game.code}`, { waitUntil:"networkidle" });
  await capture(rival,"private-join");
  await rival.getByRole("button",{ name:"Join demo duel" }).click();
  await rival.waitForURL(`**/match/${id}`);
  await page.goto(`${base}${lobbyHref}`, { waitUntil:"networkidle" });
  await capture(page,"lobby-390");
  await page.getByRole("button",{ name:"Start duel",exact:true }).click();
  await page.locator(".pulse-field").waitFor();
  await rival.locator(".pulse-field").waitFor();
  check("Private invitation link/QR, join, lobby, and synchronized countdown");
  const deadline = Date.now() + 75_000;
  let hits = 0;
  while (Date.now() < deadline && await page.locator(".pulse-field").count()) {
    for (const p of [page,rival]) {
      const target = p.locator(".target--blue, .target--gold").first();
      if (await target.count()) {
        // Wait a human reaction interval so the real server verifier accepts input.
        await p.waitForTimeout(100);
        if (await target.count()) { await target.dispatchEvent("pointerdown",{ bubbles:true }).catch(() => {}); hits++; }
      }
    }
    if (hits > 5 && !report.checks.includes("Live HUD captured at all requested sizes")) {
      for (const [width,height] of sizes) { await page.setViewportSize({ width,height }); await capture(page,`arena-${width}`); }
      await page.setViewportSize({ width:390,height:844 });
      check("Live HUD captured at all requested sizes");
    }
    await page.waitForTimeout(160);
  }
  await page.locator(".match-result-title").waitFor({ timeout:20_000 });
  await rival.locator(".match-result-title").waitFor({ timeout:20_000 });
  await page.waitForTimeout(1000);
  const final = await request(context,`/api/matches/${id}`);
  assert(final.game.status === "settled" && final.game.demo === 1);
  assert(final.players.every(player => player.score > 0), "Real inputs did not produce scores");
  assert(final.game.settle_tx_hash === null, "Demo fabricated a chain hash");
  for (const [p,username] of [[page,name],[rival,rivalName]]) {
    const self = final.players.find(player => player.username === username);
    const opponent = final.players.find(player => player.username !== username);
    assert(self && opponent, "Server match players missing");
    const expected = [self.score,opponent.score].map(score => score.toLocaleString("en-US"));
    await p.waitForFunction(expected => JSON.stringify([...document.querySelectorAll(".match-result__scores .numeric")].map(el => el.textContent)) === JSON.stringify(expected), expected);
    const title = await p.locator(".match-result-title").textContent();
    assert(title === (final.game.winner_id === self.user_id ? "WINNER" : final.game.winner_id === null ? "DRAW" : "DEFEAT"), "Result disagrees with authoritative winner");
  }
  report.finalMatch = { id, winner:final.game.winner_id, players:final.players.map(({ username,score }) => ({ username,score })) };
  for (const [width,height] of sizes) { await page.setViewportSize({ width,height }); await capture(page,`result-${width}`); }
  check("Full 60-second multiplayer game, target input, verified scores, settlement and result");
  await page.setViewportSize({ width:390,height:844 });
  await page.getByRole("button",{ name:"Play again",exact:true }).click();
  await page.waitForURL("**/play");
  await page.getByRole("button",{ name:`Account menu for ${name}` }).click();
  await page.getByRole("menuitem",{ name:"Settings",exact:true }).click();
  await page.getByRole("switch",{ name:"Sound & music" }).click();
  await page.waitForFunction(() => localStorage.getItem("cd.sound") === "off");
  await page.reload({ waitUntil:"networkidle" });
  assert(await page.getByRole("switch",{ name:"Sound & music" }).getAttribute("aria-checked") === "false", "Sound preference not persisted");
  await page.getByRole("button",{ name:"Disconnect & sign out" }).click();
  await page.waitForURL(base + "/");
  await page.getByRole("button",{ name:"Sign in",exact:true }).waitFor();
  check("Play again, account navigation, sound preference and sign-out");
  assert(report.errors.length === 0, JSON.stringify(report.errors));
} finally {
  await fs.writeFile(path.join(out,"report.json"),JSON.stringify(report,null,2));
  await browser.close();
}
