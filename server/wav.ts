/**
 * WAV header inspection for FR-19. We validate rather than trust: a client that
 * silently sends 48 kHz stereo produces plausible-looking but meaningless
 * scores, which is exactly the failure mode this POC exists to eliminate.
 */

import { AppError } from "./errors.js";

export interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataBytes: number;
  seconds: number;
}

const FORMAT_PCM = 1;

export function inspectWav(buf: Buffer): WavInfo {
  const bad = (message: string): never => {
    throw new AppError({
      code: "BAD_AUDIO_FORMAT",
      domain: "client",
      message,
      userMessage: "That recording could not be read. Please try again.",
    });
  };

  if (buf.length < 12) bad("file too short to be a WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF") bad("missing RIFF header");
  if (buf.toString("ascii", 8, 12) !== "WAVE") bad("not a WAVE file");

  let offset = 12;
  let fmt: Omit<WavInfo, "dataBytes" | "seconds"> | null = null;
  let dataBytes: number | null = null;

  // fmt is not always immediately followed by data — walk the chunk list.
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (id === "fmt " && body + 16 <= buf.length) {
      fmt = {
        audioFormat: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      // Streamed encoders sometimes write 0 or 0xFFFFFFFF; fall back to the
      // real remaining length so duration stays truthful.
      const remaining = buf.length - body;
      dataBytes = size === 0 || size > remaining ? remaining : size;
    }

    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (!fmt) bad("no fmt chunk");
  if (dataBytes === null) bad("no data chunk");

  const f = fmt as Omit<WavInfo, "dataBytes" | "seconds">;
  const d = dataBytes as number;

  const bytesPerFrame = (f.bitsPerSample / 8) * f.channels;
  if (bytesPerFrame <= 0) bad("degenerate frame size");

  return { ...f, dataBytes: d, seconds: d / (f.sampleRate * bytesPerFrame) };
}

/** R7: 16 kHz mono 16-bit PCM, non-negotiable — it is what Azure prescribes. */
export function assertAzureFormat(info: WavInfo): void {
  const problems: string[] = [];
  if (info.audioFormat !== FORMAT_PCM) problems.push(`encoding is not PCM (${info.audioFormat})`);
  if (info.sampleRate !== 16000) problems.push(`${info.sampleRate} Hz, expected 16000`);
  if (info.channels !== 1) problems.push(`${info.channels} channels, expected mono`);
  if (info.bitsPerSample !== 16) problems.push(`${info.bitsPerSample}-bit, expected 16-bit`);

  if (problems.length) {
    throw new AppError({
      code: "BAD_AUDIO_FORMAT",
      domain: "client",
      message: `audio is not 16 kHz mono PCM16: ${problems.join("; ")}`,
      userMessage: "That recording was in an unexpected format. Please try again.",
    });
  }
}

export function assertDuration(info: WavInfo, minSeconds: number, maxSeconds: number): void {
  if (info.seconds < minSeconds) {
    throw new AppError({
      code: "AUDIO_TOO_SHORT",
      domain: "client",
      message: `duration ${info.seconds.toFixed(2)}s below minimum ${minSeconds}s`,
      userMessage: "That was too short to score. Hold the button and say the whole phrase.",
    });
  }
  if (info.seconds > maxSeconds) {
    throw new AppError({
      code: "AUDIO_TOO_LONG",
      domain: "client",
      message: `duration ${info.seconds.toFixed(2)}s above maximum ${maxSeconds}s`,
      userMessage: "That recording was too long. Try just the phrase on its own.",
    });
  }
}
