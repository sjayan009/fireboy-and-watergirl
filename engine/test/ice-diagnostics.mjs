import assert from "node:assert/strict";
import { selectedIceDiagnostics, connectWebRTC } from "../dist/net/webrtc.js";

const report = (entries) => new Map(entries.map((entry) => [entry.id, entry]));
const candidates = [
  { id: "local", type: "local-candidate", candidateType: "host", protocol: "udp", address: "192.0.2.1", port: 1234 },
  { id: "remote", type: "remote-candidate", candidateType: "srflx", protocol: "udp", address: "192.0.2.2" },
  { id: "other", type: "candidate-pair", state: "succeeded", currentRoundTripTime: 9 },
  { id: "actual", type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: .034 },
  { id: "transport", type: "transport", selectedCandidatePairId: "actual" },
];
assert.deepEqual(selectedIceDiagnostics(report(candidates)), { candidateType: "host", protocol: "udp", currentRoundTripTime: .034 });
candidates[0] = { ...candidates[0], candidateType: "relay", relayProtocol: "tls" };
assert.deepEqual(selectedIceDiagnostics(report(candidates)), { candidateType: "relay", protocol: "udp", relayProtocol: "tls", currentRoundTripTime: .034 });
assert(!JSON.stringify(selectedIceDiagnostics(report(candidates))).includes("192.0.2"));
assert.deepEqual(selectedIceDiagnostics(report([candidates[2]])), {}, "unselected succeeded probes do not become path RTT");
assert.deepEqual(selectedIceDiagnostics(report([
  candidates[0], candidates[1], { ...candidates[3], nominated: true, currentRoundTripTime: Infinity },
])), { candidateType: "relay", protocol: "udp", relayProtocol: "tls" });
candidates[0] = { ...candidates[0], candidateType: "host", relayProtocol: undefined };
candidates[1] = { ...candidates[1], candidateType: "relay" };
assert.equal(selectedIceDiagnostics(report(candidates)).candidateType, "relay", "remote-only TURN remains a relayed path");

let configuration;
globalThis.RTCPeerConnection = class {
  constructor(config) { configuration = config; }
  createDataChannel() { return { readyState: "open", close() {} }; }
  async createOffer() { return { type: "offer", sdp: "test" }; }
  async setLocalDescription(offer) { this.localDescription = { toJSON: () => offer }; }
  async getStats() { return report(candidates); }
  close() {}
};
const signal = { onMessage() {}, send() {}, close() {}, rttMs: null };
const plain = await connectWebRTC(signal, true, { iceServers: [] });
assert.equal(configuration.iceTransportPolicy, "all");
plain.close();
const forced = await connectWebRTC(signal, true, { iceServers: [{ urls: "turn:turn.cloudflare.com:3478", username: "short", credential: "short" }], iceTransportPolicy: "relay" });
assert.equal(configuration.iceTransportPolicy, "relay");
forced.close();
delete globalThis.RTCPeerConnection;
console.log("ICE diagnostics: selected pair, candidate/protocol/RTT, privacy, invalid stats and opt-in relay policy passed");
