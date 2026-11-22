import { readFileSync, writeFileSync } from "node:fs";
const artifact = JSON.parse(
  readFileSync(new URL("../contracts/arc/out/ChainDuelArc.sol/ChainDuelArc.json", import.meta.url), "utf8"),
);
writeFileSync(
  new URL("../src/lib/arc/abi.ts", import.meta.url),
  "// Generated from contracts/arc/src/ChainDuelArc.sol by scripts/arc-abi.mjs.\nexport const arcDuelAbi = " +
    JSON.stringify(artifact.abi, null, 2) +
    " as const;\n",
);
console.log("Arc ABI generated from the compiled escrow contract.");
