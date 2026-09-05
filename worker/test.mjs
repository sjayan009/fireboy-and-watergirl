import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalReplay, parseReplay } from "../engine/dist/verified.js";
import { ENGINE_VERSION } from "../engine/dist/version.js";
import { versions } from "./versions.mjs";

const replay = {version:1,engine:ENGINE_VERSION,mode:"adventure",num:1,frames:260,inputs:Buffer.alloc(260).toString("base64"),commands:[]};
const text=canonicalReplay(replay);
assert.deepEqual(parseReplay(text),replay);
assert.throws(()=>parseReplay(canonicalReplay({...replay,engine:"unsupported"})));
assert.throws(()=>parseReplay(canonicalReplay({...replay,commands:[[10,2,1,0],[10,2,0,0]]})));
assert.throws(()=>parseReplay(canonicalReplay({...replay,commands:[[10,2,0,0],[10,2,0,0]]})));
assert.throws(()=>parseReplay(" "+text));
assert.throws(()=>parseReplay("x".repeat(1048577)));
const base={engine:ENGINE_VERSION,mode:"adventure",level:1,replay:text,digest:createHash("sha256").update(text).digest("hex")};
async function execute(job) {
  const worker=new Worker(new URL("./replay-slot.mjs",import.meta.url),{workerData:{module:versions.get(ENGINE_VERSION),job},env:{},resourceLimits:{maxOldGenerationSizeMb:256}});
  const deadline=setTimeout(()=>worker.terminate(),10000);
  try {
    return await new Promise((resolve,reject)=>{
      worker.once("message",resolve);worker.once("error",reject);
      worker.once("exit",()=>reject(new Error("Verifier exited without an outcome")));
    });
  } finally {clearTimeout(deadline);await worker.terminate();}
}
const outcomes=await Promise.all([execute(base),execute({...base,digest:"0".repeat(64)}),execute({...base,level:2})]);
for (const outcome of outcomes) assert.deepEqual(outcome,{result:null,reason:"Replay did not satisfy the registered game rules"});
const fixture=JSON.parse(readFileSync(new URL("./fixtures/speed3.json",import.meta.url),"utf8"));
const success=canonicalReplay({version:1,engine:ENGINE_VERSION,mode:fixture.mode,num:fixture.num,frames:fixture.frames,inputs:fixture.inputs,commands:fixture.commands});
const job={engine:ENGINE_VERSION,mode:fixture.mode,level:fixture.num,replay:success,digest:createHash("sha256").update(success).digest("hex")};
for(const outcome of await Promise.all([execute(job),execute(job)])) assert.deepEqual(outcome,{result:fixture.expected});
console.log("PASS: two isolated successful replays derive the same score; incomplete run rejection, digest/attempt binding, canonical order, version and payload limits");
