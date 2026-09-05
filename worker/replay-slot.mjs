import { parentPort, workerData } from "node:worker_threads";
import { createHash } from "node:crypto";

// A fresh realm per job: no database credentials or engine globals are shared.
try {
  const { verifyReplay, parseReplay } = await import(workerData.module);
  const job = workerData.job;
  if (createHash("sha256").update(job.replay).digest("hex") !== job.digest) throw new Error("Digest disagreement");
  const replay = parseReplay(job.replay);
  if (replay.engine !== job.engine || replay.mode !== job.mode || replay.num !== job.level) throw new Error("Attempt disagreement");
  const result = verifyReplay(job.replay);
  parentPort.postMessage({ result });
} catch {
  parentPort.postMessage({ result: null, reason: "Replay did not satisfy the registered game rules" });
}
