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
import { randomBytes, createHmac } from "node:crypto";
import { resolve } from "node:path";
import { WasmEngine } from "./wasm-engine.mjs";
import { RelayRtcTransport } from "./relay-transport.mjs";
import { SignalingBridge } from "./signaling.mjs";
import { AudioFeeder } from "./audio-feeder.mjs";
import { loadBaileys } from "./baileys.mjs";
import { CallState } from "./types.mjs";
export { CallState } from "./types.mjs";
const SHA256_LEN = 32;
const toBareJid = (jid) => {
    if (!jid)
        return jid;
    const at = jid.indexOf("@");
    if (at < 0)
        return jid;
    const user = jid.slice(0, at).split(":")[0];
    return `${user}@${jid.slice(at + 1)}`;
};
const computeHkdf = (key, salt, info, length) => {
    const effectiveSalt = salt && salt.length > 0 ? Buffer.from(salt) : Buffer.alloc(SHA256_LEN, 0);
    const prk = createHmac("sha256", effectiveSalt).update(key).digest();
    const blocks = Math.ceil(length / SHA256_LEN);
    const okm = Buffer.alloc(blocks * SHA256_LEN);
    let prev = Buffer.alloc(0);
    for (let i = 1; i <= blocks; i += 1) {
        prev = createHmac("sha256", prk)
            .update(prev)
            .update(info)
            .update(Buffer.from([i]))
            .digest();
        prev.copy(okm, (i - 1) * SHA256_LEN);
    }
    return new Uint8Array(okm.buffer, okm.byteOffset, length);
};
const computeHmacSha256 = (data, key) => {
    const result = createHmac("sha256", Buffer.from(key)).update(data).digest();
    return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
};
const isCallReceiptNode = (node) => {
    if (node?.tag !== "receipt")
        return false;
    const child = Array.isArray(node.content) ? node.content[0] : null;
    return !!(child?.attrs?.["call-id"] || child?.attrs?.call_id);
};
/** A live or recently-ended call. */
export class ActiveCall extends EventEmitter {
    callId;
    engine;
    uplink;
    direction;
    peer;
    #state = CallState.Idle;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    #acceptPending = false;
    /** @internal mirrors the source path for the audio feeder */
    _audioSource = "silence";
    constructor(callId, engine, uplink, direction, peer) {
        super();
        this.callId = callId;
        this.engine = engine;
        this.uplink = uplink;
        this.direction = direction;
        this.peer = peer;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
    }
    get state() { return this.#state; }
    /**
     * Answer an incoming call. `audioSource` is a file, `"silence"`, or `"live"`
     * to stream with `pushAudio()`. WhatsApp only accepts once the offer has been
     * processed, so an early accept is held until the call reaches ReceivedCall.
     */
    accept = (opts = {}) => {
        if (this.direction !== "incoming")
            throw new Error("Only incoming calls can be accepted.");
        if (this.#ended || this.#acceptPending)
            return;
        this._audioSource = opts.audioSource ?? "silence";
        this._limitDuration(opts.durationMs ?? 0);
        this.#acceptPending = true;
        if (this.#state === CallState.ReceivedCall)
            this.#sendAccept();
    };
    reject = () => {
        if (this.direction !== "incoming" || this.#ended)
            return;
        try {
            this.engine.rejectCall();
        }
        catch { }
        this._forceEnd("rejected");
    };
    end = () => {
        if (this.#ended)
            return;
        try {
            this.engine.endCall(0, true);
        }
        catch { }
        this._forceEnd("hangup");
    };
    mute = (muted) => {
        try {
            this.engine.setMute(muted);
        }
        catch { }
    };
    /** Stream PCM to the peer. Needs `audioSource: "live"`; Float32 at the negotiated capture format, 16 kHz mono in practice. */
    pushAudio = (pcm) => { this.uplink.push(pcm); };
    /** Drop queued outbound audio, e.g. when the peer starts talking over it. */
    flushAudio = () => { this.uplink.flush(); };
    waitForEnd = () => this.#endPromise;
    /** @internal */
    _limitDuration = (durationMs) => {
        if (durationMs <= 0)
            return;
        if (this.#endTimer)
            clearTimeout(this.#endTimer);
        this.#endTimer = setTimeout(() => this.end(), durationMs);
    };
    /** @internal — called by VoipClient on WASM call-state change */
    _updateState = (state) => {
        this.#state = state;
        if (state === CallState.ReceivedCall && this.#acceptPending)
            this.#sendAccept();
        else if (state === CallState.PreacceptReceived)
            this.emit("ringing");
        else if (state === CallState.Active)
            this.emit("connected");
        else if (state === CallState.Idle || state === CallState.Ending) {
            this._forceEnd("ended");
        }
    };
    #sendAccept = () => {
        this.#acceptPending = false;
        try {
            this.engine.acceptCall(true, false);
        }
        catch (err) {
            this.emit("error", err instanceof Error ? err : new Error(String(err)));
        }
    };
    /** @internal */
    _emitAudio = (pcm) => { this.emit("audio", pcm); };
    /** @internal */
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit("ended", reason);
        this.#endResolver(reason);
    };
}
/**
 * Top-level client. Connects to WhatsApp, places calls, and emits `"call"`
 * with an incoming `ActiveCall` to `accept()` or `reject()`. Emits `"qr"`
 * with each linking code while unlinked, and `"disconnected"` when the
 * WhatsApp socket closes after it was open.
 */
export class VoipClient extends EventEmitter {
    #config;
    #engine = null;
    #relay = null;
    #signaling = null;
    #sock = null;
    #activeCall = null;
    #baileys = null;
    // Capture state populated when WASM negotiates audio params
    #capturePtr = 0;
    #captureChunkBytes = 0;
    #captureSampleRate = 16000;
    #captureChannels = 1;
    #captureFramesPerChunk = 320;
    #feeder = null;
    // Live audio pushed after accept() but before WhatsApp starts audio
    // capture, such as a greeting, waits here instead of being dropped.
    #earlyUplink = [];
    #uplink = {
        push: (pcm) => {
            if (this.#feeder)
                this.#feeder.push(pcm);
            else
                this.#earlyUplink.push(pcm);
        },
        flush: () => {
            this.#feeder?.flush();
            this.#earlyUplink = [];
        },
    };
    constructor(config) {
        super();
        this.#config = config;
    }
    /** The underlying Baileys socket, e.g. to send a text message. */
    get socket() { return this.#sock; }
    /** Connect to WhatsApp and bring up the WASM VoIP stack. */
    connect = async () => {
        this.#baileys = await loadBaileys();
        const { useMultiFileAuthState, default: makeWASocket, DisconnectReason } = this.#baileys;
        const makeSocket = makeWASocket ?? this.#baileys.makeWASocket ?? this.#baileys;
        const authDir = resolve(this.#config.authDir);
        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const silentLogger = {
            level: "silent",
            child: () => silentLogger,
            trace: () => { },
            debug: () => { },
            info: () => { },
            warn: () => { },
            error: () => { },
            fatal: () => { },
        };
        const createSocket = () => makeSocket({
            auth: state,
            emitOwnEvents: true,
            logger: silentLogger,
        });
        // Connect with auto-reconnect on the post-QR 515 stream-error path.
        // Baileys can throw the 515 restart out of its socket handler, so it is
        // caught process-wide, but only until connect() settles: left installed,
        // the handler would swallow every later crash in the host process.
        await new Promise((resolve, reject) => {
            let opened = false;
            let retries = 0;
            const maxRetries = 5;
            const onStreamError = (err) => {
                const code = err?.output?.statusCode ?? err?.data?.attrs?.code;
                if ((code === 515 || code === "515") && retries < maxRetries) {
                    retries += 1;
                    setTimeout(connectSocket, 1500);
                }
                else {
                    rejectOpen(err);
                }
            };
            const settle = () => process.off("uncaughtException", onStreamError);
            const resolveOpen = () => { settle(); resolve(); };
            const rejectOpen = (err) => { settle(); reject(err); };
            process.on("uncaughtException", onStreamError);
            const connectSocket = () => {
                this.#sock = createSocket();
                this.#sock.ev.on("creds.update", saveCreds);
                this.#sock.ev.on("connection.update", (update) => {
                    if (update.qr) {
                        this.emit("qr", update.qr);
                        void import("qrcode-terminal")
                            .then((qrt) => (qrt.default ?? qrt).generate(update.qr, { small: true }))
                            .catch(() => {
                            console.log("Scan this QR code in WhatsApp > Linked Devices:");
                            console.log(update.qr);
                        });
                    }
                    if (update.connection === "open") {
                        opened = true;
                        resolveOpen();
                        return;
                    }
                    if (update.connection === "close" && opened) {
                        this.emit("disconnected", update.lastDisconnect?.error);
                        return;
                    }
                    if (update.connection === "close" && !opened) {
                        const statusCode = update.lastDisconnect?.error?.output?.statusCode;
                        const shouldReconnect = statusCode === 515 || statusCode === DisconnectReason?.restartRequired;
                        if (shouldReconnect && retries < maxRetries) {
                            retries += 1;
                            setTimeout(connectSocket, 1000);
                        }
                        else {
                            rejectOpen(update.lastDisconnect?.error ?? new Error("socket closed before open"));
                        }
                    }
                });
            };
            connectSocket();
        });
        this.#signaling = new SignalingBridge({ sock: this.#sock });
        await this.#signaling.init();
        this.#relay = new RelayRtcTransport({
            onTransportMessage: (data, ip, port) => this.#engine?.handleOnTransportMessage(data, ip, port),
            onIceRtt: (rttMs, ip, port) => this.#engine?.updateIceRtt(rttMs, ip, port),
        });
        this.#engine = new WasmEngine({
            callbacks: {
                onSignalingXmpp: (peerJid, callId, xmlPayload) => this.#signaling.sendSignaling(peerJid, callId, xmlPayload),
                onCallEvent: (eventType, eventData) => this.#handleCallEvent(eventType, eventData),
                sendDataToRelay: (data, ip, port) => this.#relay.send(data, ip, port),
                onAudioCaptureInit: (config) => this.#handleAudioCaptureInit(config),
                onAudioCaptureStart: () => this.#handleAudioCaptureStart(),
                onAudioCaptureStop: () => this.#handleAudioCaptureStop(),
                onAudioPlaybackData: (audioData) => this.#activeCall?._emitAudio(audioData),
                cryptoHkdf: computeHkdf,
                hmacSha256: computeHmacSha256,
            },
        });
        await this.#engine.initialize();
        this.#signaling.attachEngine(this.#engine);
        const selfPnJid = this.#sock.authState.creds.me?.id;
        const selfLidJid = this.#sock.authState.creds.me?.lid;
        this.#engine.initVoipStack(selfPnJid, toBareJid(selfPnJid), selfLidJid);
        await this.#engine.waitForVoipStackReady();
        try {
            this.#engine.updateNetworkMedium(2, 0);
        }
        catch { }
        this.#sock.ws.on("CB:call", (node) => {
            this.#trackIncomingOffer(node);
            this.#signaling.processIncomingCall(node, this.#engine, this.#activeCall?.callId ?? "");
        });
        this.#sock.ws.on("CB:receipt", (node) => {
            if (!isCallReceiptNode(node))
                return;
            this.#signaling.processIncomingReceipt(node, this.#engine, this.#activeCall?.callId ?? "");
        });
    };
    /** Place an outbound voice call. */
    call = async (phoneNumber, opts = {}) => {
        if (!this.#engine || !this.#signaling)
            throw new Error("Not connected. Call connect() first.");
        if (this.#activeCall)
            throw new Error("A call is already active.");
        const targetNumber = phoneNumber.replace(/\D/g, "");
        const targetPnJid = `${targetNumber}@s.whatsapp.net`;
        const durationMs = opts.durationMs ?? 120_000;
        const audioSource = opts.audioSource ?? "silence";
        const peerLid = await this.#signaling.resolveLid(targetPnJid);
        if (!peerLid)
            throw new Error(`Could not resolve LID for ${targetPnJid}`);
        for (const jid of [targetPnJid, peerLid]) {
            try {
                await this.#sock.presenceSubscribe(jid);
            }
            catch { }
        }
        await new Promise((r) => setTimeout(r, 750));
        const peerDeviceJids = await this.#signaling.discoverPeerDevices(peerLid);
        const deviceList = peerDeviceJids.length ? peerDeviceJids : [toBareJid(peerLid)];
        await this.#signaling.ensureSessionsForPeers(deviceList);
        await new Promise((r) => setTimeout(r, 500));
        await this.#signaling.issueTcToken(peerLid);
        const tcToken = await this.#signaling.ensureTcToken(peerLid, targetPnJid);
        const callId = ("00" + randomBytes(16).toString("hex").slice(2)).toUpperCase();
        const call = new ActiveCall(callId, this.#engine, this.#uplink, "outgoing");
        call._audioSource = audioSource;
        call._limitDuration(durationMs);
        this.#adopt(call);
        this.#engine.startCall({
            peerJid: peerLid,
            peerPn: targetPnJid,
            peerList: deviceList,
            callId,
            isVideo: false,
            isLidCall: true,
            isFromDialer: false,
            extraData: tcToken,
        });
        return call;
    };
    /** Tear down the WhatsApp socket and release resources. */
    disconnect = () => {
        this.#activeCall?._forceEnd("disconnect");
        this.#activeCall = null;
        this.#relay?.closeAll();
        this.#engine?.destroy();
        this.#sock?.end?.();
        this.#engine = null;
        this.#relay = null;
        this.#signaling = null;
        this.#sock = null;
    };
    // ─── private ──────────────────────────────────────────────────────────────
    /**
     * Register an incoming offer as the active call before the signaling bridge
     * feeds it to WASM, so the ReceivedCall state change has a call to land on.
     * Offline offers are calls that rang while we were disconnected; a second
     * offer during a call is left ringing on the user's other devices.
     */
    #trackIncomingOffer = (node) => {
        const offer = Array.isArray(node?.content) ? node.content[0] : null;
        if (offer?.tag !== "offer" || node.attrs?.offline)
            return;
        const callId = String(offer.attrs?.["call-id"] ?? "");
        if (!callId || this.#activeCall || !this.#engine)
            return;
        const isVideo = Array.isArray(offer.content) && offer.content.some((child) => child?.tag === "video");
        const call = new ActiveCall(callId, this.#engine, this.#uplink, "incoming", {
            jid: String(node.attrs.from ?? offer.attrs["call-creator"] ?? ""),
            phoneNumber: String(offer.attrs.caller_pn ?? "").split("@")[0].split(":")[0] || undefined,
            isVideo,
        });
        this.#adopt(call);
        this.emit("call", call);
    };
    #adopt = (call) => {
        this.#activeCall = call;
        call.once("ended", () => {
            if (this.#activeCall !== call)
                return;
            this.#activeCall = null;
            this.#earlyUplink = [];
        });
    };
    #handleCallEvent = (eventType, eventData) => {
        if (eventType === 16 && eventData) {
            try {
                const parsed = JSON.parse(eventData);
                const info = parsed.call_info ?? parsed.callInfo ?? {};
                const callState = Number(info.call_state ?? info.callState ?? 0);
                this.#activeCall?._updateState(callState);
            }
            catch { }
        }
        else if (eventType === 156 && eventData) {
            try {
                const update = JSON.parse(eventData);
                this.#relay?.updateRelayList(update);
            }
            catch { }
        }
    };
    #handleAudioCaptureInit = (config) => {
        if (!this.#engine)
            return;
        this.#captureSampleRate = config.sampleRate || 16000;
        this.#captureChannels = config.channels || 1;
        this.#captureFramesPerChunk = config.framesPerChunk || 320;
        const chunkSamples = this.#captureFramesPerChunk * this.#captureChannels;
        this.#captureChunkBytes = chunkSamples * Float32Array.BYTES_PER_ELEMENT;
        this.#capturePtr = this.#engine.malloc(this.#captureChunkBytes);
    };
    #handleAudioCaptureStart = () => {
        if (!this.#engine || !this.#capturePtr)
            return;
        const audioSource = this.#activeCall?._audioSource ?? "silence";
        this.#feeder = new AudioFeeder(this.#captureSampleRate, this.#captureChannels, this.#captureFramesPerChunk, (chunk) => {
            if (this.#engine && this.#capturePtr)
                this.#engine.sendAudioData(chunk, this.#capturePtr);
        }, audioSource);
        this.#feeder.start();
        if (this.#feeder.isLive)
            this.#earlyUplink.forEach((pcm) => this.#feeder.push(pcm));
        this.#earlyUplink = [];
    };
    #handleAudioCaptureStop = () => {
        this.#feeder?.stop();
        this.#feeder = null;
        if (this.#engine && this.#capturePtr) {
            try {
                this.#engine.free(this.#capturePtr);
            }
            catch { }
            this.#capturePtr = 0;
        }
    };
}
