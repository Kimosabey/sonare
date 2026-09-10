/**
 * Typed errors. CLAUDE.md: never bare strings — failure attribution depends on
 * knowing whether the client, the network, our server, the vendor, or the
 * model is at fault. That distinction is the point of the POC.
 */

export type ErrorDomain = "client" | "network" | "server" | "provider" | "model";

export type ServerErrorCode =
  | "MISSING_AUDIO"
  | "MISSING_REFERENCE_TEXT"
  | "BAD_CONTENT_TYPE"
  | "BAD_AUDIO_FORMAT"
  | "AUDIO_TOO_SHORT"
  | "AUDIO_TOO_LONG"
  | "INVALID_REQUEST"
  | "UNAUTHENTICATED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_REJECTED"
  | "MISCONFIGURED";

export interface TypedError {
  code: ServerErrorCode;
  domain: ErrorDomain;
  message: string;
  /** Safe to show a user. Never contains provider internals or credentials. */
  userMessage: string;
}

export class AppError extends Error implements TypedError {
  readonly code: ServerErrorCode;
  readonly domain: ErrorDomain;
  readonly userMessage: string;
  readonly status: number;
  /**
   * True when the failure happened *before* anything reached the provider, so
   * nothing was spent and no paid call was made.
   *
   * Narrow on purpose. `PROVIDER_UNAVAILABLE` is raised from a dozen places,
   * several of them after a real request has already been paid for, so the
   * code alone cannot answer "was this billable?" — and the one caller that
   * needs the answer is returning money. Set it only where you can see that
   * no request left the machine.
   *
   * Absent means "assume it was spent", which is the safe default for a
   * spend ceiling: it over-counts rather than handing out an allowance twice.
   */
  readonly providerNotCalled: boolean;

  constructor(init: TypedError & { status?: number; providerNotCalled?: boolean }) {
    super(init.message);
    this.name = "AppError";
    this.code = init.code;
    this.domain = init.domain;
    this.userMessage = init.userMessage;
    this.status = init.status ?? (init.domain === "client" ? 400 : 502);
    this.providerNotCalled = init.providerNotCalled ?? false;
  }

  toJSON(): TypedError {
    return {
      code: this.code,
      domain: this.domain,
      // `this.message` is for server-side logs only — it can carry a raw
      // provider/SDK string (see azureSpeech.ts's PROVIDER_REJECTED). The
      // wire contract keeps a `message` field for shape-compatibility with
      // existing clients, but its value is always the already-sanitized
      // userMessage — never the internal one.
      message: this.userMessage,
      userMessage: this.userMessage,
    };
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
