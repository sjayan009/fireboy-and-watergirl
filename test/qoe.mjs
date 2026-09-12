import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../app/src/net/qoe.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { QoeRecorder, latestQoeSummary } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const qoe = new QoeRecorder(false);
const transport = { activePath:'relay', sent:20, stats:{queueRecentMs:[0,0,20,50],queueMaxMs:90,sentPackets:30,
  receivedPackets:25,sentBytes:500,receivedBytes:450,droppedPackets:1},
  rtc:{candidateType:'relay',protocol:'udp',address:'private-address',credential:'private-password',token:'private-token'} };
qoe.attach(transport,'relay');
const session = {rttMs:200,jitterMs:15,rollbacks:3,deepestRollback:2,stalls:0,inputAgeMs:220,inputDelay:1,log:[[7,7]]};
for(let i=0;i<5000;i++) {
  qoe.tick(i*20,session);
  qoe.rendered({timestamp:i*20,renderMs:5,inputToRenderMs:i%10 === 0 ? 30 : null});
}
qoe.longTask(49); qoe.longTask(60); qoe.longTask(NaN);
let summary = qoe.summary();
assert.equal(summary.frameMs.samples,2048); assert.equal(summary.frameMs.p95,20);
assert.equal(summary.renderMs.p95,5); assert.equal(summary.inputToRenderMs.p95,30);
assert.equal(summary.transportQueueMs.p95,50); assert.equal(summary.transportQueueLifetimeMaxMs,90);
assert.equal(summary.rttMs.p95,200); assert.equal(summary.longTasks,1);
assert.equal(summary.mainThreadCpuPercent,null);
transport.activePath='rtc';
qoe.mainThreadCpu(42); summary=qoe.summary();
assert.equal(summary.activeApplicationPath,'rtc'); assert.equal(summary.mainThreadCpuPercent,42);
for(const secret of ['private-address','private-password','private-token','credential','log','token']) assert(!JSON.stringify(summary).includes(secret));
qoe.close(); assert.deepEqual(latestQoeSummary(),summary);
qoe.tick(999999,session); qoe.rendered({timestamp:999999,renderMs:10000,inputToRenderMs:1000});
assert.deepEqual(qoe.summary(),summary);
console.log('QOE PASSED: bounded percentiles, dynamic path, timing/null CPU, privacy allowlist and cleanup');
