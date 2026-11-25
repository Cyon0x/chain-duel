/** SDK 28 requires the Stellar CLI's spec shaking and the pinned Rust toolchain. */
import { spawnSync } from "node:child_process";
import { stellarBin } from "./lib.mjs";

const result = spawnSync(stellarBin(), ["contract", "build", "--locked", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, RUSTUP_TOOLCHAIN: "1.92.0" },
});
if (result.error) { console.error("The installed Stellar CLI could not build the contract."); process.exit(1); }
process.exit(result.status ?? 1);
