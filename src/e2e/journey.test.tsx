// @vitest-environment jsdom

/**
 * One learner, one continuous journey through the real `App`.
 *
 * Every other client test in this repo mounts one page in isolation, which is
 * the right shape for asking what a page does with the props it is given and
 * the wrong shape for the only question left: whether the screens agree with
 * each other. Nothing drove `App` across routes, so nothing checked that a
 * name typed on the picker greets the learner on Today, that the streak on the
 * front door counts the take just made rather than yesterday's, or that a
 * syllable measured in one session is on Progress a navigation later. Each of
 * those crosses two components, two stores and a route change, and each of
 * them is exactly the kind of wiring a refactor drops without failing a single
 * per-page test.
 *
 * What is real here: the HashRouter, `Shell`, `useSync`, the lazy `Settings`
 * route, all five learner screens, every store, `nextUp`, `learning/session`,
 * the content resolver, and `ToastProvider`. What is stubbed: the recorder
 * (how a score is obtained is `recorder.test.ts`'s subject), the platform
 * hooks jsdom has no implementation for — speech synthesis, the wake lock,
 * syllable playback — and the network, which rejects throughout so that this
 * file is about the local journey and `offline.test.ts` is about sync.
 *
 * Two things the journey found and did not fix, both reported rather than
 * papered over: `/:slug/progress` has no link to it anywhere in the product,
 * and an indeterminate take changes what the learner is told about the take
 * after it. See the notes at each.
 */

import { cleanup, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGES, MAX_ATTEMPTS } from "../activities/languages/index.js";
import { localDay } from "../stores/streakStore.js";
import {
  LEARNER_NAME_KEY,
  choose,
  fill,
  follow,
  indeterminate,
  installBrowserGlobals,
  installFetch,
  installStorage,
  makeRecorderStub,
  onScreen,
  press,
  renderApp,
  scored,
  screenHeading,
  speak,
  visit,
} from "./harness.js";

const { useRecorder, driver } = makeRecorderStub();
vi.mock("../speech/react/useRecorder.js", () => ({ useRecorder }));
vi.mock("../hooks/useCaptureToasts.js", () => ({
  useCaptureToasts: () => undefined,
  HEARD_SPEECH_SNR_DB: 10,
}));
vi.mock("../hooks/useSyllablePlayback.js", () => ({
  useSyllablePlayback: () => ({ playingOffsetTicks: null, play: vi.fn(), available: false }),
}));
/**
 * `phraseTokens` stays real. The screen and the hook agree on what "word 3"
 * means because one function answers it for both, and stubbing it here would
 * be a screen agreeing with itself.
 */
vi.mock("../hooks/useModelSpeech.js", async () => {
  const actual = await vi.importActual<typeof import("../hooks/useModelSpeech.js")>(
    "../hooks/useModelSpeech.js",
  );
  return {
    phraseTokens: actual.phraseTokens,
    useModelSpeech: () => ({
      speak: vi.fn(),
      cancel: vi.fn(),
      speaking: false,
      // The honest answer for jsdom, and for Hindi on a device with no hi-IN
      // voice installed.
      available: false,
      wordIndex: null,
    }),
  };
});
vi.mock("../hooks/useWakeLock.js", () => ({ useWakeLock: () => undefined }));

/** French, read from the content rather than restated. */
const FRENCH = (() => {
  const set = LANGUAGES.find((l) => l.slug === "fr");
  if (!set) throw new Error("French is no longer a shipped language");
  return set;
})();

function activityTitle(index: number): string {
  const activity = FRENCH.activities[index];
  if (!activity) throw new Error(`French has no activity at index ${index}`);
  return activity.title;
}

/**
 * The tries-remaining line as its own element.
 *
 * Matched whole rather than by scanning `document.body.textContent`: the score
 * card renders the accuracy as a bare numeral, and with a take of 30 on screen
 * a loose `/\d+ tries left/` reads the two together as "300 tries left" — a
 * helper that would have made a real off-by-one invisible.
 */
function triesLine(): string {
  return screen.getByText(/^(\d+ tries left|Last try for this one)$/).textContent ?? "";
}

/** The pass banner's tag — "FIRST TRY!", "NEW BEST!" or "PASSED". */
function celebrationTag(): string | null {
  return document.querySelector(".pass-banner .tag")?.textContent ?? null;
}

