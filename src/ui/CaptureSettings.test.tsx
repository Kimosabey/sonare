// @vitest-environment jsdom

/**
 * The three capture toggles, and the description text that is the only reason
 * they are usable.
 *
 * Continuous and Auto-Stop are genuinely independent, and all four
 * combinations mean something different — so the summary line has to say which
 * one is in force. Without it a learner picks a combination and finds out what
 * it does by recording; and the worst pairing to discover that way is
 * auto-stop off, where someone waits for a stop that never comes and records
 * room noise to the ceiling.
 *
 * The Interim Results copy carries a load-bearing denial. Partial hypotheses
 * need streaming recognition over a WebSocket, which R6 forbids and PRD §4
 * puts out of scope. So the label must not promise transcription — this is
 * local capture feedback, and saying otherwise would set an expectation the
 * architecture cannot meet.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CaptureSettings,
  DEFAULT_CAPTURE_SETTINGS,
  SENSITIVITY_FACTOR,
} from "./CaptureSettings.js";
import type { CaptureSettingsValue } from "./CaptureSettings.js";

function open(value: Partial<CaptureSettingsValue> = {}, extra: { hangoverMs?: number; disabled?: boolean } = {}) {
  const onChange = vi.fn();
  render(
    <CaptureSettings
      value={{ ...DEFAULT_CAPTURE_SETTINGS, ...value }}
      onChange={onChange}
      hangoverMs={extra.hangoverMs ?? 1200}
      {...(extra.disabled === undefined ? {} : { disabled: extra.disabled })}
    />,
  );
  return { onChange };
}

function summary(): string {
  return document.querySelector(".body > .hint")?.textContent ?? "";
}

afterEach(cleanup);

describe("the defaults", () => {
  it("ships auto-stop and interim on, continuous off", () => {
    /**
     * The default is one utterance that ends itself with live feedback, which
     * is the shape the whole activity flow assumes: three tries per activity,
     * each a single phrase. Continuous on by default would make one long take
     * per activity and score the wrong thing.
     */
    expect(DEFAULT_CAPTURE_SETTINGS).toEqual({
      continuous: false,
      autoStop: true,
      interim: true,
      sensitivity: "normal",
    });
  });

  it("scales the silence window in the order the labels imply", () => {
    // "Quick" must actually be quicker than "Patient" — an inverted table
    // would leave every label lying, and nothing else would fail.
    expect(SENSITIVITY_FACTOR.quick).toBeLessThan(SENSITIVITY_FACTOR.normal);
    expect(SENSITIVITY_FACTOR.normal).toBeLessThan(SENSITIVITY_FACTOR.patient);
    expect(SENSITIVITY_FACTOR.normal).toBe(1);
  });
});

describe("saying which combination is in force", () => {
  it("describes all four pairings distinctly", () => {
    /**
     * Four states, four sentences. Two of them collapsing into one identical
     * string would make the panel look explanatory while telling a learner
     * nothing — and this is the only place the behaviour is stated.
     */
    const seen = new Set<string>();

    for (const continuous of [false, true]) {
      for (const autoStop of [false, true]) {
        cleanup();
        open({ continuous, autoStop });
        seen.add(summary());
      }
    }

    expect(seen.size).toBe(4);
  });

  it("warns that nothing will stop on its own when auto-stop is off", () => {
    /**
     * The worst pairing to discover by recording. Someone waiting for an
     * auto-stop that is switched off keeps talking, then keeps waiting, and
     * the take is mostly silence — scored as their pronunciation.
     */
    open({ autoStop: false, continuous: false });

    expect(summary()).toMatch(/tap again to stop/i);
    expect(screen.getByText("You tap to stop.")).toBeInTheDocument();
  });

  it("states the silence window as a number, so the setting is not a guess", () => {
    // "Ends after a pause" is not actionable. 1.2s is.
    open({ autoStop: true }, { hangoverMs: 1200 });

    expect(screen.getByText(/Ends after 1\.2s of silence/)).toBeInTheDocument();
  });

  it("reflects a changed sensitivity in that number", () => {
    // The point of the sensitivity buttons is that the stated window moves
    // with them; a fixed number would make the buttons look inert.
    open({ autoStop: true, sensitivity: "patient" }, { hangoverMs: 2040 });

    expect(screen.getByText(/Ends after 2\.0s of silence/)).toBeInTheDocument();
  });

  it("promises that a short pause will not cut someone off", () => {
    // The specific anxiety this setting exists to answer: a learner who
    // hesitates mid-phrase needs to know hesitating is allowed.
    open({ autoStop: true });

    expect(screen.getByText(/Shorter pauses will not stop it/)).toBeInTheDocument();
  });
});

describe("Interim Results is not transcription", () => {
  it("says so in the description", () => {
    /**
     * R6 keeps scoring batch-only and PRD §4 puts streaming out of scope, so
     * there are no partial hypotheses to show. Naming the toggle "Interim
     * results" without the denial would promise a live transcript the
     * architecture cannot produce.
     */
    open({ interim: true });

    expect(screen.getByText(/Not transcription\./)).toBeInTheDocument();
  });

  it("describes what it actually shows", () => {
    open({ interim: true });

    const description = screen.getByText(/Not transcription\./).textContent ?? "";
    expect(description).toContain("level");
    expect(description).toContain("speech detection");
    expect(description).toContain("silence countdown");
  });

  it("keeps the same description whether it is on or off", () => {
    // What the toggle *does* does not change with its state. A description
    // that flipped would read as two different features.
    open({ interim: false });

    expect(screen.getByText(/Not transcription\./)).toBeInTheDocument();
  });
});

