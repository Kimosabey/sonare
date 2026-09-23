/**
 * Onboarding — boards 1a–1d, four steps before the microphone check.
 *
 * The order is the argument. A learner is shown what the product does, picks
 * what they want, is offered a name they can decline, and only then is asked
 * for the microphone — with what happens to a recording stated before the
 * browser's prompt fires rather than after.
 *
 * ## Why the ask comes last, and explained
 *
 * The browser asks **once**. On iOS Safari a refusal cannot be re-prompted
 * from the page at all; it takes a trip through Settings. So a permission
 * dialogue that appears before the learner knows what the microphone is for is
 * not a neutral cost — it is a one-shot question asked at the worst possible
 * moment, and the answer is permanent from the page's point of view.
 *
 * ## Why step 1 plays a phrase before asking for anything
 *
 * The product's claim is syllable-level feedback, and that is very hard to
 * believe from a sentence. Showing one scored example — five syllables, five
 * numbers, one of them bad — makes the rest of the flow worth a learner's
 * patience. Nothing is asked on this screen.
 *
 * ## What this screen refuses to imply
 *
 * No streak, no progress bar, no count. Nothing has been earned yet, and a
 * first session cannot afford to pretend otherwise.
 */

import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveLanguages } from "../content/resolve.js";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { markOnboarded } from "../stores/onboardingStore.js";
import { useModelSpeech } from "../hooks/useModelSpeech.js";
import { SyllableChips } from "../speech/components/SyllableChips.js";

/** The four steps, named rather than numbered, so a reorder cannot silently renumber. */
type Step = "demo" | "language" | "name" | "microphone";

const ORDER: Step[] = ["demo", "language", "name", "microphone"];

/**
 * One real scored example, shown on the first screen.
 *
 * Real numbers from a real take rather than a flattering invention: the point
 * of the screen is that the product tells you *which sound* went wrong, and a
 * row of nineties would demonstrate the opposite. `drais` at 66 and `vou` at
 * 54 are what a learner's first attempt actually looks like.
 */
const DEMO = {
  phrase: "Je voudrais un café",
  gloss: "I would like a coffee.",
  code: "fr-FR",
  /**
   * `ScoredSyllable`, the shape the scorer really returns, so these can go
   * through the real chips rather than a copy of their markup. The tick fields
   * are what a take carries; nothing on this screen plays, so they only need
   * to be distinct.
   */
  syllables: [
    { grapheme: "Je", accuracy: 91, offsetTicks: 0, durationTicks: 1 },
    { grapheme: "vou", accuracy: 54, offsetTicks: 1, durationTicks: 1 },
    { grapheme: "drais", accuracy: 66, offsetTicks: 2, durationTicks: 1 },
    { grapheme: "ca", accuracy: 88, offsetTicks: 3, durationTicks: 1 },
    { grapheme: "fé", accuracy: 93, offsetTicks: 4, durationTicks: 1 },
  ],
};

