/**
 * Audio feeder.
 *
 * Meters PCM chunks out at chunk-cadence to the WASM uplink. The PCM comes
 * either from ffmpeg decoding a file (`source` is a path, `lavfi:` spec or
 * `"silence"`) or, when `source` is `"live"`, from `push()` calls made while
 * the call runs. An empty queue always emits silence, so the uplink never
 * stalls.
 *
 * @author ShellTear
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export const LIVE_SOURCE = "live";

const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_FILE_CHUNKS = 1024;
const FILE_WARMUP_MS = 500;

export class AudioFeeder {
  #proc: ChildProcessWithoutNullStreams | null = null;
  #running = false;
  #pending = new Float32Array(0);
  #queue: Float32Array[] = [];
  #emitTimer: NodeJS.Timeout | null = null;
  #nextEmitAtMs = 0;
  #warmupUntilMs = 0;

  underflowChunks = 0;
  samplesProduced = 0;
  chunksEmitted = 0;

  constructor(
    private readonly sampleRate: number,
    private readonly channels: number,
    private readonly framesPerChunk: number,
    private readonly onChunk: (chunk: Float32Array) => void,
    private readonly source: string = "silence",
  ) {}

  get isLive(): boolean { return this.source === LIVE_SOURCE; }

  get #chunkSamples(): number { return this.framesPerChunk * this.channels; }

  start = (): void => {
    if (this.#running) return;
    this.#running = true;
    if (!this.isLive) {
      this.#spawnDecoder();
      this.#warmupUntilMs = Date.now() + FILE_WARMUP_MS;
    }
    this.#nextEmitAtMs = 0;
    this.#scheduleNext();
  };

  stop = (): void => {
    this.#running = false;
    if (this.#emitTimer) {
      clearTimeout(this.#emitTimer);
      this.#emitTimer = null;
    }
    this.#proc?.kill("SIGTERM");
    this.#proc = null;
    this.flush();
  };

  /** Queue live PCM for the uplink. Samples are interleaved at `sampleRate`. */
  push = (pcm: Float32Array): void => {
    if (!this.isLive) throw new Error("push() needs an AudioFeeder started with the live source");
    this.#enqueue(pcm);
  };

  /** Drop everything not yet sent, e.g. when the remote party interrupts. */
  flush = (): void => {
    this.#pending = new Float32Array(0);
    this.#queue = [];
  };

  get queuedMs(): number {
    const samples = this.#queue.length * this.#chunkSamples + this.#pending.length;
    return (samples / this.channels / this.sampleRate) * 1000;
  }

  #enqueue = (pcm: Float32Array): void => {
    const combined = new Float32Array(this.#pending.length + pcm.length);
    combined.set(this.#pending);
    combined.set(pcm, this.#pending.length);
    let offset = 0;
    while (combined.length - offset >= this.#chunkSamples) {
      this.#queue.push(combined.slice(offset, offset + this.#chunkSamples));
      offset += this.#chunkSamples;
    }
    this.#pending = combined.slice(offset);
    this.samplesProduced += pcm.length;
  };

  #spawnDecoder = (): void => {
    this.#proc = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel", "error",
      "-thread_queue_size", "512",
      ...this.#decoderInputArgs(),
      "-f", "f32le",
      "-ac", String(this.channels),
      "-ar", String(this.sampleRate),
      "pipe:1",
    ]);

    let carry = Buffer.alloc(0);
    this.#proc.stdout.on("data", (chunk: Buffer) => {
      carry = Buffer.concat([carry, chunk]);
      const whole = carry.length - (carry.length % Float32Array.BYTES_PER_ELEMENT);
      const samples = new Float32Array(whole / Float32Array.BYTES_PER_ELEMENT);
      new Uint8Array(samples.buffer).set(carry.subarray(0, whole));
      carry = carry.subarray(whole);
      this.#enqueue(samples);
      if (this.#queue.length >= MAX_QUEUED_FILE_CHUNKS) this.#proc?.stdout.pause();
    });

    this.#proc.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[AudioFeeder] ${chunk.toString().trim()}\n`);
    });

    this.#proc.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        process.stderr.write(`[AudioFeeder] ffmpeg exited with code=${code}\n`);
      }
      this.#proc = null;
    });
  };

  #decoderInputArgs = (): string[] => {
    if (!this.source || this.source === "silence") {
      return ["-f", "lavfi", "-i", `aevalsrc=0:d=3600:s=${this.sampleRate}`];
    }
    if (this.source.startsWith("lavfi:")) {
      return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
    }
    return ["-i", this.source];
  };

  #scheduleNext = (): void => {
    if (!this.#running) return;
    const now = Date.now();
    if (this.#nextEmitAtMs === 0) this.#nextEmitAtMs = now;
    const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;

    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = null;
      if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
        this.#nextEmitAtMs = Date.now() + 10;
        this.#scheduleNext();
        return;
      }
      this.#emitOne();
      this.#nextEmitAtMs += chunkIntervalMs;
      this.#scheduleNext();
    }, Math.max(0, this.#nextEmitAtMs - now));
  };

  #emitOne = (): void => {
    let nextChunk = this.#queue.shift();
    if (!nextChunk) {
      nextChunk = new Float32Array(this.#chunkSamples);
      this.underflowChunks += 1;
    }
    this.chunksEmitted += 1;
    this.onChunk(nextChunk);
    if (this.#proc?.stdout.isPaused() && this.#queue.length <= MAX_QUEUED_FILE_CHUNKS / 4) {
      this.#proc.stdout.resume();
    }
  };
}
