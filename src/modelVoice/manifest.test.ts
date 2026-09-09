/**
 * The client's half of the served model voice: what it will trust, and how it
 * turns character times into word times.
 *
 * The load-bearing test in this file is the one that proves the word numbering
 * agrees with `phraseTokens`. The provider gives a time per *character*; the
 * screen draws *words*, numbered by `phraseTokens`, and both the highlight and
 * the spans it lands on are derived from that numbering. Two definitions of
 * "word 3" would show as a highlight one word off — which teaches the learner
 * exactly the wrong sound-to-spelling mapping, and is invisible to any test
 * that does not compare the two. So the tests below feed real phrases through
 * the real tokenizer rather than hand-numbering anything.
 *
 * Everything else here is boundary posture. A manifest arrives over the
 * network and is a document a human can edit; every way it can be wrong has to
 * end in "no served audio for that phrase" rather than in a guess, because a
 * wrong time is a wrong highlight and there is no such thing as approximately
 * the right word.
 */

import { describe, expect, it } from "vitest";
import { phraseTokens } from "../hooks/useModelSpeech.js";
import { manifestUrl, readManifest, wordStartSeconds, type ServedPhrase } from "./manifest.js";

const KEY = "0123456789abcdef0123456789abcdef";

/** A manifest entry whose character times are one tenth of a second apart. */
function entry(text: string, over: Record<string, unknown> = {}) {
  const characters = [...text];
  return {
    phraseId: 1,
    text,
    audio: `${KEY}.mp3`,
    characters,
    startSeconds: characters.map((_, i) => i * 0.1),
    endSeconds: characters.map((_, i) => (i + 1) * 0.1),
    ...over,
  };
}

function body(language: string, phrases: unknown[]) {
  return { language, contentVersion: 1, voiceId: "v", modelId: "m", generatedAt: "", phrases };
}

/** A served phrase built from a text, for the word-time tests. */
function served(text: string, over: Partial<ServedPhrase> = {}): ServedPhrase {
  const characters = [...text];
  return {
    text,
    url: `/api/v1/model-voice/fr-FR/${KEY}.mp3`,
    characters,
    startSeconds: characters.map((_, i) => i * 0.1),
    endSeconds: characters.map((_, i) => (i + 1) * 0.1),
    ...over,
  };
}

