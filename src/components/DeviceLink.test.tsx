// @vitest-environment jsdom

/**
 * Linking a second device, from the You tab.
 *
 * A link code grants full read, write and delete of a learner's record for ten
 * minutes, so most of what matters here is about how one is handled rather
 * than about the happy path:
 *
 *  - **An expired code stops existing.** Left on screen it is one a learner
 *    will type and be refused by, with no way to tell that from a typo.
 *  - **The countdown runs on elapsed time**, not on a server timestamp — a
 *    phone whose clock is a day out must not show "expires in 23:59:41" over a
 *    code that dies in ten minutes.
 *  - **It is a link, not a transfer**, and the copy has to say so: "transfer"
 *    makes people hesitate to link the device they still use.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceLink } from "./DeviceLink.js";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH, formatLinkCode } from "../lib/linkCode.js";

const CODE = LINK_CODE_ALPHABET.slice(0, LINK_CODE_LENGTH);
const ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

let token: string | null = "a.b.c";
vi.mock("../sync/tokenStore.js", async () => {
  const actual = await vi.importActual<typeof import("../sync/tokenStore.js")>(
    "../sync/tokenStore.js",
  );
  return { ...actual, readToken: () => token };
});

const mintResult = vi.fn();
const claimResult = vi.fn();
vi.mock("../sync/deviceLink.js", () => ({
  mintCode: () => mintResult(),
  claimCode: (code: string) => claimResult(code),
}));

function show() {
  render(<DeviceLink learnerName="marie" />);
}

beforeEach(() => {
  token = "a.b.c";
  mintResult.mockReset();
  claimResult.mockReset();
  mintResult.mockResolvedValue({
    ok: true,
    minted: { code: CODE, expiresInSeconds: 600, expiresAt: Date.now() + 600_000 },
  });
  claimResult.mockResolvedValue({ ok: true, learnerId: ID });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("showing a code", () => {
  it("shows it grouped, the way it will be read aloud", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Show me a code/i }));

    expect(await screen.findByLabelText(/Your link code/i)).toHaveTextContent(
      formatLinkCode(CODE),
    );
  });

  it("counts down in minutes and seconds", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: /Show me a code/i }));

    expect(await screen.findByText(/within 9:5\d|within 10:00/)).toBeInTheDocument();
  });

  /**
   * The countdown is elapsed-time based. A device whose clock is a day out
   * would otherwise render an expiry from a server timestamp it cannot
   * reconcile — the elapsed answer is right even when the wall clock is not.
   */
  it("clears the code once it expires, rather than leaving a dead one up", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mintResult.mockResolvedValue({
      ok: true,
      minted: { code: CODE, expiresInSeconds: 2, expiresAt: Date.now() + 2000 },
    });

    show();
    fireEvent.click(screen.getByRole("button", { name: /Show me a code/i }));
    await screen.findByLabelText(/Your link code/i);

    await act(async () => {
      vi.advanceTimersByTime(3000);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByLabelText(/Your link code/i)).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Show me a code/i })).toBeInTheDocument();
  });

  /**
   * A device with no credential has nothing to hand a second one. Said plainly
   * rather than by letting the request fail with a generic message.
   */
  it("says so when this device has no history to share", async () => {
    token = null;
    show();
    fireEvent.click(screen.getByRole("button", { name: /Show me a code/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/no practice history/i);
    expect(mintResult).not.toHaveBeenCalled();
  });

  it("shows the server's own wording when minting fails", async () => {
    mintResult.mockResolvedValue({ ok: false, message: "Could not reach the server." });
    show();
    fireEvent.click(screen.getByRole("button", { name: /Show me a code/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server.");
  });
});

describe("typing a code", () => {
  it("links the device and says it worked", async () => {
    show();
    fireEvent.change(screen.getByLabelText(/code from your other device/i), {
      target: { value: formatLinkCode(CODE) },
    });
    fireEvent.click(screen.getByRole("button", { name: /Link this device/i }));

    expect(await screen.findByText(/shares your practice history/i)).toBeInTheDocument();
  });

  it("passes the code through as typed, for the client to normalise", async () => {
    show();
    fireEvent.change(screen.getByLabelText(/code from your other device/i), {
      target: { value: formatLinkCode(CODE).toLowerCase() },
    });
    fireEvent.click(screen.getByRole("button", { name: /Link this device/i }));

    await waitFor(() => expect(claimResult).toHaveBeenCalled());
    expect(claimResult.mock.calls[0]?.[0]).toBe(formatLinkCode(CODE).toLowerCase());
  });

  it("reports a refusal in the server's words", async () => {
    claimResult.mockResolvedValue({ ok: false, message: "That code is not valid any more." });
    show();
    fireEvent.change(screen.getByLabelText(/code from your other device/i), {
      target: { value: "nope" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Link this device/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("That code is not valid any more.");
  });
});

describe("what the copy promises", () => {
  /**
   * "Transfer" would make a learner hesitate to link the device they still
   * use. Both devices keep the id and the merge layer combines their records,
   * so nothing stops working — and the screen has to say that before somebody
   * decides not to risk it.
   */
  it("says linking is not a move", () => {
    show();

    expect(screen.getByText(/link rather than a move/i)).toBeInTheDocument();
    expect(screen.queryByText(/transfer/i)).not.toBeInTheDocument();
  });
});
