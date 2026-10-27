import assert from "node:assert/strict";
import { test } from "node:test";
import { ActiveCall, CallState } from "../dist/index.mjs";

const fakeEngine = () => {
  const calls = [];
  return {
    calls,
    acceptCall: (...args) => calls.push(["accept", ...args]),
    rejectCall: () => calls.push(["reject"]),
    endCall: (...args) => calls.push(["end", ...args]),
    setMute: () => {},
  };
};

const fakeUplink = () => ({ pushed: [], push(pcm) { this.pushed.push(pcm); }, flush() { this.pushed = []; } });

test("an early accept waits for the offer, then is sent once", () => {
  const engine = fakeEngine();
  const call = new ActiveCall("A", engine, fakeUplink(), "incoming");
  call.accept({ audioSource: "live" });
  assert.deepEqual(engine.calls, []);
  call._updateState(CallState.ReceivedCall);
  call._updateState(CallState.ReceivedCall);
  assert.deepEqual(engine.calls, [["accept", true, false]]);
});

test("an accept after the offer is sent immediately", () => {
  const engine = fakeEngine();
  const call = new ActiveCall("B", engine, fakeUplink(), "incoming");
  call._updateState(CallState.ReceivedCall);
  call.accept({ audioSource: "live" });
  assert.deepEqual(engine.calls, [["accept", true, false]]);
});

test("hanging up ends the call exactly once", async () => {
  const engine = fakeEngine();
  const call = new ActiveCall("C", engine, fakeUplink(), "incoming");
  const ended = [];
  call.on("ended", (reason) => ended.push(reason));
  call.end();
  call._updateState(CallState.Idle);
  assert.equal(await call.waitForEnd(), "hangup");
  assert.deepEqual(ended, ["hangup"]);
  assert.deepEqual(engine.calls, [["end", 0, true]]);
});

test("rejecting declines the call", async () => {
  const engine = fakeEngine();
  const call = new ActiveCall("D", engine, fakeUplink(), "incoming");
  call.reject();
  assert.deepEqual(engine.calls, [["reject"]]);
  assert.equal(await call.waitForEnd(), "rejected");
});

test("live audio goes to the uplink and a flush drops it", () => {
  const uplink = fakeUplink();
  const call = new ActiveCall("E", fakeEngine(), uplink, "incoming");
  call.pushAudio(new Float32Array(320));
  assert.equal(uplink.pushed.length, 1);
  call.flushAudio();
  assert.equal(uplink.pushed.length, 0);
});

test("only incoming calls can be accepted", () => {
  const call = new ActiveCall("F", fakeEngine(), fakeUplink(), "outgoing");
  assert.throws(() => call.accept(), /incoming/);
});

test("an ended call can no longer push audio into the shared uplink", () => {
  const pushed = [];
  const uplink = { push: (pcm) => pushed.push(pcm), flush: () => pushed.push("flush") };
  const engine = { endCall() {}, acceptCall() {}, rejectCall() {}, setMute() {} };
  const call = new ActiveCall("c1", engine, uplink, "incoming");
  call._forceEnd("hangup");
  call.pushAudio(new Float32Array(160));
  call.flushAudio();
  assert.deepEqual(pushed, []);
});