describe("reading a manifest", () => {
  it("indexes phrases on their exact reference text", () => {
    // The text is the key because it is what `speak(text, lang)` is handed.
    // Anything else would need the phrase id to travel through the hook, and
    // the comparison feature calls `speak` with a bare word.
    const index = readManifest(body("fr-FR", [entry("Bonjour"), entry("Merci")]), "fr-FR");

    expect(index.size).toBe(2);
    expect(index.get("Bonjour")?.url).toContain(`${KEY}.mp3`);
  });

  it("builds a URL under the language, so audio cannot be fetched cross-locale", () => {
    const index = readManifest(body("hi-IN", [entry("नमस्ते")]), "hi-IN");

    expect(index.get("नमस्ते")?.url).toBe(`/api/v1/model-voice/hi-IN/${KEY}.mp3`);
  });

  it("refuses a manifest that answers for a different language", () => {
    /**
     * The single most damaging thing this feature could do is play a phrase
     * in the wrong language to somebody being scored on their pronunciation
     * of it. A misrouted or mis-cached body is refused wholesale rather than
     * per entry: if the envelope is wrong there is no reason to trust its
     * contents.
     */
    const index = readManifest(body("fr-FR", [entry("Bonjour")]), "hi-IN");

    expect(index.size).toBe(0);
  });

  it("is empty for anything that is not a manifest", () => {
    // A 404 body, an HTML error page parsed as JSON, a proxy's own response.
    // All of them mean the same thing: use the platform voice.
    expect(readManifest(null, "fr-FR").size).toBe(0);
    expect(readManifest("nope", "fr-FR").size).toBe(0);
    expect(readManifest({ language: "fr-FR" }, "fr-FR").size).toBe(0);
    expect(readManifest(body("fr-FR", []), "fr-FR").size).toBe(0);
  });

  it("drops one bad entry rather than the whole language", () => {
    // Nine working phrases must not be lost to one that is malformed — the
    // same posture src/content/cache.ts takes for activities.
    const index = readManifest(body("fr-FR", [entry("Bonjour"), { text: "Merci" }]), "fr-FR");

    expect([...index.keys()]).toEqual(["Bonjour"]);
  });

  it("drops an entry whose audio name is not a cache key", () => {
    /**
     * The name becomes a URL this client fetches. A manifest is a document
     * and a document can be wrong in ways a path traversal notices, so the
     * shape is checked rather than interpolated on trust.
     */
    const index = readManifest(
      body("fr-FR", [
        entry("Bonjour", { audio: "../../../etc/passwd" }),
        entry("Merci", { audio: "https://elsewhere.example/track.mp3" }),
        entry("Salut", { audio: `${KEY}.wav` }),
      ]),
      "fr-FR",
    );

    expect(index.size).toBe(0);
  });

  it("drops an entry whose time arrays are short", () => {
    /**
     * A short array means the last words of the phrase have no time. The
     * highlight would stop mid-phrase, which reads to a learner as the voice
     * having stopped — so the entry is refused rather than half-trusted.
     */
    const short = entry("Bonjour");
    short.startSeconds = short.startSeconds.slice(0, 3);

    expect(readManifest(body("fr-FR", [short]), "fr-FR").size).toBe(0);
  });

  it("drops an entry whose times are not numbers", () => {
    const wrong = entry("Bonjour", { startSeconds: [..."Bonjour"].map(() => "0.1") });

    expect(readManifest(body("fr-FR", [wrong]), "fr-FR").size).toBe(0);
  });

  it("keeps the first of two entries with the same text", () => {
    // A duplicated target is a content bug the publish gate already refuses.
    // Preferring the later one would make which recording plays depend on
    // array order, which is not a decision anybody made.
    const index = readManifest(
      body("fr-FR", [entry("Bonjour", { phraseId: 1 }), entry("Bonjour", { phraseId: 9 })]),
      "fr-FR",
    );

    expect(index.size).toBe(1);
  });

  it("points the fetch at the language's own manifest", () => {
    expect(manifestUrl("hi-IN")).toBe("/api/v1/model-voice/hi-IN/manifest.json");
  });
});

