/** Independent reference vectors from the unchanged pre-upgrade game engine.
 * No wallet keys, RPC calls, financial operations or gameplay-source edits. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { ROOT } from "./lib.mjs";

const baseline="89eb64284399d1fdfbe03eafa00614dc4e5bec50";
const directory="/private/tmp/chain-duel-pulse-reference";
mkdirSync(directory,{recursive:true,mode:0o700});
const files={"src/lib/config/game.ts":"config-game.mjs","src/lib/game/rng.ts":"rng.mjs","src/lib/game/pulse.ts":"pulse.mjs","src/lib/game/bot.ts":"bot.mjs"};
const hash=value=>createHash("sha256").update(value).digest("hex");
const sourceHashes={};
for(const [file,name] of Object.entries(files)){
  const source=execFileSync("git",["show",`${baseline}:${file}`],{cwd:ROOT,encoding:"utf8"});
  sourceHashes[file]=hash(source);
  let code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  code=code.replaceAll('from "../config/game"','from "./config-game.mjs"').replaceAll('from "./pulse"','from "./pulse.mjs"').replaceAll('from "./rng"','from "./rng.mjs"');
  writeFileSync(resolve(directory,name),code,{mode:0o600});
}
const {buildTargetSchedule,scoreMatch}=await import(`${directory}/pulse.mjs`);
const {PulseBot}=await import(`${directory}/bot.mjs`);
const {Rng}=await import(`${directory}/rng.mjs`);
const {DEFAULT_BOT}=await import(`${directory}/config-game.mjs`);
const bits=value=>{const buffer=Buffer.alloc(8);buffer.writeDoubleBE(value);return buffer.toString("hex");};
const score=value=>({score:value.score,hits:value.hits,misses:value.misses,wrong_targets:value.wrongTargets,max_combo:value.maxCombo,best_multiplier_tenths:Math.round(value.bestMultiplier*10),last_hit_at_ms_bits:bits(value.lastHitAtMs)});
function packEvents(hits,misses){
  const events=[...hits.map(value=>({...value,kind:0})),...misses.map(value=>({...value,kind:1,targetId:0}))].sort((a,b)=>a.atMs-b.atMs||a.kind-b.kind);
  const bytes=Buffer.alloc(events.length*6);
  events.forEach((event,index)=>{bytes.writeUInt32BE(event.atMs,index*6);bytes.writeUInt16BE(event.targetId,index*6+4);});
  return bytes.toString("hex");
}
const vectors=[];
for(const durationMs of [60000,120000,300000])for(let index=0;index<64;index++){
  const seed=index===0?"pulse-🚀-unicode":`verified-pulse-reference-${index}`;
  const schedule=buildTargetSchedule(seed,durationMs);
  const bytes=Buffer.alloc(schedule.length*13);
  schedule.forEach((target,index)=>{const offset=index*13;bytes.writeUInt16BE(target.id,offset);bytes.writeUInt32BE(target.spawnAtMs,offset+2);bytes.writeUInt32BE(target.expiresAtMs,offset+6);bytes[offset+10]={blue:0,gold:1,red:2}[target.kind];bytes.writeInt16BE(target.points,offset+11);});
  const rng=new Rng(`human-vector:${seed}`);
  const hits=[];const misses=[];
  for(const target of schedule){
    const atMs=target.spawnAtMs+90+rng.int(0,80);
    if(atMs>durationMs)continue;
    if(target.points<0){if(rng.float()<0.07)hits.push({targetId:target.id,atMs});}
    else if(rng.float()<0.82)hits.push({targetId:target.id,atMs});
    else if(rng.float()<0.5)misses.push({atMs});
  }
  const bot=new PulseBot(seed,DEFAULT_BOT,durationMs);bot.update(durationMs);
  const human=scoreMatch(seed,{hits,misses},{durationMs});
  assert.equal(human.rejected,0);
  vectors.push({seed,durationMs,targetCount:schedule.length,scheduleSha256:hash(bytes),inputHex:packEvents(hits,misses),human:score(human),bot:score(bot.snapshot())});
}
const output=resolve(ROOT,"contracts/pulse_replay/test-vectors.json");
writeFileSync(output,JSON.stringify({schemaVersion:1,baselineCommit:baseline,sourceHashes,encoding:"uint32 timestamp BE, uint16 target ID BE; zero target ID is a miss",vectors},null,2)+"\n");
console.log(JSON.stringify({output,baselineCommit:baseline,vectorCount:vectors.length,durationsMs:[60000,120000,300000],sha256:hash(JSON.stringify(vectors)),readOnlyReference:true,financialTransactionsExecuted:false},null,2));
