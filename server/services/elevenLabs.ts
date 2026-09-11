/**
 * The model voice a learner imitates — a native-quality recording of our own
 * reference text, synthesised once and cached.
 *
 * ## Why this exists
 *
 * The model voice today is the browser's own synthesiser
 * (src/hooks/useModelSpeech.ts), and it fails in three documented ways.
 *
 *  1. **It is absent on the device that needs it most.** `pickVoice` returns
 *     null when the platform ships no voice for the locale, `available` goes
 *     false, and the Listen control *hides*. A device with no `hi-IN` voice
 *     gives a Hindi learner no model voice at all, in an app whose subject is
 *     Hindi pronunciation.
 *  2. **The word highlight rides `boundary` events**, which several engines
 *     never fire; the phrase then plays unmarked. This provider returns
 *     character-level alignment with the audio, which is data rather than an
 *     event and therefore works everywhere.
 *  3. **Quality varies per device.** "Hear yours, then mine" compares the
 *     learner against whatever voice their laptop shipped with, which is not a
 *     standard and not a native speaker. useModelSpeech's own header concedes
 *     the point: "a synthetic voice is not a native speaker. For a
 *     pronunciation model that gap is real."
 *
 * ## The shape of this file
 *
 * The ONLY file that knows ElevenLabs exists, deliberately mirroring the R12
 * stance `azureSpeech.ts` takes for the scorer: everything above this line
 * sees `synthesise()`, `Synthesis` and `CharacterAlignment`, and nothing else.
 * Swapping provider is a file, not a refactor.
 *
 * Plain `fetch` and no SDK — there is one endpoint, one header and one JSON
 * body, and a dependency to spell that is a dependency to audit.
 *
 * **It fails closed, and it never throws at a caller.** No key, a non-2xx, a
 * timeout, a body that does not parse, or a language the chosen model does not
 * declare all return `null` after one log line. The caller's fallback is the
 * platform voice the app already had, so a failure here costs quality, never
 * function.
 *
 * ## Privacy
 *
 * This sends **our reference text** outbound and nothing else. Learner audio
 * never reaches this file, and no path here accepts any: adding one would make
 * ElevenLabs a second processor of learner voice recordings, for which there
 * is no paperwork. The only outbound payload is a phrase we wrote and already
 * serve publicly from `GET /api/v1/content/:slug`.
 */

import { z } from "zod";
import { logger } from "../logger.js";

/**
 * The key.
 *
 * Read under one spelling now. It briefly accepted `ElevenLabs_API_KEY` as
 * well, because that mixed-case name is how the variable first arrived in
 * `.env` — and `process.env` is case-sensitive, so reading only the
 * conventional name would have left the feature silently off with a key
 * present, which looks exactly like a provider outage. `.env` has since been
 * renamed to `ELEVENLABS_API_KEY`, matching every other name in that file, so
 * the fallback is gone rather than left to rot as a spelling nothing uses.
 */
export function apiKey(): string | undefined {
  const key = process.env.ELEVENLABS_API_KEY;
  return key === undefined || key.trim() === "" ? undefined : key.trim();
}

/**
 * What each model *declares* it can speak, and the trap that makes this list
 * load-bearing rather than decorative.
 *
 * `eleven_flash_v2_5` returned **HTTP 200 for Kannada text it does not
 * declare** — it synthesised something, and what it synthesised was a
 * mispronunciation. A status code is therefore not evidence that a model
 * speaks a language, and this is the only place that answers the question.
 * Verified against `GET /v1/models` on 2026-09-09.
 *
 * The lists below are the **subset relevant to this product**: the four
 * locales Sonare ships (fr/es/de/hi) plus Kannada, which is the language that
 * forces the model choice, plus English for the diagnostics screens.
 * `declaredTotal` records how many languages each model declares in full, so
 * the subset cannot be mistaken for the whole catalogue.
 *
 * **A language absent from a model's list fails closed**, even one the model
 * may in fact support. That direction is deliberate: the cost of refusing is
 * the platform voice we already had, and the cost of guessing wrong is a
 * learner imitating a mispronunciation of the language they are being scored
 * on. Extend a list from `GET /v1/models`, never from a successful call.
 */
interface ModelSpec {
  /** ISO 639-1 codes this model declares, restricted to the ones we can ask for. */
  readonly languages: readonly string[];
  /** How many languages the model declares in total, per the live catalogue. */
  readonly declaredTotal: number;
  /**
   * Whether the endpoint accepts `language_code` for this model. Sent only
   * where it is accepted: an unsupported parameter is a 400, which under this
   * file's fail-closed posture would silently cost the whole feature.
   */
  readonly acceptsLanguageCode: boolean;
}

