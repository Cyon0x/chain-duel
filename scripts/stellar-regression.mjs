import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

export const baseline = "898340b24c45211690725158fa3bfab207ef4bd2";
const manifestPath = new URL("../docs/stellar-protected-files.json", import.meta.url);
const prefixes = [
  "contracts/chain_duel/",
  "src/lib/stellar/",
  "src/lib/wallet/",
  "src/lib/auth/",
  "src/lib/services/",
  "src/lib/db/",
  "src/lib/config/",
  "src/app/api/",
  "tests/",
];
const scripts = [
  "scripts/setup-testnet.mjs",
  "scripts/deploy-contract.mjs",
  "scripts/deploy-stake-contract.mjs",
  "scripts/fund-treasury.mjs",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

if (process.argv.includes("--record")) {
  const paths = execFileSync("git", ["ls-tree", "-r", "--name-only", baseline], { encoding: "utf8" })
    .trim()
    .split("\n")
    .filter((path) => prefixes.some((prefix) => path.startsWith(prefix)) || scripts.includes(path));
  const files = Object.fromEntries(
    paths.map((path) => [
      path,
      hash(execFileSync("git", ["show", `${baseline}:${path}`], { maxBuffer: 8_000_000 })),
    ]),
  );
  writeFileSync(manifestPath, JSON.stringify({ baseline, files }, null, 2) + "\n");
  console.log(`Recorded ${paths.length} protected Stellar files at ${baseline}.`);
} else {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const changed = Object.entries(manifest.files)
    .filter(([path, expected]) => {
      try {
        return hash(readFileSync(new URL(`../${path}`, import.meta.url))) !== expected;
      } catch {
        return true;
      }
    })
    .map(([path]) => path);
  if (changed.length) {
    console.error("Protected Stellar files changed:", changed.join(", "));
    process.exitCode = 1;
  } else console.log(`${Object.keys(manifest.files).length} protected Stellar files unchanged.`);
}
