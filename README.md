# baileys-caller

Place WhatsApp voice calls from Node.js.

Wraps WhatsApp Web's official VoIP WASM stack and uses [Baileys](https://github.com/WhiskeySockets/Baileys) for authentication and signaling. Audio (MP3, WAV, or `Float32Array`) is encoded with Opus and sent over the live RTP session.

> **Author:** ShellTear. This fork adds answering incoming calls and streaming
> live audio out, so an AI agent can hold a conversation on a call.

## Status

- ✅ Outbound 1:1 voice calls
- ✅ Inbound 1:1 voice calls (accept / reject)
- ✅ Stream audio from MP3/WAV files, or live with `pushAudio()`
- ✅ Receive remote audio as `Float32Array`
- ✅ Mute / unmute / hang up
- ❌ Group calls
- ❌ Video

## Requirements

- Node.js ≥ 20
- `ffmpeg` on `PATH` (used to decode/resample audio sources)
- A linked WhatsApp account (you'll scan a QR on first run)

## Install

This package isn't published on npm. Pull it in directly from git:

```bash
git clone https://github.com/SheIITear/baileys-caller
cd baileys-caller
npm install
npm run build
```

You can also depend on it from another project via a git URL in `package.json`:

```json
{
  "dependencies": {
    "baileys-caller": "git+https://github.com/SheIITear/baileys-caller.git",
    "@whiskeysockets/baileys": "^7.0.0-rc11"
  }
}
```

Baileys is a peer dependency. Install `baileys` or `@whiskeysockets/baileys` in your project alongside this one.

## Quick Start

```ts
import { VoipClient } from "baileys-caller";

const client = new VoipClient({ authDir: "./auth" });

await client.connect(); // first run prints a QR for WhatsApp > Linked Devices

const call = await client.call("12345678901", {
  audioSource: "./hello.mp3",
});

call.on("ringing",   () => console.log("ringing"));
call.on("connected", () => console.log("connected"));
call.on("audio",     (pcm) => { /* 16 kHz mono Float32Array from the peer */ });
call.on("ended",     (reason) => console.log("ended:", reason));

await call.waitForEnd();
client.disconnect();
```

### Answering calls

```ts
client.on("call", (call) => {
  if (call.peer?.phoneNumber !== "12345678901") return; // leave it ringing
  call.accept({ audioSource: "live" });
  call.on("audio", (pcm) => call.pushAudio(pcm)); // echo the caller back
});
```

Run the bundled examples from a clone:

```bash
npx tsx examples/call.mts ./auth 12345678901 ./hello.mp3
npx tsx examples/answer.mts ./auth 12345678901   # echoes the caller back
```

## API

### `new VoipClient(options)`

| Option    | Type     | Description                                |
|-----------|----------|--------------------------------------------|
| `authDir` | `string` | Baileys multi-file auth state directory    |

### `client.connect(): Promise<void>`

Connects to WhatsApp. On first run a QR code is printed; scan it from `WhatsApp > Settings > Linked Devices`. Subsequent runs reuse `authDir`.

### `client.call(phoneNumber, opts?): Promise<ActiveCall>`

Places an outbound call. `phoneNumber` is digits only (e.g. `"12345678901"`).

| Option        | Type                  | Description                                              |
|---------------|-----------------------|----------------------------------------------------------|
| `audioSource` | `string \| "silence"` | Path to MP3/WAV, or `"silence"` for an empty stream      |
| `durationMs`  | `number?`             | Auto-hangup after N ms                                   |

### `client.on("call", (call: ActiveCall) => ...)`

An incoming voice call. `call.peer` has the caller's `jid`, `phoneNumber`
(when WhatsApp sends it) and `isVideo`. Ignore the call to leave it ringing on
your other devices.

### `client.on("disconnected", (error) => ...)`

The WhatsApp socket closed after it was open. Reconnect by restarting.

### `client.socket`

The underlying Baileys socket, e.g. for `sendMessage`.

### `client.disconnect(): void`

Closes the WhatsApp socket and releases resources.

### `ActiveCall`

Returned by `client.call()`. Extends `EventEmitter`.

#### Events

| Event       | Payload         | When                                          |
|-------------|-----------------|-----------------------------------------------|
| `ringing`   | —               | Outgoing only: remote device is ringing       |
| `connected` | —               | Call answered, media flowing                  |
| `audio`     | `Float32Array`  | 16 kHz mono PCM frame from the remote peer    |
| `ended`     | `string`        | `hangup`, `rejected`, `ended`, `disconnect`   |
| `error`     | `Error`         | Fatal error                                   |

#### Methods

- `call.accept({ audioSource?, durationMs? }): void` — answer an incoming call. `audioSource` is a file, `"silence"`, or `"live"`
- `call.reject(): void` — decline an incoming call
- `call.pushAudio(pcm: Float32Array): void` — stream live audio (16 kHz mono, needs `audioSource: "live"`)
- `call.flushAudio(): void` — drop queued live audio, e.g. on barge-in
- `call.end(): void` — hang up
- `call.mute(muted: boolean): void` — toggle outgoing mute
- `call.waitForEnd(): Promise<string>` — resolves with end reason

#### Properties

- `call.callId: string`
- `call.direction: "outgoing" | "incoming"`
- `call.peer?: { jid, phoneNumber?, isVideo }` — incoming calls

## How it works

1. Baileys handles WhatsApp authentication, encryption, and signaling stanzas.
2. The WhatsApp Web VoIP WASM stack runs in-process to negotiate the call, encode/decode Opus, and manage the RTP/SRTP session.
3. A pthread pool of `worker_threads` mirrors the browser's Web Worker pool the WASM expects.
4. Outbound audio is decoded with `ffmpeg`, resampled to 16 kHz mono, fed into the WASM, and delivered to the relay.
5. Inbound audio is exposed as `Float32Array` chunks via the `audio` event.

## Auth state

`authDir` stores Baileys session keys after the first QR scan. Treat it like a credential — anyone with that directory can act as your linked device.

## WASM resources

The WASM binary and its loader (`whatsapp.wasm`, `loader.js`, `worker-modules.js`) live under `assets/wasm/`. To refresh them from a current WhatsApp Web session:

```bash
npm run fetch-wasm
```

## License

MIT © ShellTear
