/** Focused UI regression checks against an isolated local demo database. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";

const base = process.env.UI_QA_BASE ?? "http://localhost:4321";
assert(["localhost", "127.0.0.1"].includes(new URL(base).hostname));
const out = process.env.UI_QA_OUT ?? "/private/tmp/chain-duel-update-qa/features";
await fs.mkdir(out, { recursive: true });
const pw = createRequire(path.join(os.homedir(), ".codex/skills/web-designer/package.json"))("playwright-core");
const browser = await pw.chromium.launch({ channel: "chrome", headless: true });
const report = { checks: [], errors: [], screenshots: [] };
const check = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
const description = "When live, Chain Duel users will be able to swap and bridge assets across different chains and currencies supported within the Stellar ecosystem, all from one place.";
const presets = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
async function capture(page, name) {
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: horizontal overflow`);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: true });
  report.screenshots.push(`${out}/${name}.png`);
}
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", error => report.errors.push(error.message));
  const name = `stakes_${Date.now().toString(36)}`;
  for (const [route, data] of [["/api/auth/demo", { name }], ["/api/onboarding", { username: name, theme: "neon" }]]) {
    const response = await context.request.post(base + route, { data });
    assert(response.ok(), await response.text());
  }
  const sizes = [320, 390, 768, 1200, 1280, 1440, 1920];
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(base + "/play/online", { waitUntil: "networkidle" });
    if (width >= 1200) {
      assert(await page.evaluate(() => {
        const bar = document.querySelector(".site-header__bar");
        const controls = document.querySelector(".header-controls");
        return controls.getBoundingClientRect().right <= bar.getBoundingClientRect().right - parseFloat(getComputedStyle(bar).paddingRight) + 1;
      }), `Header controls exceed inner padding at ${width}px`);
    }
    await capture(page, `stakes-${width}`);
    const menu = page.getByRole("button", { name: "Open navigation menu" });
    const mobile = await menu.isVisible();
    if (mobile) await menu.click();
    const nav = page.locator(mobile ? "#mobile-navigation nav" : ".desktop-navigation");
    const labels = await nav.locator("a,button").allTextContents();
    assert.deepEqual(labels.map(label => label.trim()).slice(-2), ["Transactions", "Swap"]);
    await nav.getByRole("button", { name: "Swap", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Swap Feature Coming Soon" });
    await dialog.waitFor();
    assert(await dialog.getByText(description, { exact: true }).isVisible());
    assert.equal(await dialog.locator("input,select,form").count(), 0);
    await capture(page, `swap-${width}`);
    await dialog.getByRole("button", { name: "Back to game" }).click();
    await dialog.waitFor({ state: "hidden" });
    assert.equal(new URL(page.url()).pathname, "/play/online");
    assert(await page.getByLabel("Custom amount").isVisible());
    if (width === 320) {
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      const action = await page.getByRole("button", { name: "Find random player", exact: true }).boundingBox();
      const tabs = await page.locator(".mobile-tabbar").boundingBox();
      assert(action && tabs && action.y + action.height <= tabs.y, "320px action cannot scroll clear of the bottom navigation");
      await capture(page, "stakes-320-action");
    }
  }
  check("Swap follows Transactions, opens the exact announcement and returns to the previous screen at seven widths");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator(".desktop-navigation").getByRole("button", { name: "Swap", exact: true }).click();
  await page.getByRole("button", { name: "Close Swap announcement" }).focus();
  await page.keyboard.press("Shift+Tab");
  assert(await page.getByRole("button", { name: "Back to game" }).evaluate(node => node === document.activeElement));
  await page.keyboard.press("Tab");
  assert(await page.getByRole("button", { name: "Close Swap announcement" }).evaluate(node => node === document.activeElement));
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".swap-announcement"));
  assert(await page.locator(".desktop-navigation").getByRole("button", { name: "Swap", exact: true }).evaluate(node => node === document.activeElement));
  check("Modal keyboard focus, Escape and trigger focus restoration");

  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const input = page.getByLabel("Custom amount");
    const find = page.getByRole("button", { name: "Find random player", exact: true });
    for (const amount of ["25", "25.0000001", "125.1234567", "9999.9999999", "10000"]) {
      await input.fill(amount);
      assert.equal(await input.getAttribute("aria-invalid"), "false");
      assert(await find.isEnabled());
    }
    for (const [amount, message] of [["24.9999999", "Minimum stake is 25 XLM."], ["10000.0000001", "Maximum stake is 10,000 XLM."], ["25.00000001", "XLM supports at most 7 decimal places."], ["", "Enter a stake amount."]]) {
      await input.fill(amount);
      assert(await find.isDisabled());
      assert(await page.getByRole("alert").getByText(message, { exact: true }).isVisible());
    }
    for (const [index, amount] of presets.entries()) {
      const radio = page.getByRole("radiogroup", { name: "Stake preset" }).getByRole("radio").nth(index);
      await radio.click();
      assert.equal(await radio.getAttribute("aria-checked"), "true");
      assert(!(await radio.isDisabled()));
      assert(await page.getByText(`${(amount * 2).toLocaleString("en-US")} XLM`, { exact: true }).isVisible());
    }
    await input.fill("125.1234567");
    let captured;
    await page.route("**/api/matchmaking", async route => {
      if (route.request().method() !== "POST") return route.continue();
      captured = route.request().postDataJSON();
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "QA request captured", code: "qa_capture" }) });
    });
    for (const amount of [...presets, 25, 125.1234567]) {
      if (presets.includes(amount)) await page.getByRole("radiogroup", { name: "Stake preset" }).getByRole("radio").nth(presets.indexOf(amount)).click();
      else await input.fill(String(amount));
      const response = page.waitForResponse(response => response.url().endsWith("/api/matchmaking") && response.request().method() === "POST");
      await find.click();
      await response;
      assert.equal(captured.entryXlm, amount);
      assert.equal(captured.demo, false);
      await page.getByText("QA request captured", { exact: true }).waitFor();
    }
    await page.unroute("**/api/matchmaking");
    check(`All presets, custom limits, pool math and exact matchmaking requests at ${width}px`);
  }
  for (const amount of [24, 10001, 0, -1, true, [50], "0x32", "25.00000001"]) {
    for (const route of ["/api/duels", "/api/matchmaking"]) {
      const response = await context.request.post(base + route, { data: { mode: "private", entryXlm: amount } });
      assert.equal(response.status(), 400);
      assert.equal((await response.json()).code, "invalid_entry");
    }
  }
  check("Direct API requests cannot bypass the frontend's stake limits or decimal parsing");
  assert.deepEqual(report.errors, []);
} finally {
  await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser.close();
}
