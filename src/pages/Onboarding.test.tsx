// @vitest-environment jsdom

/**
 * The four steps, and the promises they make before a learner has committed
 * to anything.
 *
 * The ordering is the design: the microphone is asked for **last**, after the
 * learner has seen what the product does and knows what happens to a
 * recording. The browser asks once — on iOS a refusal cannot be re-prompted
 * from the page at all — so a permission dialogue fired before any of that is
 * a one-shot question asked at the worst possible moment.
 *
 * Two of these assertions are about honesty rather than layout:
 *
 *  - The demo screen shows a **real** scored take, weak syllables and all. A
 *    row of nineties would demonstrate the opposite of the product's claim.
 *  - The microphone screen says a recording *can* be written to disk when
 *    diagnostics are on. Saying "nothing is ever stored" would be false
 *    whenever they are, and a learner who later found the setting would have
 *    no reason to believe any other sentence on the screen.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";

const navigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>("react-router-dom");
  return { ...actual, useNavigate: () => navigate };
});

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
      available: true,
      wordIndex: null,
    }),
  };
});

async function open() {
  const { Onboarding } = await import("./Onboarding.js");
  render(
    <MemoryRouter>
      <Onboarding />
    </MemoryRouter>,
  );
}

/** Walks to the named step, since each is reached only through the last. */
async function reach(step: "language" | "name" | "microphone") {
  await open();
  fireEvent.click(screen.getByRole("button", { name: /Sounds useful/i }));
  if (step === "language") return;
  fireEvent.click(screen.getByRole("button", { name: /^Continue with/i }));
  if (step === "name") return;
  fireEvent.click(screen.getByRole("button", { name: /Skip — no name/i }));
}

beforeEach(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      get length() {
        return store.size;
      },
      clear: () => store.clear(),
      getItem: (k: string) => store.get(k) ?? null,
      key: (i: number) => [...store.keys()][i] ?? null,
      removeItem: (k: string) => void store.delete(k),
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  Object.defineProperty(window, "scrollTo", { writable: true, value: vi.fn() });
  navigate.mockClear();
});

afterEach(cleanup);

describe("step 1 — what the product does, before anything is asked", () => {
  it("asks for nothing at all", async () => {
    await open();

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/microphone/i)).not.toBeInTheDocument();
  });

  /**
   * A real take. The claim is that the product tells you *which sound* went
   * wrong, and an example where everything scored well demonstrates nothing —
   * it is also not what a first attempt looks like.
   */
  it("shows a scored example with weak syllables in it", async () => {
    await open();

    expect(screen.getByText("54")).toBeInTheDocument();
    expect(screen.getByText("66")).toBeInTheDocument();
  });

  it("says the example aloud as sentences, not as a run of numbers", async () => {
    /**
     * This screen exists to explain what the product does, so how it reads
     * aloud is the demonstration for anybody using a screen reader.
     *
     * It used to hand-roll the chips from the real ones' stylesheet and
     * announce "Je 91 vou 54 drais 66 ca 88 fé 93" — every grapheme and every
     * number in one flat run. The wrapper carried `aria-label="An example
     * scored take"`, which is not announced on a static element, a thing
     * `SyllableChips` had already learned and has a test for. The old
     * assertion here checked that dead label was present, so it passed on a
     * label nobody heard.
     *
     * Using the real component is what makes the comment above it true, and
     * this is the assertion that fails if somebody copies the markup again.
     */
    await open();

    /**
     * Read off the spoken spans rather than with `getByText`, because a named
     * syllable's sentence is deliberately two nodes — the grapheme carries
     * `lang` so a screen reader says "fé" in French and "scored 93 out of 100"
     * in English. A text query cannot match across that split, which is also
     * why `SyllableChips`' own tests only ever assert the unnamed form.
     */
    const spoken = [...document.querySelectorAll(".sr-only")].map((n) => n.textContent);

    expect(spoken).toContain("vou, scored 54 out of 100");
    expect(spoken).toContain("fé, scored 93 out of 100");
  });

  it("keeps the play glyph out of the button's accessible name", async () => {
    // "▶" is read as "black right-pointing triangle" — noise in front of the
    // two words that say what the button does.
    await open();

    expect(screen.getByRole("button", { name: "Play it" })).toBeInTheDocument();
  });

  it("says the goal is being understood, not sounding native", async () => {
    await open();
    expect(screen.getByText(/not sounding native/i)).toBeInTheDocument();
  });

  /**
   * Nothing has been earned yet, and a first session cannot afford to pretend
   * otherwise.
   */
  it("shows no streak, no progress and no count", async () => {
    await open();

    expect(screen.queryByText(/day(s)? in a row/i)).not.toBeInTheDocument();
    expect(document.querySelector(".steps-track")).toBeNull();
  });
});

