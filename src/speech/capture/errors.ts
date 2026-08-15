/**
 * T7 — typed capture errors. CLAUDE.md: never bare strings. Every code carries
 * text that tells the user what to actually do, because "recording failed" is
 * the message that generated the support tickets this POC is replacing.
 */

export type ErrorDomain = "client" | "network" | "server" | "provider" | "model";

export type CaptureErrorCode =
  | "GESTURE_REQUIRED"
  | "UNSUPPORTED_BROWSER"
  | "PERMISSION_DENIED"
  | "PERMISSION_DISMISSED"
  | "NO_MICROPHONE"
  | "DEVICE_LOST"
  | "CONTEXT_SUSPENDED"
  | "NO_AUDIO_ENERGY"
  | "TOO_SHORT"
  | "TOO_LONG"
  | "SNR_TOO_LOW"
  | "INSECURE_CONTEXT";

export class CaptureError extends Error {
  readonly code: CaptureErrorCode;
  readonly domain: ErrorDomain;
  readonly userMessage: string;

  constructor(code: CaptureErrorCode, domain: ErrorDomain, message: string, userMessage: string) {
    super(message);
    this.name = "CaptureError";
    this.code = code;
    this.domain = domain;
    this.userMessage = userMessage;
  }
}

const USER_TEXT: Record<CaptureErrorCode, string> = {
  GESTURE_REQUIRED: "Tap the record button to start.",
  UNSUPPORTED_BROWSER: "This browser can't record audio. Try Safari on iPhone, or Chrome elsewhere.",
  PERMISSION_DENIED:
    "Microphone access is blocked. Allow it in your browser's site settings, then try again.",
  PERMISSION_DISMISSED: "The microphone prompt was dismissed. Tap record and choose Allow.",
  NO_MICROPHONE: "No microphone was found. Connect one and try again.",
  DEVICE_LOST: "The microphone disconnected. Check it's still connected, then try again.",
  CONTEXT_SUSPENDED: "Audio was interrupted — a call or another app may have taken the microphone. Tap record to try again.",
  NO_AUDIO_ENERGY: "We're not hearing anything. Check the microphone isn't muted, then try again.",
  TOO_SHORT: "That was too short. Hold on and say the whole phrase.",
  TOO_LONG: "That was too long. Try saying just the phrase on its own.",
  SNR_TOO_LOW: "It's too noisy to score fairly. Move somewhere quieter and try again.",
  INSECURE_CONTEXT: "Recording needs a secure connection (HTTPS).",
};

export function captureError(code: CaptureErrorCode, detail: string, domain: ErrorDomain = "client"): CaptureError {
  return new CaptureError(code, domain, detail, USER_TEXT[code]);
}

/**
 * getUserMedia rejections are DOMExceptions whose meaning lives in `name`.
 * NotAllowedError covers both an explicit block and a dismissed prompt; the
 * distinction matters because the advice differs, and only the timing tells
 * them apart.
 */
export function fromGetUserMediaError(err: unknown, promptWasFast: boolean): CaptureError {
  const name = err instanceof DOMException || err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);

  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return captureError(promptWasFast ? "PERMISSION_DENIED" : "PERMISSION_DISMISSED", detail);
    case "NotFoundError":
    case "OverconstrainedError":
      return captureError("NO_MICROPHONE", detail);
    case "NotReadableError":
    case "AbortError":
      return captureError("DEVICE_LOST", detail);
    default:
      return captureError("UNSUPPORTED_BROWSER", detail || name || "getUserMedia failed");
  }
}
