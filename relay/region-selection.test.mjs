import assert from "node:assert/strict";
import { chooseJointRegion } from "./region-selection.mjs";

const a = {enam:[20,21,22,23,24,25],weur:[75,75,76,78,80,80]};
const b = {enam:[160,161,162,163,170,180],weur:[75,76,77,80,80,90]};
assert.equal(chooseJointRegion(a,b).region,"weur","must consider both players, not just initiator's nearest region");
assert.deepEqual(chooseJointRegion(a,b),{region:"weur",worstP95Ms:90,sumP50Ms:153,playerP50Ms:[76,77],playerP95Ms:[80,90]});
assert.equal(chooseJointRegion({enam:[1,2,null]},{enam:[1,2,3]}),null,"timeouts must not disappear from the statistics");
assert.equal(chooseJointRegion({enam:[1,2]},{enam:[1,2,3]}),null,"insufficient samples");
assert.equal(chooseJointRegion({enam:[1,2,3]},{weur:[1,2,3]}),null,"no jointly measured candidate");
const equal = {wnam:[20,20,20],enam:[20,20,20]};
assert.equal(chooseJointRegion(equal,equal).region,"enam","both peers use a deterministic tie-break");
assert.equal(chooseJointRegion({enam:[0,1,Infinity]},{enam:[0,1,2]}),null);
console.log("JOINT RELAY REGION SELECTION PASSED (7 assertions; synthetic samples, no WAN probes)");