const MODELS: Readonly<Record<string, ModelSpec>> = {
  // The only model that declares Kannada, which is why it is the default.
  eleven_v3: { languages: ["en", "fr", "es", "de", "hi", "kn"], declaredTotal: 74, acceptsLanguageCode: false },
  eleven_multilingual_v2: { languages: ["en", "fr", "es", "de", "hi"], declaredTotal: 29, acceptsLanguageCode: false },
  eleven_flash_v2_5: { languages: ["en", "fr", "es", "de", "hi"], declaredTotal: 32, acceptsLanguageCode: true },
  eleven_turbo_v2_5: { languages: ["en", "fr", "es", "de", "hi"], declaredTotal: 32, acceptsLanguageCode: true },
  // English-only. Present so that choosing one is a refusal rather than a
  // mispronounced French phrase.
  eleven_turbo_v2: { languages: ["en"], declaredTotal: 1, acceptsLanguageCode: false },
  eleven_flash_v2: { languages: ["en"], declaredTotal: 1, acceptsLanguageCode: false },
};

/**
 * Kannada forces this. `eleven_multilingual_v2`, `eleven_flash_v2_5` and
 * `eleven_turbo_v2_5` all cover fr/es/de/hi and none of them declares `kn`, so
 * defaulting to any of those would mean the model has to change the day a
 * Kannada set is published — and the failure would be an HTTP 200 carrying a
 * wrong pronunciation rather than an error.
 */
export const DEFAULT_MODEL_ID = "eleven_v3";

/**
 * ElevenLabs' documented sample voice ("Rachel").
 *
 * The last resort, and deliberately an obvious one.
 *
 * Reached only for a language with no voice chosen for it. It is an
 * English-first voice, so `eleven_v3` will speak other languages with an
 * English speaker's accent — which is why `synthesise` refuses rather than
 * uses it for a language absent from OWNER_VOICE_IDS. A voice is the accent a
 * learner will imitate, and that is precisely the variable this product
 * measures; guessing one is worse than having none.
 */
export const PLACEHOLDER_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/**
 * The voices the owner picked, per language.
 *
 * Supplied by the account holder on 9 Sep 2026, from their own ElevenLabs
 * library — not chosen here. A voice is the accent a learner will imitate, so
 * this is a judgement about the language, made by someone who speaks it.
 * `ELEVENLABS_VOICE_IDS` still overrides any of them without a code edit.
 *
 * **`hi-IN` is deliberately absent.** No Hindi voice was supplied, and no
 * other entry here is a substitute — Aisiri is Kannada, and a Kannada voice
 * reading Devanagari is a different language, not an accent. So Hindi falls
 * back to the platform synthesiser, exactly as it does today. That is the
 * honest outcome and it is also the gap worth closing first, because Hindi is
 * the language where the platform is most often missing a voice altogether.
 *
 * An alternative French male voice, Sebastien (`BUJMBsQ3Oq4cEeWSb48y`), was
 * also supplied; set `ELEVENLABS_VOICE_IDS=fr-FR:BUJMBsQ3Oq4cEeWSb48y` to use
 * it rather than editing this table.
 */
export const OWNER_VOICE_IDS: Readonly<Record<string, string>> = {
  "fr-FR": "vTGV06pygfwa2WhLDZFp", // French Darling
  "es-ES": "tXgbXPnsMpKXkuTgvE3h", // Spanish Voice
  "de-DE": "rKiu7lQ4c5P3az3745s3", // Benjamin
  "en-US": "jB2lPb5DhAX6l1TLkKXy", // Sophia — the fixture runner's locale
  "kn-IN": "2SDH0owxS12R2YMgMNoG", // Aisiri, friendly Kannada
};

/** ISO 639-1 base of a BCP-47 locale: "hi-IN" -> "hi". */
function baseLanguage(locale: string): string {
  const lower = locale.trim().toLowerCase();
  return lower.split("-")[0] ?? lower;
}

/**
 * The model in force. `ELEVENLABS_MODEL_ID` overrides the default; an unknown
 * name falls back loudly rather than being sent to the API, because an
 * unknown model has no declared language list and so cannot be guarded.
 */
export function modelId(): string {
  const raw = process.env.ELEVENLABS_MODEL_ID?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MODEL_ID;
  if (MODELS[raw] === undefined) {
    logger.warn(
      { setting: "ELEVENLABS_MODEL_ID", provided: raw, using: DEFAULT_MODEL_ID },
      "[elevenLabs] unknown model id — its declared languages are unknown, so it cannot be guarded. Falling back.",
    );
    return DEFAULT_MODEL_ID;
  }
  return raw;
}