export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("demo");
  const [learnerName, setLearnerName] = useLearnerName();
  const [typedName, setTypedName] = useState("");
  const languages = resolveLanguages();
  const [slug, setSlug] = useState(languages[0]?.slug ?? "fr");
  const model = useModelSpeech(DEMO.code);

  const chosen = languages.find((language) => language.slug === slug) ?? languages[0];
  const position = ORDER.indexOf(step) + 1;

  const go = useCallback((next: Step) => {
    setStep(next);
    // Onboarding is a sequence of full-screen steps rather than a scroll, so
    // each one starts where the last began. Without this a learner arriving at
    // step 4 from the bottom of step 3 lands mid-paragraph.
    window.scrollTo({ top: 0 });
  }, []);

  /* ── 1a · hear it first, before anything is asked ─────────────────────── */

  if (step === "demo") {
    return (
      <section className="enter-1 onboarding">
        <h1>Hear it first.</h1>
        <p className="what">
          This is a French phrase said by a native speaker. Play it as many times as you like.
        </p>

        <p className="phrase" lang={DEMO.code}>
          {DEMO.phrase}
        </p>
        <p className="hint gloss">&ldquo;{DEMO.gloss}&rdquo;</p>

        {model.available && (
          <div className="row">
            <button
              type="button"
              className="listen"
              onClick={() => (model.speaking ? model.cancel() : model.speak(DEMO.phrase, DEMO.code))}
            >
              {model.speaking ? (
                "Stop"
              ) : (
                <>
                  {/* Hidden from the accessible name: a screen reader reads ▶
                      as "black right-pointing triangle", which is noise in
                      front of the two words that say what the button does. */}
                  <span aria-hidden="true">▶ </span>Play it
                </>
              )}
            </button>
          </div>
        )}

        <h2>When you say it back, you get this</h2>
        {/*
          The product's own syllable chips — the component, not its stylesheet.

          This used to hand-roll the markup with `.sy` and the band classes and
          claim in this comment that it was "not a lookalike, so this example
          cannot drift into showing something the app does not produce". It was
          a lookalike, and it had already drifted in the way that mattered
          least visibly and most: a real chip hides its glyph and score from
          assistive technology and restates them as one sentence — "Je, scored
          91 out of 100" — because "Je 91" read aloud is not a sentence in any
          language. The copy announced "Je 91 vou 54 drais 66 ca 88 fé 93", one
          flat run of syllables and numbers, on the screen whose whole job is
          to explain what the product does.

          `SyllableChips` also already knows that an `aria-label` on a static
          element is not announced — there is a test for exactly that — which
          is the trap the wrapper here fell into with "An example scored take".
          The heading above supplies that context instead.

          No `onSelect`, so the chips render static: nothing on this screen is
          playable yet, and the real component drops its "tap a syllable" hint
          when it cannot be tapped.
        */}
        <SyllableChips syllables={DEMO.syllables} lang={DEMO.code} />
        <p className="what">
          Syllable by syllable — <strong>which</strong> sound went wrong, not a mark out of a
          hundred for you.
        </p>
        <p className="hint">The goal is being understood easily, not sounding native.</p>

        <div className="row">
          <button type="button" className="enter-cta" onClick={() => go("language")}>
            Sounds useful — start
          </button>
        </div>
      </section>
    );
  }

  /* ── 1b · which language ──────────────────────────────────────────────── */

  if (step === "language") {
    return (
      <section className="enter-1 onboarding">
        <p className="hint">Step {position} of {ORDER.length}</p>
        <h1>Which language?</h1>
        <p className="what">You can add another later, and switch any time.</p>

        <ul className="onboarding-languages">
          {languages.map((language) => (
            <li key={language.slug}>
              <button
                type="button"
                className={`onboarding-language${language.slug === slug ? " is-chosen" : ""}`}
                aria-pressed={language.slug === slug}
                onClick={() => setSlug(language.slug)}
              >
                {/*
                  Each language's own script, in its own type. A Kannada or
                  Hindi learner sees their language rendered properly at the
                  first opportunity rather than as a transliteration — and the
                  `lang` tag is what makes a screen reader say it correctly.
                */}
                <span className="onboarding-language-sample" lang={language.code}>
                  {language.activities[0]?.target.split(/\s+/)[0] ?? language.label}
                </span>
                <span className="onboarding-language-name">{language.label}</span>
                <span className="hint">{language.activities.length} phrases ready</span>
              </button>
            </li>
          ))}
        </ul>

        <div className="row">
          <button type="button" className="enter-cta" onClick={() => go("name")}>
            Continue with {chosen?.label ?? "this language"}
          </button>
        </div>
      </section>
    );
  }

  /* ── 1c · a name, if you want one ─────────────────────────────────────── */

  if (step === "name") {
    return (
      <section className="enter-1 onboarding">
        <p className="hint">Step {position} of {ORDER.length}</p>
        <h1>A name, if you want one</h1>
        <p className="what">
          It is only used to greet you, and to tell people apart on a shared tablet. Nothing is
          sent anywhere with it.
        </p>

        <p className="row authoring-field">
          {/* "optional" in the label, not in fine print below it. */}
          <label htmlFor="onboarding-name">First name · optional</label>
          <input
            id="onboarding-name"
            type="text"
            autoComplete="given-name"
            value={typedName}
            onChange={(event) => setTypedName(event.target.value)}
          />
        </p>

        <details>
          <summary>No account, either way</summary>
          <div className="body">
            <p className="what">
              There is no email, no password and no sign-in. Your practice lives on this device,
              and you can export it or erase it whenever you like.
            </p>
          </div>
        </details>

        <div className="row">
          <button
            type="button"
            className="enter-cta"
            onClick={() => {
              const trimmed = typedName.trim();
              if (trimmed.length > 0) setLearnerName(trimmed);
              go("microphone");
            }}
          >
            Save and carry on
          </button>
          {/*
            A full-width button, not a link hiding at the bottom. Declining is
            a supported answer and the screen should not make it feel like
            leaving through a side door.
          */}
          <button type="button" onClick={() => go("microphone")}>
            Skip — no name
          </button>
        </div>
      </section>
    );
  }

  /* ── 1d · the ask, before the prompt fires ────────────────────────────── */

  return (
    <section className="enter-1 onboarding">
      <p className="hint">Step {position} of {ORDER.length}</p>
      <h1>Next, your microphone</h1>
      <p className="what">
        Scoring a sound means hearing you make it. There is no way around the microphone, so here
        is exactly what happens.
      </p>

      <ol className="what onboarding-terms">
        <li>
          Each take is recorded on this device and uploaded to be scored. Nothing is uploaded until
          you speak.
        </li>
        <li>
          Takes are kept for 90 days and then deleted automatically. Your sound history — the
          numbers, not the audio — is yours and is never expired on a timer.
        </li>
        {/*
          The line that makes the rest of this list believable. Saying "nothing
          is ever stored" would be false whenever diagnostics are on, and a
          learner who later found the setting would have no reason to trust any
          other sentence here.
        */}
        <li>
          When diagnostics are switched on by whoever runs this service, a copy of a recording can
          also be written to their disk. So we will not tell you nothing is ever stored.
        </li>
        <li>
          You can export everything, or erase all of it, from the You tab — and see the counts of
          what was deleted.
        </li>
      </ol>

      <div className="verdict v-warn" role="note">
        <div className="tag">YOUR BROWSER WILL ASK ONCE</div>
        <div>
          If you say no, this page cannot ask again — turning it back on means a trip through your
          device settings. Say yes when the prompt appears, then say anything you like to check it
          works.
        </div>
      </div>

      <div className="row">
        {/*
          Marked on the way out by **either** route. A learner who declines the
          microphone has still been onboarded — they read the explanation and
          answered — so sending them back through it would ignore the answer
          they just gave.
        */}
        <button
          type="button"
          className="enter-cta"
          onClick={() => {
            markOnboarded(learnerName);
            navigate("/check");
          }}
        >
          Ask for the microphone
        </button>
        <button
          type="button"
          onClick={() => {
            markOnboarded(learnerName);
            navigate(`/${slug}`);
          }}
        >
          Not yet — start with listening only
        </button>
      </div>
    </section>
  );
}
