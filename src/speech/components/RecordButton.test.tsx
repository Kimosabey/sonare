// @vitest-environment jsdom
/**
 * Component coverage for RecordButton's state-to-label/disabled matrix — a
 * pure function of props, but one where a wrong branch (e.g. a disabled
 * button silently eating a tap, or the wrong handler wired to onClick) is
 * exactly the kind of regression that's invisible in a diff and only shows
 * up as "the record button doesn't do anything" days later.
 */

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecordButton } from "./RecordButton.js";

// No `test.globals` in vitest.config.ts (explicit imports throughout this
// codebase, consistent with recorder.test.ts/azureSpeech.test.ts) — Testing
// Library's auto-cleanup only registers when it detects a global `afterEach`,
// so without this each test's render would accumulate in the same jsdom
// document instead of starting fresh.
afterEach(cleanup);

describe("RecordButton", () => {
  it("idle, non-continuous: invites the first tap and calls onStart", () => {
    const onStart = vi.fn();
    render(<RecordButton state="idle" onStart={onStart} onStop={vi.fn()} />);

    const button = screen.getByRole("button", { name: "Start speaking" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("idle, continuous: labels the button for starting a session, not a single take", () => {
    render(<RecordButton state="idle" onStart={vi.fn()} onStop={vi.fn()} continuous />);
    expect(screen.getByRole("button", { name: "Start session" })).toBeInTheDocument();
  });

  it("requesting: disabled while the microphone permission is pending", () => {
    render(<RecordButton state="requesting" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Opening microphone…" })).toBeDisabled();
  });

  it("processing: disabled while the take is being scored", () => {
    render(<RecordButton state="processing" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Scoring…" })).toBeDisabled();
  });

  it("recording with autoStop: disabled (silence ends the take, a tap has nothing to do) and shows the listening indicator", () => {
    const { rerender } = render(
      <RecordButton state="recording" onStart={vi.fn()} onStop={vi.fn()} autoStop speaking={false} />,
    );
    expect(screen.getByRole("button", { name: "Listening…" })).toBeDisabled();
    expect(screen.getByText("waiting for speech")).toBeInTheDocument();

    rerender(<RecordButton state="recording" onStart={vi.fn()} onStop={vi.fn()} autoStop speaking />);
    expect(screen.getByText("heard you — pause to finish")).toBeInTheDocument();
  });

  it("recording without autoStop: enabled, and a tap calls onStop — never onStart", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(<RecordButton state="recording" onStart={onStart} onStop={onStop} autoStop={false} />);

    const button = screen.getByRole("button", { name: "Stop recording" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("error: enabled, and a tap retries via onStart — the take never actually started, so onStop must not fire", () => {
    const onStart = vi.fn();
    const onStop = vi.fn();
    render(<RecordButton state="error" onStart={onStart} onStop={onStop} />);

    const button = screen.getByRole("button", { name: "Try again" });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStop).not.toHaveBeenCalled();
  });

  it("continuous session between utterances (sessionActive): disabled — the session, not a tap, owns the mic", () => {
    render(<RecordButton state="idle" onStart={vi.fn()} onStop={vi.fn()} continuous sessionActive />);
    expect(screen.getByRole("button", { name: "Listening for the next…" })).toBeDisabled();
  });

  it("retry: labels the idle button for a second attempt rather than a first", () => {
    // "Start speaking" under a score the learner has just read describes the
    // wrong moment — they are deciding whether to go again, not starting.
    render(<RecordButton state="idle" onStart={vi.fn()} onStop={vi.fn()} retry />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("retry does not survive into the states that describe themselves", () => {
    /**
     * The label ternary checks retry *after* recording, requesting, processing
     * and sessionActive, which is the order that matters: a button reading
     * "Try again" while the microphone is live would invite a tap that stops
     * the take the learner is in the middle of.
     */
    const { rerender } = render(
      <RecordButton state="processing" onStart={vi.fn()} onStop={vi.fn()} retry />,
    );
    expect(screen.getByRole("button", { name: "Scoring…" })).toBeDisabled();

    rerender(<RecordButton state="recording" onStart={vi.fn()} onStop={vi.fn()} retry autoStop />);
    expect(screen.getByRole("button", { name: "Listening…" })).toBeInTheDocument();
  });

  it("secondary is styling only — the tap it offers is unchanged", () => {
    // Offered, not urged: after a result both going again and moving on are
    // real choices, and only one of them can be the filled one.
    const onStart = vi.fn();
    render(<RecordButton state="idle" onStart={onStart} onStop={vi.fn()} retry secondary />);

    const button = screen.getByRole("button", { name: "Try again" });
    expect(button).toHaveClass("ghost");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("never lets the quieter styling override the live-microphone treatment", () => {
    // `rec` carries the recording state's colour and pulse. A caller passing
    // secondary while the mic is open must not be able to mute that.
    render(
      <RecordButton state="recording" onStart={vi.fn()} onStop={vi.fn()} secondary />,
    );
    expect(screen.getByRole("button", { name: "Stop recording" })).toHaveClass("rec");
  });

  it("ready: busy/disabled even though the label still reads as the pre-recording prompt", () => {
    // Real, slightly surprising behavior: "ready" isn't one of the label
    // branches, so it falls through to "Start speaking" — but `busy`
    // (line 26) still disables it. Locking this in so the label ternary and
    // the disabled computation don't silently drift apart from each other.
    render(<RecordButton state="ready" onStart={vi.fn()} onStop={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Start speaking" })).toBeDisabled();
  });
});