/**
 * The voice for one locale — configuration, never a decision baked in here.
 *
 * `ELEVENLABS_VOICE_IDS` is a comma-separated map of locale to voice id, and
 * either a full locale or a bare language matches:
 *
 *     ELEVENLABS_VOICE_IDS=fr-FR:XrExE9yK...,hi:pNInz9ob...
 *
 * `ELEVENLABS_VOICE_ID` sets one voice for every language, and with neither
 * set the placeholder above applies. A malformed entry is skipped with a
 * warning rather than failing the run: one bad pair must not cost the other
 * three languages their voice.
 */
export function voiceIdFor(locale: string): string {
  const raw = process.env.ELEVENLABS_VOICE_IDS?.trim() ?? "";
  const wanted = locale.trim().toLowerCase();
  const base = baseLanguage(locale);

  const byLocale = new Map<string, string>();
  for (const pair of raw.split(",")) {
    if (pair.trim() === "") continue;
    const [key, value] = pair.split(":");
    if (key === undefined || value === undefined || key.trim() === "" || value.trim() === "") {
      logger.warn(
        { setting: "ELEVENLABS_VOICE_IDS", entry: pair.trim() },
        "[elevenLabs] ignoring a malformed voice mapping — expected locale:voiceId",
      );
      continue;
    }
    byLocale.set(key.trim().toLowerCase(), value.trim());
  }

  const owner =
    OWNER_VOICE_IDS[wanted] ??
    Object.entries(OWNER_VOICE_IDS).find(([k]) => baseLanguage(k) === base)?.[1];

  /**
   * Precedence, and the reason for it: a per-locale env entry is the most
   * specific statement of intent, then a global env override, then the
   * owner's table, then the placeholder.
   *
   * The global `ELEVENLABS_VOICE_ID` deliberately beats OWNER_VOICE_IDS.
   * It means "one voice for every language", and a setting that silently
   * loses to a table in the source is a setting that looks broken — the
   * worse failure of the two, because nothing reports it.
   */
  return (
    byLocale.get(wanted) ??
    byLocale.get(base) ??
    (process.env.ELEVENLABS_VOICE_ID?.trim() || undefined) ??
    owner ??
    PLACEHOLDER_VOICE_ID
  );
}

/**
 * Whether a voice was actually *chosen* for this locale, as opposed to being
 * the English placeholder standing in.
 *
 * Kept separate from `voiceIdFor` so a caller can decline rather than
 * synthesise a language in the wrong accent. The placeholder resolves so that
 * a deliberate `ELEVENLABS_VOICE_ID` still works for a one-off; it must not
 * become the accent a whole language is taught in.
 */
export function hasChosenVoice(locale: string): boolean {
  return voiceIdFor(locale) !== PLACEHOLDER_VOICE_ID;
}

/** Whether `model` declares `locale`'s language. The only authority on this. */
export function declaresLanguage(model: string, locale: string): boolean {
  const spec = MODELS[model];
  if (spec === undefined) return false;
  return spec.languages.includes(baseLanguage(locale));
}

/** How many languages a model declares in total, or null for an unknown model. */
export function declaredLanguageCount(model: string): number | null {
  return MODELS[model]?.declaredTotal ?? null;
}

/**
 * Generous, because nothing is waiting on it.
 *
 * This runs at generation time — a script, or a publish — not on a learner's
 * request, so the tradeoff `azureSpeech.ts` makes (8s, because a learner is
 * watching a spinner) does not apply. Long enough that a slow generation of a
 * fourteen-word phrase completes, short enough that a hung connection does not
 * stall a forty-phrase run indefinitely.
 */
export const SYNTHESIS_TIMEOUT_MS = 30_000;

const API_BASE = "https://api.elevenlabs.io/v1";

/**
 * mp3 at 44.1 kHz / 128 kbps — the endpoint's own default, stated explicitly
 * so the cached bytes do not change shape if that default ever moves. mp3
 * plays in every browser the app supports; the higher-fidelity formats are
 * larger for a difference nobody imitating a phrase can hear.
 */
const OUTPUT_FORMAT = "mp3_44100_128";

/** What the cache stores and what `<audio>` is told it is receiving. */
export const AUDIO_CONTENT_TYPE = "audio/mpeg";
export const AUDIO_EXTENSION = "mp3";

