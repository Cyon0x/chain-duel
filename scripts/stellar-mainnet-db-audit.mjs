/** Read-only counts, association fingerprints and designated-wallet key checks. */
import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Pool } from "pg";
import { Keypair } from "@stellar/stellar-sdk";
import { loadEnvFile } from "./lib.mjs";

const arg = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined;
const env = Object.fromEntries(Object.entries(loadEnvFile(arg("--env-file") ?? ".env.local")).map(([k,v]) => [k, /^".*"$/.test(v) ? JSON.parse(v) : v]));
const ADMIN = "GCQKVXWIQHVGUOUHZR2O6YBWBNNPKIYH5AWQHXHF3EYRHM73WIWVSK7K";
const PLAYER = "GBGDTBOXVZ4GIDDRISY5FGXYY7XCWCCK3FRHJHSVFEZMWA3ZZ2HUALTK";
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
let pool;
try {
  const databaseUrl = arg("--database-url-file") ? readFileSync(arg("--database-url-file"),"utf8").trim() : env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.includes("[SENSITIVE]")) throw new Error("Unavailable database configuration");
  pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 15000, ssl: databaseUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : undefined });
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const scope = (await client.query("SELECT current_database() AS database,current_schema() AS schema")).rows[0];
    if (arg("--expect-database") && scope.database !== arg("--expect-database")) throw new Error("Unexpected database scope");
    const tables = ["users","profiles","wallets","wallet_keys","games","game_players","matches","transactions","arc_wallets","arc_duels","arc_transactions","bridge_transfers","bridge_steps"];
    const existing = new Set((await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()" )).rows.map(row => row.table_name));
    const counts = {};
    for (const table of tables) if (existing.has(table)) counts[table] = (await client.query(`SELECT COUNT(*)::text AS count FROM ${table}`)).rows[0].count;
    const associations = (await client.query("SELECT id,user_id,address,provider,custody,network,is_primary FROM wallets ORDER BY id")).rows;
    const keys = (await client.query("SELECT wallet_id,ciphertext,iv,auth_tag FROM wallet_keys ORDER BY wallet_id")).rows;
    const controlled = associations.filter(wallet => [ADMIN, PLAYER].includes(wallet.address)).map(wallet => {
      const key = keys.find(item => item.wallet_id === wallet.id);
      let signerMatches = null;
      if (key) {
        try {
          const decrypt = createDecipheriv("aes-256-gcm", createHash("sha256").update(env.WALLET_ENCRYPTION_KEY).digest(), Buffer.from(key.iv,"base64"));
          decrypt.setAuthTag(Buffer.from(key.auth_tag,"base64"));
          const seed = Buffer.concat([decrypt.update(Buffer.from(key.ciphertext,"base64")),decrypt.final()]);
          signerMatches = Keypair.fromSecret(seed.toString("utf8")).publicKey() === wallet.address;
          seed.fill(0);
        } catch { signerMatches = false; }
      }
      return { address: wallet.address, custody: wallet.custody, storedNetwork: wallet.network, encryptedKeyPresent: Boolean(key), signerMatches };
    });
    await client.query("COMMIT");
    const report = { checkedAt: new Date().toISOString(), readOnly: true, scope, counts, walletAssociationsSha256: hash(associations), encryptedWalletKeysSha256: hash(keys), controlledWallets: controlled };
    const path = arg("--output") ?? "docs/stellar-mainnet-deployments/db-before.json";
    writeFileSync(path, JSON.stringify(report,null,2)+"\n");
    console.log(JSON.stringify(report,null,2));
  } finally { client.release(); }
} catch (error) {
  console.error(JSON.stringify({ error: "Read-only database audit could not complete; no data or funds were changed.", code: error?.code ?? error?.cause?.code ?? "audit_failed" }));
  process.exitCode = 1;
} finally { if (pool) await pool.end(); }