function nextButton(): HTMLElement | null {
  return screen.queryByRole("button", { name: /Next activity|Finish and see report/i });
}

/**
 * A first visit, all the way to a passed activity, entirely by clicking what
 * is on screen.
 *
 * This is the journey the file is about, so it is walked rather than seeded:
 * seeding storage and mounting one page would assert that a screen renders a
 * fixture, where walking it asserts that the screen before it wrote one.
 *
 * The take sequence is deliberate. An unusable take first, because at a 9.4%
 * indeterminate rate that is the ordinary opening rather than an edge; then a
 * scored miss, then a pass — which is what puts two samples of each syllable
 * in the sound history, the minimum `weakestSkills` will report a trend on.
 */
async function walkToFirstPass(): Promise<void> {
  await renderApp("#/");

  // The front door for somebody with no history: a picker, not a dashboard of
  // zeroes.
  follow("Choose a language");
  await onScreen("Choose a language");

  // Asked once, before the first language pick.
  fill("Your name", "Marie");
  await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  press("Continue");

  await waitFor(() => expect(screen.getByText(/Hi, Marie\./)).toBeInTheDocument());
  follow(new RegExp(`${FRENCH.label}\\s*${FRENCH.activities.length} activities`));
  await onScreen(`${FRENCH.label} speech activity`);

  press(/^Start$/);
  speak(driver, indeterminate());
  speak(driver, scored(45));
  speak(driver, scored(88));
  await waitFor(() => expect(nextButton()).not.toBeNull());
}