/**
 * Where each character of the phrase falls in the audio.
 *
 * This is the data that replaces `boundary` events. It arrives *with* the
 * audio rather than being emitted during playback, so it cannot be the thing
 * an engine declines to provide — which was failure (2) above.
 *
 * Kept per character rather than collapsed to words here on purpose: the word
 * numbering has to match `phraseTokens`, and that function belongs to the
 * client, which draws the words. Collapsing on the server would put two
 * definitions of "word 3" in the product and make a silently-off-by-one
 * highlight possible. See src/modelVoice/manifest.ts.
 */
export interface CharacterAlignment {
  characters: string[];
  startSeconds: number[];
  endSeconds: number[];
}

export interface Synthesis {
  audio: Buffer;
  alignment: CharacterAlignment;
  /** Echoed back so the cache can key on what actually produced these bytes. */
  voiceId: string;
  modelId: string;
}

export interface SynthesisRequest {
  /** Our reference text. Never learner audio, and never learner-supplied text. */
  text: string;
  /** BCP-47, e.g. "hi-IN" — matched against the model's declared languages. */
  language: string;
  voiceId?: string;
  modelId?: string;
  /** Injected in tests. Defaults to the global; tests must never reach the API. */
  fetchImpl?: typeof fetch;
}

/**
 * The provider's body, validated at the trust boundary rather than cast —
 * the same stance `azureSpeech.ts` takes for `JSON.parse(result.json)`.
 *
 * `z.looseObject` so fields we do not model cannot fail the parse; only a
 * field we depend on being the wrong type should. `normalized_alignment` is
 * deliberately not read: it describes the *normalised* text (numbers expanded,
 * punctuation rewritten), which no longer indexes the phrase on screen.
 */
const AlignmentSchema = z.looseObject({
  characters: z.array(z.string()),
  character_start_times_seconds: z.array(z.number()),
  character_end_times_seconds: z.array(z.number()),
});

const ResponseSchema = z.looseObject({
  audio_base64: z.string().min(1),
  alignment: AlignmentSchema,
});

/**
 * One phrase, synthesised — or `null`, having said why exactly once.
 *
 * Never throws. Every caller's fallback is the platform voice the app already
 * shipped with, so the only correct behaviour on any failure is to hand back
 * nothing and let that fallback happen.
 */
