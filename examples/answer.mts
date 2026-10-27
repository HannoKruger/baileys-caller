/**
 * Example: answer incoming voice calls and echo the caller back to themselves.
 * Hearing your own voice proves both audio directions work.
 *
 *   npx tsx examples/answer.mts <authDir> [allowedNumber]
 *
 *   authDir        Path to a Baileys multi-file auth state (default: ./auth)
 *   allowedNumber  Only answer this caller, digits only (default: anyone)
 */
import { VoipClient, type ActiveCall } from "../src/index.mjs";

const [, , authDir = "./auth", allowedNumber] = process.argv;
const ECHO_DELAY_MS = 500;

const client = new VoipClient({ authDir });

client.on("call", (call: ActiveCall) => {
  const caller = call.peer?.phoneNumber ?? call.peer?.jid ?? "unknown";
  if (call.peer?.isVideo || (allowedNumber && call.peer?.phoneNumber !== allowedNumber)) {
    console.log(`Ignoring call from ${caller}`);
    return;
  }
  console.log(`Answering ${caller}`);
  call.accept({ audioSource: "live", durationMs: 120_000 });
  call.on("connected", () => console.log("connected"));
  call.on("audio", (pcm: Float32Array) => {
    setTimeout(() => call.pushAudio(pcm), ECHO_DELAY_MS);
  });
  call.on("ended", (reason: string) => console.log(`ended: ${reason}`));
});

client.on("disconnected", () => process.exit(1));

await client.connect();
console.log("Waiting for calls.");
