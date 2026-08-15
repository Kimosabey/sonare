/**
 * T5/FR-02 — AudioWorklet capture.
 *
 * Not MediaRecorder (it hands back encoded Opus/AAC, so the PCM we need has
 * already been through a lossy codec) and not ScriptProcessorNode (deprecated,
 * and it runs on the main thread where layout jank becomes dropped audio).
 *
 * The processor source is a string inlined as a Blob URL so there is no
 * separate asset to serve — which also means it survives being bundled,
 * proxied, or opened from a LAN address during iPhone testing.
 */

export const WORKLET_PROCESSOR_NAME = "lingotran-capture";

const WORKLET_SOURCE = `
class LingotranCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A copy is required: the render quantum buffer is reused by the engine.
    if (channel) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_PROCESSOR_NAME)}, LingotranCapture);
`;

let moduleUrl: string | null = null;

/** Registers the processor on the given context. Safe to call more than once. */
export async function addCaptureWorklet(context: AudioContext): Promise<void> {
  moduleUrl ??= URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
  await context.audioWorklet.addModule(moduleUrl);
}
