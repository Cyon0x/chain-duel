import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { keccak256 } from "viem";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function arcBuildManifest() {
  const root = new URL("../contracts/arc/", import.meta.url);
  const artifact = JSON.parse(readFileSync(new URL("out/ChainDuelArc.sol/ChainDuelArc.json", root), "utf8"));
  const metadata = artifact.metadata;
  if (
    metadata?.compiler?.version !== "0.8.30+commit.73712a01" ||
    metadata.settings?.evmVersion !== "cancun" ||
    Object.keys(metadata.settings.libraries ?? {}).length
  )
    throw new Error("The Arc artifact compiler settings could not be verified.");
  const sources = Object.fromEntries(
    Object.entries(metadata.sources)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, entry]) => {
        const content = readFileSync(new URL(path, root));
        if (keccak256(content) !== entry.keccak256)
          throw new Error(`The Arc artifact is stale for ${path}. Rebuild before review.`);
        return [path, sha256(content)];
      }),
  );
  const bytecode = artifact.bytecode.object;
  if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(bytecode)) throw new Error("Invalid Arc creation bytecode.");
  return {
    artifact,
    manifest: {
      sourceSha256: sha256(readFileSync(new URL("src/ChainDuelArc.sol", root))),
      creationBytecodeSha256: sha256(Buffer.from(bytecode.slice(2), "hex")),
      sourcesSha256: sha256(JSON.stringify(sources)),
      sources,
      compiler: metadata.compiler.version,
      compilerSettings: metadata.settings,
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { manifest } = arcBuildManifest();
  const folder = new URL("../docs/arc-deployments/", import.meta.url);
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    new URL("build-manifest.json", folder),
    JSON.stringify(
      {
        ...manifest,
        approved: false,
        auditReference: "",
        note: "Build evidence only. A review must approve these hashes and the deployment constructor parameters.",
      },
      null,
      2,
    ) + "\n",
  );
  console.log("Arc build manifest saved. This does not certify a contract audit.");
}
