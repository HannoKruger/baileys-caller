export declare const LIVE_SOURCE = "live";
export declare class AudioFeeder {
    #private;
    private readonly sampleRate;
    private readonly channels;
    private readonly framesPerChunk;
    private readonly onChunk;
    private readonly source;
    underflowChunks: number;
    samplesProduced: number;
    chunksEmitted: number;
    constructor(sampleRate: number, channels: number, framesPerChunk: number, onChunk: (chunk: Float32Array) => void, source?: string);
    get isLive(): boolean;
    start: () => void;
    stop: () => void;
    /** Queue live PCM for the uplink. Samples are interleaved at `sampleRate`. */
    push: (pcm: Float32Array) => void;
    /** Drop everything not yet sent, e.g. when the remote party interrupts. */
    flush: () => void;
    get queuedMs(): number;
}
