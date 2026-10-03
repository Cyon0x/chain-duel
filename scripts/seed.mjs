/**
 * Local development fixtures.
 *
 * Creates demo-mode accounts so the player directory and leaderboard have
 * something to show while developing. Fixtures are created through the real
 * sign-in + onboarding flow, so every row is exactly what the app would write;
 * their stats start at zero because they have not played a duel yet. No
 * financial history is fabricated.
 *
 * Usage: node scripts/seed.mjs [baseUrl]
 */
const baseUrl = process.argv[2] ?? process.env.APP_URL ?? "http://localhost:4310";
const NAMES = ["nova_kite", "orbit_ace", "pulse_zero", "vector_ray", "lumen_fox", "prism_echo"];

async function createAccount(name) {
  const jar = [];
  const call = async (path, init = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(jar.length ? { cookie: jar.join("; ") } : {}),
        ...(init.headers ?? {}),
      },
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      jar.push(cookie.split(";")[0]);
    }
    const body = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
    if (!response.ok) throw new Error(`${path} → ${response.status} ${JSON.stringify(parsed).slice(0, 200)}`);
    return parsed;
  };

  await call("/api/auth/demo", { method: "POST", body: JSON.stringify({ name }) });
  await call("/api/onboarding", { method: "POST", body: JSON.stringify({ username: name, theme: "neon" }) });
  return name;
}

console.log(`Seeding demo duelists against ${baseUrl}`);
for (const name of NAMES) {
  try {
    await createAccount(name);
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}
console.log("\nDone. These accounts are demo-mode only: they cannot stake real Testnet funds.");