export async function synthesise(request: SynthesisRequest): Promise<Synthesis | null> {
  const text = request.text.trim();
  const model = request.modelId ?? modelId();
  const voice = request.voiceId ?? voiceIdFor(request.language);
  const doFetch = request.fetchImpl ?? fetch;

  if (text === "") {
    logger.warn("[elevenLabs] refusing to synthesise an empty phrase");
    return null;
  }

  /**
   * The declared-language guard, ahead of the request rather than after it.
   *
   * This is the check the verified trap demands: `eleven_flash_v2_5` answers
   * 200 for Kannada and mispronounces it, so a response cannot be inspected to
   * find out whether the model should have been asked. Refusing before
   * spending is also the only version that saves the money.
   */
  if (!declaresLanguage(model, request.language)) {
    logger.warn(
      { model, language: request.language, declaredTotal: declaredLanguageCount(model) },
      "[elevenLabs] the chosen model does not declare this language — refusing. A 200 here would be a mispronunciation, not a success.",
    );
    return null;
  }

  /**
   * No chosen voice means no synthesis — the sibling of the guard above.
   *
   * `declaresLanguage` stops the wrong *model*; this stops the wrong *voice*.
   * Without it a language absent from OWNER_VOICE_IDS silently reaches the
   * English placeholder, and `eleven_v3` will read Devanagari or Kannada
   * script in an English speaker's accent — cheerfully, at 200, with valid
   * character timings. That is worse than having no served audio at all,
   * because the platform synthesiser at least reaches for the right language,
   * and because a learner imitates the accent they are given. The accent is
   * the variable this product exists to measure.
   *
   * Caught by a dry run showing `hi-IN -> 21m00Tcm4TlvDq8ikWAM`. An earlier
   * version of this file *claimed* in a comment that synthesis refused here
   * and only shipped the `hasChosenVoice` predicate, which is the more
   * embarrassing half: the guard was documented, agreed with, and absent.
   *
   * Keyed on the **effective** voice, not on whether a caller passed one.
   *
   * The first version of this guard asked `request.voiceId === undefined`,
   * and it did not hold: `modelVoice/cache.ts` resolves `voiceIdFor()` itself
   * and passes the result along, so a default arrived looking exactly like a
   * deliberate choice and the guard stepped aside. Ten Hindi phrases were
   * generated in the placeholder's English accent before anything noticed —
   * one commit after a message claiming this was prevented.
   *
   * Asking about the resolved voice instead cannot be defeated by an
   * intermediate layer, which is the property that was actually wanted. A
   * caller who genuinely wants a specific voice names a specific voice; the
   * placeholder is by definition the absence of that.
   */
  if (voice === PLACEHOLDER_VOICE_ID) {
    logger.warn(
      { language: request.language, placeholder: PLACEHOLDER_VOICE_ID },
      "[elevenLabs] no voice chosen for this language — refusing rather than teaching it in the placeholder's accent. Set ELEVENLABS_VOICE_IDS or add it to OWNER_VOICE_IDS.",
    );
    return null;
  }

  const key = apiKey();
  if (key === undefined) {
    logger.warn(
      "[elevenLabs] no API key set (ELEVENLABS_API_KEY) — the model voice falls back to the platform synthesiser",
    );
    return null;
  }

  const spec = MODELS[model];
  const body: Record<string, string> = { text, model_id: model };
  if (spec?.acceptsLanguageCode === true) body["language_code"] = baseLanguage(request.language);

  /**
   * `AbortSignal.timeout` rather than a manual controller: one line, and it
   * cannot leak a timer the way a hand-rolled `setTimeout` race does when the
   * request settles first.
   */
  let response: Response;
  try {
    response = await doFetch(
      `${API_BASE}/text-to-speech/${encodeURIComponent(voice)}/with-timestamps?output_format=${OUTPUT_FORMAT}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      },
    );
  } catch (err) {
    // A timeout and a dropped connection arrive here the same way and want the
    // same answer. `String(err)` is a transport message, never the key.
    logger.warn(
      { model, voice, language: request.language, err: String(err) },
      "[elevenLabs] request failed or timed out — falling back to the platform voice",
    );
    return null;
  }

  if (!response.ok) {
    /**
     * Status reported, body not. A 401 (bad or scoped key) and a 429 (quota)
     * are the two an operator will actually meet, and both are answered by
     * looking at the status — while an error body from a paid API is the last
     * place a key or a quota figure should be copied into a log line.
     */
    logger.warn(
      { status: response.status, model, voice, language: request.language },
      "[elevenLabs] provider refused the request — falling back to the platform voice",
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (err) {
    logger.warn({ err: String(err) }, "[elevenLabs] provider response was not JSON");
    return null;
  }

  const validated = ResponseSchema.safeParse(parsed);
  if (!validated.success) {
    logger.warn(
      { issues: validated.error.issues },
      "[elevenLabs] provider response did not match the expected shape",
    );
    return null;
  }

  const raw = validated.data;
  const alignment: CharacterAlignment = {
    characters: raw.alignment.characters,
    startSeconds: raw.alignment.character_start_times_seconds,
    endSeconds: raw.alignment.character_end_times_seconds,
  };

  /**
   * Three arrays that index each other. A short one would silently mean the
   * last words of a phrase have no time, and the highlight would stop
   * mid-phrase and read as the voice having stopped.
   */
  if (
    alignment.characters.length === 0 ||
    alignment.startSeconds.length !== alignment.characters.length ||
    alignment.endSeconds.length !== alignment.characters.length
  ) {
    logger.warn(
      {
        characters: alignment.characters.length,
        starts: alignment.startSeconds.length,
        ends: alignment.endSeconds.length,
      },
      "[elevenLabs] alignment arrays do not agree in length — refusing the response",
    );
    return null;
  }

  /**
   * Not fatal, and deliberately so.
   *
   * The characters came back reproducing the phrase exactly in verification
   * (21 characters for a 21-character Kannada phrase), and the client checks
   * this again before trusting the alignment to place a highlight. If a
   * provider-side normalisation ever breaks the correspondence, the right
   * outcome is a native-quality recording that plays with no word marking —
   * not silence. So this is a warning here and a `null` word-time list there.
   */
  if (alignment.characters.join("") !== text) {
    logger.warn(
      { language: request.language, characters: alignment.characters.length, textLength: text.length },
      "[elevenLabs] alignment does not reproduce the phrase — the audio is usable, the word highlight will be skipped",
    );
  }

  /**
   * `Buffer.from(..., "base64")` does not throw on rubbish — it skips what it
   * cannot decode and can return an empty buffer. So the emptiness check
   * below is the actual guard, not a formality: it is what catches a body
   * whose `audio_base64` was a non-empty string of nothing usable.
   */
  const audio = Buffer.from(raw.audio_base64, "base64");
  if (audio.byteLength === 0) {
    logger.warn("[elevenLabs] provider returned no audio bytes");
    return null;
  }

  return { audio, alignment, voiceId: voice, modelId: model };
}
