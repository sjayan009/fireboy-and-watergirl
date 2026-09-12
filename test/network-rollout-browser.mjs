/** Serialize browser checks so fixtures never compete for ports or measurements. */
import { spawnSync } from 'node:child_process';
const tests = [
  'engine/test/webrtc.mjs',
  'engine/test/transport-failover.mjs',
  'app/test/pathmanager-webrtc.mjs',
  'engine/test/render-readonly.mjs',
  'engine/test/render-schedule.mjs',
  'engine/test/render-reconciliation.mjs',
  'engine/test/crossengine.mjs',
];
for(const test of tests) {
  console.log(`Running ${test}`);
  const args = test.endsWith('transport-failover.mjs') ? [test,'--rollout'] : [test];
  const result = spawnSync(process.execPath,args,{stdio:'inherit'});
  if(result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log('ROLLOUT BROWSER CHECKS PASSED');