beforeEach(() => {
  installStorage();
  installBrowserGlobals();
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("the front door on a first visit", () => {
  it("offers the picker rather than a dashboard of zeroes", async () => {
    /**
     * `nextUp` returns null exactly when no language has been practised, and
     * that is the real first-visit signal — `allProgress` returns every
     * language the app ships, so "is the list empty" would never fire.
     */
    await renderApp("#/");

    expect(screenHeading()).toBe("Today");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome");
    expect(screen.getByRole("link", { name: "Choose a language" })).toBeInTheDocument();
    expect(screen.queryByText("Streak")).not.toBeInTheDocument();
    expect(screen.queryByText(/Carry on/)).not.toBeInTheDocument();
  });

  it("asks for a name before the first language, then stops asking", async () => {
    await renderApp("#/");
    follow("Choose a language");
    await onScreen("Choose a language");
    expect(screen.getByLabelText("Your name")).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    fill("Your name", "Marie");
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    press("Continue");

    await waitFor(() => expect(screen.getByText(/Hi, Marie\./)).toBeInTheDocument());
    expect(screen.queryByLabelText("Your name")).not.toBeInTheDocument();
  });
});

describe("what one screen establishes is still true on the next", () => {
  it("carries the name from the picker to Today and on to Settings", async () => {
    /**
     * The name is held in component state by `useLearnerName`, one instance
     * per screen, so nothing in memory carries it across a route change —
     * `localStorage` does. Three separate screens, three separate hook
     * instances, one learner.
     */
    await walkToFirstPass();

    follow("Sonare");
    await onScreen("Today");
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome back, Marie");

    follow("Your data");
    await onScreen("Settings");
    expect(await screen.findByText(/everything the server holds for/)).toHaveTextContent("Marie");
  });

  it("resumes the activity that is still unpassed, not the one just finished", async () => {
    /**
     * `nextUp` prefers the first *unpassed* activity over the stored index,
     * which is the difference between "where you stopped" and "what is left".
     * Activity 1 was passed and advanced, so the front door has to offer
     * activity 2.
     */
    await walkToFirstPass();
    press(/Next activity/);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(activityTitle(1)));

    follow("Sonare");
    await onScreen("Today");

    const resume = screen.getByRole("link", { name: /Carry on/ });
    expect(resume).toHaveTextContent(`Carry on · ${FRENCH.label}`);
    expect(resume).toHaveTextContent(activityTitle(1));
    expect(resume).toHaveTextContent(`2 of ${FRENCH.activities.length}`);
    expect(resume).toHaveAttribute("href", `#/${FRENCH.slug}`);
  });

  it("sends the learner back to what the soft gate let them past", async () => {
    /**
     * The one case where "where you stopped" and "what is left" disagree, and
     * the reason `nextUp` computes the second rather than reading the first.
     *
     * Three scored tries on activity 1 without passing: the gate is soft, so
     * the learner advances with it recorded as skipped and the stored index
     * moves to 2. The front door has to offer activity **1** anyway, because
     * that is the thing they have not done — a resume card reading "2 of 10"
     * here would quietly bury the activity the scorer beat them on, which is
     * exactly the failure this POC exists to detect rather than hide.
     */
    const store = installStorage({ [LEARNER_NAME_KEY]: "Marie" });
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    speak(driver, scored(20));
    speak(driver, scored(25));
    speak(driver, scored(30));
    await waitFor(() => expect(nextButton()).not.toBeNull());
    expect(triesLine()).toBe("0 tries left");
    expect(screen.getByText(/attempts used/)).toBeInTheDocument();
    press(/Next activity/);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(activityTitle(1)));

    // Filed as skipped, which is what the report will say the learner did.
    const key = [...store.keys()].find((k) => k.startsWith("sonare.progress."));
    const stored = JSON.parse(store.get(key ?? "") ?? "{}") as {
      index: number;
      progress: Array<{ activityId: number; skipped: boolean; passed: boolean }>;
    };
    expect(stored.index).toBe(1);
    expect(stored.progress[0]).toMatchObject({ activityId: 1, passed: false, skipped: true });

    follow("Sonare");
    await onScreen("Today");

    const resume = screen.getByRole("link", { name: /Carry on/ });
    expect(resume).toHaveTextContent(activityTitle(0));
    expect(resume).toHaveTextContent(`1 of ${FRENCH.activities.length}`);
  });

  it("counts the take just made as today's practice day", async () => {
    /**
     * The streak could never be anything but zero before `recordPractice` was
     * wired into the scoring callback, and no per-page test can see the
     * difference: the activity screen writes the day and the front door reads
     * it, one route change apart.
     */
    await walkToFirstPass();

    follow("Sonare");
    await onScreen("Today");

    const streak = screen.getByText("Streak").closest("div");
    expect(streak).not.toBeNull();
    expect(streak).toHaveTextContent("1day");
    expect(streak).toHaveTextContent("practised today");
    expect(screen.getByText("This week").closest("div")).toHaveTextContent(`1of 7 days`);
    expect(screen.getByText("Best run").closest("div")).toHaveTextContent("1day");
  });

  it("names the sound being worked on, tagged as the language it is in", async () => {
    /**
     * The one claim on the front door about pronunciation, and it comes from
     * the syllables the take recorded — through `recordSkills` on one screen
     * and `readSkills` on another. `lang` on the grapheme so a screen reader
     * says the syllable in French rather than in the page's English (WCAG
     * 3.1.2).
     */
    await walkToFirstPass();

    follow("Sonare");
    await onScreen("Today");

    const working = screen.getByText(/Working on/);
    expect(working).toHaveTextContent("jour");
    // "now at 55" — the mean of two samples of "jour" at 55, not the take's
    // own overall accuracy.
    expect(working).toHaveTextContent("now at 55");
    expect(within(working).getByText("jour")).toHaveAttribute("lang", FRENCH.code);
  });

  it("refuses to invent a trend on a first session", async () => {
    // Two samples is enough to report a sound and not enough to compare it
    // against anything. "No change" on a learner's first Tuesday is false.
    await walkToFirstPass();

    follow("Sonare");
    await onScreen("Today");

    expect(screen.getByText(/Working on/)).toHaveTextContent("not enough history to show a trend yet");
    expect(document.body.textContent).not.toMatch(/up from|down from/);
  });

  it("does not report a language nobody has opened as a language failed", async () => {
    // "0 of 10 passed" on an untouched language reads as a loss on a screen
    // the learner has never used.
    await walkToFirstPass();

    follow("Sonare");
    await onScreen("Today");

    const others = LANGUAGES.filter((l) => l.slug !== FRENCH.slug);
    for (const language of others) {
      const card = screen.getByRole("link", { name: new RegExp(`^${language.label}`) });
      expect(card).toHaveTextContent(`${language.activities.length} activities`);
      expect(card).not.toHaveTextContent("passed");
    }
  });
});

