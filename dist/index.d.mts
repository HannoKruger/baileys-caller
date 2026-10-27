/**
 * baileys-caller — WhatsApp voice calling for Node.js.
 *
 * Wraps WhatsApp Web's official VoIP WASM stack and routes signaling through
 * Baileys. Public surface:
 *
 *   const client = new VoipClient({ authDir })
 *   await client.connect()
 *   const call = await client.call("12345678901", { audioSource: "./hi.mp3" })
 *
 * @author ShellTear
 */
import { EventEmitter } from "node:events";
import { WasmEngine } from "./wasm-engine.mjs";
import { CallState, type VoipSdkConfig } from "./types.mjs";
export type { VoipSdkConfig, CallOptions, CallEvents, AudioConfig } from "./types.mjs";
export { CallState } from "./types.mjs";
/** Where an `ActiveCall` sends live audio: the uplink feeder, whichever is current. */
type Uplink = {
    push: (pcm: Float32Array) => void;
    flush: () => void;
};
export type CallDirection = "outgoing" | "incoming";
/** Who placed an incoming call, as read from its offer stanza. */
export type CallPeer = {
    /** Routing JID of the caller (usually a LID). */
    jid: string;
    /** Caller phone number, digits only, when WhatsApp includes it. */
    phoneNumber?: string;
    isVideo: boolean;
};
/** A live or recently-ended call. */
export declare class ActiveCall extends EventEmitter {
    #private;
    readonly callId: string;
    private readonly engine;
    private readonly uplink;
    readonly direction: CallDirection;
    readonly peer?: CallPeer | undefined;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource: string;
    constructor(callId: string, engine: WasmEngine, uplink: Uplink, direction: CallDirection, peer?: CallPeer | undefined);
    get state(): CallState;
    /**
     * Answer an incoming call. `audioSource` is a file, `"silence"`, or `"live"`
     * to stream with `pushAudio()`. WhatsApp only accepts once the offer has been
     * processed, so an early accept is held until the call reaches ReceivedCall.
     */
    accept: (opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => void;
    reject: () => void;
    end: () => void;
    mute: (muted: boolean) => void;
    /** Stream PCM to the peer. Needs `audioSource: "live"`; Float32 at the negotiated capture format, 16 kHz mono in practice. */
    pushAudio: (pcm: Float32Array) => void;
    /** Drop queued outbound audio, e.g. when the peer starts talking over it. */
    flushAudio: () => void;
    waitForEnd: () => Promise<string>;
    /** @internal */
    _limitDuration: (durationMs: number) => void;
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState: (state: number) => void;
    /** @internal */
    _emitAudio: (pcm: Float32Array) => void;
    /** @internal */
    _forceEnd: (reason: string) => void;
}
/**
 * Top-level client. Connects to WhatsApp, places calls, and emits `"call"`
 * with an incoming `ActiveCall` to `accept()` or `reject()`. Emits `"qr"`
 * with each linking code while unlinked, and `"disconnected"` when the
 * WhatsApp socket closes after it was open.
 */
export declare class VoipClient extends EventEmitter {
    #private;
    constructor(config: VoipSdkConfig);
    /** The underlying Baileys socket, e.g. to send a text message. */
    get socket(): any;
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect: () => Promise<void>;
    /** Place an outbound voice call. */
    call: (phoneNumber: string, opts?: {
        audioSource?: string;
        durationMs?: number;
    }) => Promise<ActiveCall>;
    /** Tear down the WhatsApp socket and release resources. */
    disconnect: () => void;
}