describe("changing a setting", () => {
  it("reports the whole value, not just the changed key", () => {
    // The caller replaces its state with this object. A partial would drop
    // the other three settings back to undefined.
    const { onChange } = open({ continuous: false, autoStop: true, interim: true, sensitivity: "normal" });

    fireEvent.click(screen.getByRole("switch", { name: /Continuous listening/ }));

    expect(onChange).toHaveBeenCalledWith({
      continuous: true,
      autoStop: true,
      interim: true,
      sensitivity: "normal",
    });
  });

  it("toggles each switch independently", () => {
    for (const [name, key] of [
      [/Continuous listening/, "continuous"],
      [/Auto-stop/, "autoStop"],
      [/Interim results/, "interim"],
    ] as const) {
      cleanup();
      const { onChange } = open();
      fireEvent.click(screen.getByRole("switch", { name }));

      const [next] = onChange.mock.calls[0] as [CaptureSettingsValue];
      expect(next[key], key).toBe(!DEFAULT_CAPTURE_SETTINGS[key]);
    }
  });

  it("selects a sensitivity without disturbing anything else", () => {
    const { onChange } = open({ autoStop: true });

    fireEvent.click(screen.getByRole("button", { name: "Quick" }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ sensitivity: "quick", autoStop: true }) as CaptureSettingsValue,
    );
  });

  it("hides the sensitivity buttons when there is no auto-stop to tune", () => {
    // A control with nothing to act on invites the conclusion that it is
    // broken.
    open({ autoStop: false });

    expect(screen.queryByRole("group", { name: "Pause before it stops" })).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("uses real switch semantics, not styled checkboxes with no role", () => {
    /**
     * These are the settings that decide whether recording ends by itself.
     * A learner using a screen reader has to be able to find them and hear
     * their state, or the only way to discover the mode is to record.
     */
    open();

    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(3);
    for (const control of switches) expect(control).toHaveAttribute("aria-checked");
  });

  it("reports each switch's state", () => {
    open({ continuous: true, autoStop: false, interim: true });

    expect(screen.getByRole("switch", { name: /Continuous listening/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: /Auto-stop/ })).toHaveAttribute("aria-checked", "false");
  });

  it("labels every switch through its own text, making the row a tap target", () => {
    /**
     * `<label for>` forwards activation to a button, so the label and
     * description are already a real tap target — the visual track stays
     * small by design and the effective target is the whole row. On a phone
     * that is the difference between a usable control and a 20px one.
     */
    open();

    for (const name of [/Continuous listening/, /Auto-stop/, /Interim results/]) {
      const control = screen.getByRole("switch", { name });
      expect(document.querySelector(`label[for="${control.id}"]`)).toBeInTheDocument();
    }
  });

  it("marks the pressed sensitivity", () => {
    // Three buttons where one is current: aria-pressed is what says which.
    open({ autoStop: true, sensitivity: "patient" });

    expect(screen.getByRole("button", { name: "Patient" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Quick" })).toHaveAttribute("aria-pressed", "false");
  });

  it("groups the sensitivity buttons so they read as one choice", () => {
    open({ autoStop: true });

    expect(screen.getByRole("group", { name: "Pause before it stops" })).toBeInTheDocument();
  });

  it("lets each sensitivity button keep its own name", () => {
    /**
     * A real bug this test found. The heading above these three was a
     * `<label htmlFor="sens-normal">`, and `for` does not make a heading — it
     * associates the text with exactly one control and *renames* it. The
     * middle option was announced as "Pause before it stops" with the word
     * "Normal" never spoken, while Quick and Patient read correctly, so a
     * screen-reader user had two named options and one mystery. The heading is
     * now plain text that labels the group via aria-labelledby.
     */
    open({ autoStop: true });

    for (const name of ["Quick", "Normal", "Patient"]) {
      expect(screen.getByRole("button", { name }), name).toBeInTheDocument();
    }
  });

  it("starts collapsed, keeping the recording screen about recording", () => {
    // Three toggles and a mode explainer above the prompt would compete with
    // the thing the learner is there to read.
    open();

    expect(document.querySelector("details")).not.toHaveAttribute("open");
  });
});

describe("while a take is in flight", () => {
  it("disables every control", () => {
    /**
     * Switching auto-stop off mid-take would leave a recording that never
     * ends; switching it on would end one the learner was still speaking
     * into. Neither is recoverable once the audio is sent.
     */
    open({ autoStop: true }, { disabled: true });

    for (const control of screen.getAllByRole("switch")) expect(control).toBeDisabled();
    for (const name of ["Quick", "Normal", "Patient"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
    }
  });

  it("still shows what the current setting is", () => {
    // Disabled is not hidden: a learner mid-take may be checking why it has
    // not stopped yet.
    open({ autoStop: true }, { disabled: true, hangoverMs: 1200 });

    expect(screen.getByText(/Ends after 1\.2s of silence/)).toBeInTheDocument();
  });
});