describe("Progress, a navigation later", () => {
  /**
   * Reached by URL, because there is no way to reach it otherwise.
   *
   * `/:slug/progress` is routed in App.tsx, has a breadcrumb and a header
   * heading of its own, and nothing anywhere in the product links to it — the
   * only `/progress` strings in `src/` are the route, the two regexes that
   * style the crumb, and its own test. That is reported as a defect rather
   * than worked around: the internal screens are URL-only on purpose and say
   * so, but this one is learner-facing.
   */
  it("shows the syllables measured in the session just finished", async () => {
    await walkToFirstPass();
    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    // By its own column header rather than by role alone: the calendar below
    // is a `role="table"` too, and it is the one with an accessible name.
    const table = screen.getByRole("columnheader", { name: "Syllable" }).closest("table");
    if (table === null) throw new Error("the sounds table lost its own header");
    const jour = within(table).getByText("jour").closest("tr");
    expect(jour).not.toBeNull();
    // now 55, before "—", two takes behind it.
    expect(jour).toHaveTextContent("55");
    expect(jour).toHaveTextContent("2");
    expect(within(table).getByText("bon").closest("tr")).toHaveTextContent("70");
  });

  it("explains a dash rather than letting it read as a bug", async () => {
    await walkToFirstPass();
    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    expect(
      screen.getByText(/A dash means there is not enough history to compare against yet/),
    ).toBeInTheDocument();
  });

  it("shows the activity just passed", async () => {
    await walkToFirstPass();
    press(/Next activity/);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(activityTitle(1)));

    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    expect(screen.getByText(`1 of ${FRENCH.activities.length} passed`)).toBeInTheDocument();
  });

  it("marks today, and only today, on the practice calendar", async () => {
    await walkToFirstPass();
    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);

    const calendar = screen.getByRole("table", { name: /Practice over the last/ });
    const marked = within(calendar)
      .getAllByRole("cell")
      .filter((cell) => (cell.getAttribute("aria-label") ?? "").endsWith(": practised"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveAttribute("aria-label", `${localDay()}: practised`);
  });
});