describe("turning character times into word times", () => {
  it("gives one start per word, numbered the way phraseTokens numbers them", () => {
    /**
     * The agreement that matters. `phraseTokens` decides that "Bonjour" is
     * word 0, "comment" is word 1 and "ça" is word 2, and the screen draws
     * spans in exactly that order — so the *n*th number here has to be the
     * start of the *n*th span. Written against the real tokenizer so that a
     * change to either side breaks this rather than drifting past it.
     */
    const text = "Bonjour comment ça";
    const starts = wordStartSeconds(phraseTokens(text), served(text));

    // "Bonjour" starts at character 0, "comment" at 8, "ça" at 16.
    expect(starts).toEqual([0, 0.8, 1.6]);
  });

  it("counts the gaps, so a phrase with a double space is not off by one", () => {
    // `phraseTokens` keeps whitespace runs as tokens precisely so offsets
    // stay true to the phrase. A tokenizer that collapsed them would put
    // every word after the gap one character early.
    const text = "Buenos  días";
    const starts = wordStartSeconds(phraseTokens(text), served(text));

    expect(starts).toEqual([0, 0.8]);
  });

  it("works on the scripts the corpus is actually written in", () => {
    // Devanagari and Kannada are the real cases, and the arithmetic has to
    // survive a script whose words are not Latin letters separated by spaces.
    const text = "नमस्ते आप";
    const starts = wordStartSeconds(phraseTokens(text), served(text));

    expect(starts).toHaveLength(2);
    expect(starts?.[0]).toBe(0);
    // "आप" begins at offset 7, which in this script is also entry 7.
    expect(starts?.[1]).toBeCloseTo(0.7);
  });

  it("counts characters, not UTF-16 units, so a surrogate pair does not shift the mark", () => {
    /**
     * `phraseTokens` reports `start` as a string offset — what a `boundary`
     * event reports and what `slice` understands. The provider returns one
     * entry per *character*, and a character outside the BMP is two UTF-16
     * units. Indexing the times array directly by that offset drifts by one
     * position per such character and marks the wrong word from there on: it
     * is right for every script this product ships today and wrong the first
     * time it is not, which is the shape of bug that survives a release.
     *
     * The emoji stands in for any astral character. The second word's time
     * must be the time of *its own first character*, not of whatever entry
     * happens to sit at its string offset.
     */
    const text = "a\u{1F600} zz";
    const phrase = served(text);
    // Three entries for four UTF-16 units before "zz": "a", the emoji, " ".
    expect(phrase.characters).toHaveLength(5);

    const starts = wordStartSeconds(phraseTokens(text), phrase);

    /**
     * Asserted against the fixture's own entries rather than the decimals
     * they happen to print as. The property under test is *which entry was
     * chosen* — index 3, the second word's own first character, not index 4
     * where its UTF-16 offset would land. Writing `0.3` here made the test
     * about IEEE754 instead: the fixture builds times as `i * 0.1`, and
     * `3 * 0.1` is 0.30000000000000004, so the assertion failed while the
     * code under test was correct.
     */
    // `wordStartSeconds` returns null when the entries and the tokens
    // disagree about the text, so narrow before indexing — an emoji is exactly
    // the input that would make that mismatch plausible.
    expect(starts).not.toBeNull();
    expect(starts).toEqual([phrase.startSeconds[0], phrase.startSeconds[3]]);
    expect(starts?.[1]).not.toBe(phrase.startSeconds[4]);
  });

  it("survives leading whitespace without claiming the phrase starts at zero", () => {
    const text = " Hola";
    const starts = wordStartSeconds(phraseTokens(text), served(text));

    // The word starts at character 1, not at 0 — the audio has a beat of
    // nothing in front of it and the mark should wait for the voice.
    expect(starts).toEqual([0.1]);
  });

  it("refuses when the alignment does not reproduce the phrase", () => {
    /**
     * If the provider normalised the text — expanding a number, rewriting
     * punctuation — then character *n* of the alignment is no longer
     * character *n* of what is on screen, and every offset is wrong by an
     * unknown amount. Refusing means the recording plays with no mark, which
     * is the floor the platform voice has always had. Guessing would mean a
     * highlight that is confidently on the wrong word.
     */
    const onScreen = "quarante-deux";
    const alignment = served("quarante deux");

    expect(wordStartSeconds(phraseTokens(onScreen), alignment)).toBeNull();
  });

  it("refuses when the times run backwards", () => {
    // A mark that jumps back a word looks like the voice repeating itself.
    const text = "Bonjour comment";
    const backwards = served(text);
    backwards.startSeconds = backwards.startSeconds.map((_, i) => (i < 8 ? 5 : 1));

    expect(wordStartSeconds(phraseTokens(text), backwards)).toBeNull();
  });

  it("clamps a negative time rather than scheduling in the past", () => {
    const text = "Bonjour";
    const negative = served(text);
    negative.startSeconds = negative.startSeconds.map(() => -1);

    expect(wordStartSeconds(phraseTokens(text), negative)).toEqual([0]);
  });

  it("has no words in a phrase that is only whitespace", () => {
    expect(wordStartSeconds(phraseTokens("   "), served("   "))).toEqual([]);
  });
});
