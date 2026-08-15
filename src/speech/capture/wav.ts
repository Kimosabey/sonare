/**
 * T6 — Float32 → 16-bit PCM WAV container.
 *
 * R7: 16 kHz mono 16-bit PCM. Azure's prescribed format, and it keeps web and
 * native captures byte-comparable — which is the entire point of a fixture that
 * compares platforms.
 */

const WAV_HEADER_BYTES = 44;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const FORMAT_PCM = 1;

export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const pcm = toInt16(samples);
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcm.length * 2);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  const byteRate = sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, FORMAT_PCM, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeAscii(36, "data");
  view.setUint32(40, pcm.length * 2, true);

  new Int16Array(buffer, WAV_HEADER_BYTES).set(pcm);

  return new Blob([buffer], { type: "audio/wav" });
}

function toInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    // Clamp before scaling; a sample above 1.0 would otherwise wrap to the
    // opposite polarity and read as a click.
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}
