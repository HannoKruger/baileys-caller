import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { AudioFeeder, LIVE_SOURCE } from "../dist/audio-feeder.mjs";

const SAMPLE_RATE = 16000;
const FRAMES_PER_CHUNK = 320;

test("live audio is sent in chunks, then silence keeps the uplink going", async () => {
  const chunks = [];
  const feeder = new AudioFeeder(SAMPLE_RATE, 1, FRAMES_PER_CHUNK, (chunk) => chunks.push(chunk), LIVE_SOURCE);
  feeder.start();
  feeder.push(new Float32Array(FRAMES_PER_CHUNK * 2).fill(0.5));
  await sleep(110);
  feeder.stop();
  assert.equal(chunks.filter((chunk) => chunk[0] === 0.5).length, 2);
  assert.ok(chunks.length > 2, "an empty queue must emit silence, not stall");
  assert.ok(chunks.every((chunk) => chunk.length === FRAMES_PER_CHUNK));
});

test("flush drops queued live audio", () => {
  const feeder = new AudioFeeder(SAMPLE_RATE, 1, FRAMES_PER_CHUNK, () => {}, LIVE_SOURCE);
  feeder.push(new Float32Array(SAMPLE_RATE));
  assert.equal(feeder.queuedMs, 1000);
  feeder.flush();
  assert.equal(feeder.queuedMs, 0);
});

test("a file source refuses live pushes", () => {
  const feeder = new AudioFeeder(SAMPLE_RATE, 1, FRAMES_PER_CHUNK, () => {}, "silence");
  assert.throws(() => feeder.push(new Float32Array(1)), /live source/);
});