describe("coming back to a language", () => {
  it("offers to continue where the session stopped rather than starting over", async () => {
    await walkToFirstPass();
    press(/Next activity/);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(activityTitle(1)));

    follow("Sonare");
    await onScreen("Today");
    follow(/Carry on/);
    await onScreen(`${FRENCH.label} speech activity`);

    // A refresh or a route change always lands back on the intro — Start
    // needs a fresh user gesture to open the microphone (R10) — but it lands
    // there knowing what was already done.
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Welcome back");
    expect(
      screen.getByText(`Continuing Activity 2 of ${FRENCH.activities.length} — 1 passed so far.`),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("starts the other language fresh while keeping the learner's practice day", async () => {
    /**
     * Two properties that pull in opposite directions and are both right.
     * Switching language remounts the activity screen — `key={slug}` in
     * App.tsx — so no French progress leaks into Spanish. The streak is a
     * fact about a *person*, not a language, so it comes with them.
     */
    await walkToFirstPass();
    press(/Next activity/);
    await waitFor(() => expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(activityTitle(1)));

    const spanish = LANGUAGES.find((l) => l.slug === "es");
    if (!spanish) throw new Error("Spanish is no longer a shipped language");
    choose("Switch language", spanish.slug);

    await onScreen(`${spanish.label} speech activity`);
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("Ready to practice?");
    expect(document.body.textContent).not.toContain("passed so far");

    press(/^Start$/);
    expect(screen.getByText("Day 1")).toBeInTheDocument();
  });
});

describe("R8, seen from inside a journey", () => {
  it("charges nothing for a take the system declined to judge", async () => {
    /**
     * Asserted here as well as in `ActivityTest.test.tsx` because the journey
     * can see one thing the page test cannot: that the unusable take is still
     * on record afterwards. Not charged is not the same as not happened, and
     * the 9.4% indeterminate rate is a finding about the scorer that the
     * report has to keep the evidence for.
     */
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    const before = triesLine();

    speak(driver, indeterminate());
    speak(driver, indeterminate());
    speak(driver, indeterminate());
    speak(driver, indeterminate());

    await waitFor(() => expect(triesLine()).toBe(before));
    expect(triesLine()).toBe(`${MAX_ATTEMPTS} tries left`);
    expect(nextButton()).toBeNull();
    expect(celebrationTag()).toBeNull();
    // No number anywhere: the take produced none, so the screen must not show
    // one. `.sc-figure` is the score card's own figure.
    expect(document.querySelector(".sc-figure")).toBeNull();
  });

  it("still credits the practice day, because the learner did show up", async () => {
    /**
     * The deliberate other half of R8. `recordPractice` takes no score by
     * signature, so an unmeasurable take cannot cost a day — and a learner in
     * a noisy room has practised. What it must *not* do is invent a
     * measurement, so no sound history is written and no activity is passed.
     */
    installStorage({ [LEARNER_NAME_KEY]: "Marie" });
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);
    speak(driver, indeterminate());

    follow("Sonare");
    await onScreen("Today");

    expect(screen.getByText("Streak").closest("div")).toHaveTextContent("1day");
    expect(screen.queryByText(/Working on/)).not.toBeInTheDocument();
    await visit(`#/${FRENCH.slug}/progress`);
    await onScreen(`${FRENCH.label} progress`);
    expect(screen.getByText(/Nothing measured yet/)).toBeInTheDocument();
    expect(screen.getByText(`0 of ${FRENCH.activities.length} passed`)).toBeInTheDocument();
  });

  /**
   * **Fixed — this is now a plain assertion.**
   *
   * An unusable take must cost the learner nothing (R8), and it was costing
   * them this: the take *after* it was no longer their first attempt, so
   * `celebrationFor` fell past the `firstTry` branch into `personalBest`, and
   * the banner read "beat your previous best" over a best that had never
   * existed — the indeterminate take left `best` null. A learner whose first
   * word was drowned out by a bus was congratulated for beating a score
   * nobody ever recorded, and lost the "FIRST TRY!" they had earned.
   *
   * `ActivityTest.tsx` now counts `scoredAttemptsOf(...)` here, matching
   * every other try-allowance decision on that screen. Worth keeping as a
   * test rather than deleting with the bug: this is the honesty boundary
   * being broken by arithmetic rather than by a fabricated number, which is
   * the harder kind to notice — nothing in the code looked dishonest.
   */
  it("does not let an unusable take rewrite what the next one is told", async () => {
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    speak(driver, indeterminate());
    speak(driver, scored(88));

    await waitFor(() => expect(celebrationTag()).not.toBeNull());
    expect(celebrationTag()).toBe("FIRST TRY!");
    expect(document.body.textContent).not.toContain("beat your previous best");
  });

  it("celebrates a clean first pass as a first try", async () => {
    // The control for the case above: with nothing before it, the same score
    // is reported correctly.
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    speak(driver, scored(88));

    await waitFor(() => expect(celebrationTag()).not.toBeNull());
    expect(celebrationTag()).toBe("FIRST TRY!");
    expect(document.body.textContent).not.toContain("beat your previous best");
  });
});

describe("the end of the session", () => {
  it("agrees with the streak it just credited, and hands the mic back", async () => {
    /**
     * The report and the session summary are rendered as siblings precisely so
     * the summary can read persistent storage without breaking R11 inside
     * `src/speech/`. This is the only test that sees them together, and the
     * only one that sees `endSession` fire — the warm microphone has to be
     * released the moment the session is over, or the OS recording indicator
     * stays lit while the learner reads their report.
     */
    installStorage({ [LEARNER_NAME_KEY]: "Marie" });
    await renderApp(`#/${FRENCH.slug}`);
    press(/^Start$/);

    for (let i = 0; i < FRENCH.activities.length; i += 1) {
      speak(driver, scored(88));
      await waitFor(() => expect(nextButton()).not.toBeNull());
      press(/Next activity|Finish and see report/);
    }

    await waitFor(() => expect(screen.getByText("Today’s practice")).toBeInTheDocument());
    expect(screen.getByText(/Day one\. Come back tomorrow to make it two\./)).toBeInTheDocument();
    expect(driver.endSession).toHaveBeenCalled();

    // And the front door now offers practice again rather than a resume.
    follow("Back to today");
    await onScreen("Today");
    expect(screen.getByRole("link", { name: /Practise again/ })).toHaveTextContent(
      `Practise again · ${FRENCH.label}`,
    );
  });
});
