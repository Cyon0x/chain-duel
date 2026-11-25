/** Run only migration tests against the already isolated Preview database.
 * The test uses an ephemeral schema inside a rolled-back transaction. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { ROOT } from "./lib.mjs";

const option = name => process.argv.includes(name) ? process.argv[process.argv.indexOf(name)+1] : undefined;
const urlFile = option("--database-url-file");
assert(urlFile, "Pass the existing isolated Preview database URL file; never a production URL.");
const url = readFileSync(urlFile,"utf8").trim();
assert.equal(new URL(url).pathname,"/chain_duel_multichain_preview","Migration testing requires the isolated Preview database.");
const child = spawn(process.execPath,[`${ROOT}/node_modules/vitest/vitest.mjs`,"run","tests/stellar-mainnet-postgres.test.ts","tests/arc-postgres.test.ts","--maxWorkers=1"],{ cwd: ROOT, env: { ...process.env, CHAIN_DUEL_STELLAR_PG_TEST_URL:url, CHAIN_DUEL_ARC_PG_TEST_URL:url }, stdio:["ignore","inherit","inherit"] });
child.once("error",error => { console.error(JSON.stringify({error:"Migration test process could not start",code:error.code ?? "spawn_failed"})); process.exitCode=1; });
child.once("exit",code => { process.exitCode=code ?? 1; });