describe("step 2 — the language", () => {
  it("offers every language the app has content for", async () => {
    await reach("language");

    const { resolveLanguages } = await import("../content/resolve.js");
    expect(screen.getAllByRole("button", { pressed: false }).length + 1).toBe(
      resolveLanguages().length,
    );
  });

  /**
   * A learner sees their language in its own script at the first opportunity,
   * and the `lang` tag is what makes a screen reader say it correctly rather
   * than spelling it out in English.
   */
  it("renders each sample in its own language, tagged", async () => {
    await reach("language");

    const samples = document.querySelectorAll(".onboarding-language-sample");
    expect(samples.length).toBeGreaterThan(0);
    samples.forEach((sample) => expect(sample.getAttribute("lang")).toBeTruthy());
  });

  it("names the chosen language on the button that continues", async () => {
    await reach("language");
    expect(screen.getByRole("button", { name: /^Continue with \w+/ })).toBeInTheDocument();
  });
});

describe("step 3 — a name, if you want one", () => {
  /** "optional" in the label, not in fine print underneath it. */
  it("says the name is optional in the label itself", async () => {
    await reach("name");
    expect(screen.getByLabelText(/optional/i)).toBeInTheDocument();
  });

  it("offers skipping as a button, not a link at the bottom", async () => {
    await reach("name");
    expect(screen.getByRole("button", { name: /Skip — no name/i })).toBeInTheDocument();
  });

  it("saves a name that was typed", async () => {
    await reach("name");
    fireEvent.change(screen.getByLabelText(/optional/i), { target: { value: "Marie" } });
    fireEvent.click(screen.getByRole("button", { name: /Save and carry on/i }));

    expect(localStorage.getItem("sonare.learnerName")).toBe("Marie");
  });

  it("stores nothing when the name is skipped", async () => {
    await reach("name");
    fireEvent.click(screen.getByRole("button", { name: /Skip — no name/i }));

    expect(localStorage.getItem("sonare.learnerName")).toBeNull();
  });

  it("stores nothing for a name that is only spaces", async () => {
    await reach("name");
    fireEvent.change(screen.getByLabelText(/optional/i), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: /Save and carry on/i }));

    expect(localStorage.getItem("sonare.learnerName")).toBeNull();
  });
});

describe("step 4 — the ask", () => {
  it("comes last, after the learner knows what the product does", async () => {
    await reach("microphone");
    expect(screen.getByRole("heading", { name: /your microphone/i })).toBeInTheDocument();
  });

  it("warns that the browser asks once, before the prompt fires", async () => {
    await reach("microphone");
    expect(screen.getByText(/cannot ask again/i)).toBeInTheDocument();
  });

  /**
   * The line that makes the other three believable. "Nothing is ever stored"
   * would be false whenever diagnostics are on, and a learner who later found
   * that setting would have no reason to trust anything else here.
   */
  it("admits a recording can be written to disk, rather than overpromising", async () => {
    await reach("microphone");

    expect(screen.getByText(/we will not tell you nothing is ever stored/i)).toBeInTheDocument();
    expect(screen.queryByText(/never stored anywhere/i)).not.toBeInTheDocument();
  });

  it("says takes are kept 90 days and the numbers are not expired on a timer", async () => {
    await reach("microphone");
    expect(screen.getByText(/90 days/i)).toBeInTheDocument();
  });

  it("goes to the check when the learner agrees", async () => {
    await reach("microphone");
    fireEvent.click(screen.getByRole("button", { name: /Ask for the microphone/i }));

    expect(navigate).toHaveBeenCalledWith("/check");
  });

  /** Declining is a supported route, not a dead end. */
  it("lets a learner start with listening only", async () => {
    await reach("microphone");
    fireEvent.click(screen.getByRole("button", { name: /start with listening only/i }));

    expect(navigate).toHaveBeenCalled();
    expect(navigate.mock.calls[0]?.[0]).not.toBe("/check");
  });
});
