// @vitest-environment jsdom

/**
 * A pupil joining a class, end to end — and what leaves the device on the way.
 *
 * `JoinClass` has its own suite and so does `MyClass`; this is the flow that
 * wires them to the network, and it had none. The properties worth holding are
 * not about what renders. They are about what is *sent*, and by whom, and
 * when — so every assertion below reads the actual `fetch` call rather than
 * asking which helper was invoked. A helper can be right and the flow can
 * still call it with the wrong argument, which is exactly the class of mistake
 * that puts a child's name somewhere they said it should not go.
 *
 * Three properties, in the order they matter:
 *
 * **Looking up a code tells nobody anything.** The flow's own header says the
 * preview is unauthenticated and returns only the class's name, the teacher's
 * name and the language, so a pupil who types a code and changes their mind
 * has told nobody anything. That is a claim about a request, and a request is
 * a thing a test can read.
 *
 * **"Not now" is not a soft no.** The decision screen exists so a pupil sees
 * the consequences before agreeing. If declining still reached the join
 * endpoint, the screen would be a formality over a decision already taken.
 *
 * **"Join without my name" withholds the name.** The flow passes
 * `shareName ? learnerName : null` — one ternary between a pupil's choice and
 * their name appearing on a teacher's screen. It is the single most
 * consequential expression in this file and nothing checked it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JoinClassFlow } from "./JoinClassFlow.js";
import { saveToken, clearToken } from "../sync/tokenStore.js";
import { LINK_CODE_ALPHABET, LINK_CODE_LENGTH } from "../lib/linkCode.js";

const LEARNER = "Maya";
/**
 * A code the client will actually send.
 *
 * Built from the real alphabet at the real length rather than typed out: a
 * literal that fails `normaliseLinkCode` is rejected before any request, and
 * every assertion about what was sent then passes against nothing having been
 * sent at all. The first version of this file used a six-character invention
 * and six tests went green on an empty call list.
 */
const CODE = LINK_CODE_ALPHABET.slice(0, LINK_CODE_LENGTH);

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let calls: Call[] = [];

/** A fetch that records what was sent and answers per endpoint. */
function installFetch(over: Partial<Record<string, { status: number; json: unknown }>> = {}): void {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const headers = (init.headers ?? {}) as Record<string, string>;
      let body: unknown;
      try {
        body = JSON.parse(String(init.body ?? "null"));
      } catch {
        // A non-JSON body is still worth recording — an assertion about what
        // was sent should fail on the content, not on the parse.
        body = String(init.body ?? "");
      }
      calls.push({ url: String(url), headers, body });

      const path = String(url);
      const canned = Object.entries(over).find(([key]) => path.includes(key))?.[1];
      if (canned) {
        return {
          ok: canned.status >= 200 && canned.status < 300,
          status: canned.status,
          json: async () => canned.json,
        } as Response;
      }
      if (path.includes("/classes/preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            classId: "c-9f2a",
            name: "Year 9 French",
            teacherName: "Mr Okonjo",
            slug: "fr",
          }),
        } as Response;
      }
      if (path.includes("/classes/join")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ classId: "c-9f2a", className: "Year 9 French", slug: "fr" }),
        } as Response;
      }
      // Membership list on mount.
      return { ok: true, status: 200, json: async () => ({ classes: [] }) } as Response;
    }),
  );
}

function installStorage(): void {
  const data = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
}

function open() {
  return render(<JoinClassFlow learnerName={LEARNER} />);
}

/** Type a code and look it up, which is the only route to the decision. */
async function lookUp(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Class code/i), { target: { value: CODE } });
  fireEvent.click(screen.getByRole("button", { name: /Look up the class/i }));
  await waitFor(() => {
    expect(screen.getByRole("button", { name: /^Join the class$/i })).toBeInTheDocument();
  });
}

const to = (fragment: string): Call[] => calls.filter((call) => call.url.includes(fragment));

beforeEach(() => {
  vi.clearAllMocks();
  installStorage();
  installFetch();
  saveToken(LEARNER, "a.b.c");
});

afterEach(() => {
  clearToken(LEARNER);
  cleanup();
});

describe("looking a class up", () => {
  it("sends the code and nothing about the pupil", async () => {
    open();
    await lookUp();

    const preview = to("/classes/preview");
    expect(preview).toHaveLength(1);

    const sent = JSON.stringify(preview[0]?.body ?? {});
    expect(sent).not.toMatch(new RegExp(LEARNER, "i"));
    expect(Object.keys(preview[0]?.body as object)).toEqual(["code"]);
  });

  /**
   * And carries no credential. An authenticated preview would let the server
   * record that this learner looked at this class, which is the record the
   * unauthenticated preview exists so as not to keep.
   */
  it("sends no token, so looking is not an act the server can attribute", async () => {
    open();
    await lookUp();

    const headers = to("/classes/preview")[0]?.headers ?? {};
    const names = Object.keys(headers).map((name) => name.toLowerCase());

    expect(names).not.toContain("authorization");
    expect(names).not.toContain("x-diagnostics-token");
  });
});

describe("deciding", () => {
  it("joins nothing when the pupil says not now", async () => {
    open();
    await lookUp();

    fireEvent.click(screen.getByRole("button", { name: /Not now/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Look up the class/i })).toBeInTheDocument();
    });
    expect(to("/classes/join")).toHaveLength(0);
  });

  /**
   * The ternary. A pupil who chooses to join without their name must have
   * `sharedName: null` on the wire — not an empty string, not the name, not
   * omitted in a way the server fills in.
   */
  it("withholds the name when the pupil joins without it", async () => {
    open();
    await lookUp();

    fireEvent.click(screen.getByRole("button", { name: /Join without my name/i }));

    await waitFor(() => {
      expect(to("/classes/join")).toHaveLength(1);
    });
    const body = to("/classes/join")[0]?.body as { sharedName: unknown };

    expect(body.sharedName).toBeNull();
    expect(JSON.stringify(body)).not.toMatch(new RegExp(LEARNER, "i"));
  });

  /**
   * The other side of the same ternary, and not a formality: a flow that sent
   * `null` both ways would pass the test above while quietly making the choice
   * meaningless — every pupil anonymous, including the ones who chose not to
   * be.
   */
  it("sends the name when the pupil chooses to share it", async () => {
    open();
    await lookUp();

    fireEvent.click(screen.getByRole("button", { name: /^Join the class$/i }));

    await waitFor(() => {
      expect(to("/classes/join")).toHaveLength(1);
    });
    const body = to("/classes/join")[0]?.body as { sharedName: unknown };

    expect(body.sharedName).toBe(LEARNER);
  });

  /**
   * Order. The decision screen has to sit between looking up and joining, or
   * typing a code becomes the act of joining — which is the one thing the
   * three-state design exists to prevent.
   */
  it("reaches the join endpoint only after the pupil has seen what they are agreeing to", async () => {
    open();

    fireEvent.change(screen.getByLabelText(/Class code/i), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: /Look up the class/i }));

    await waitFor(() => {
      expect(to("/classes/preview")).toHaveLength(1);
    });
    expect(to("/classes/join")).toHaveLength(0);
  });
});

describe("when the code is wrong", () => {
  it("says so without joining anything", async () => {
    installFetch({ "/classes/preview": { status: 404, json: { message: "No class found" } } });
    saveToken(LEARNER, "a.b.c");
    open();

    fireEvent.change(screen.getByLabelText(/Class code/i), { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: /Look up the class/i }));

    const alert = await screen.findByRole("alert");

    expect(alert.textContent ?? "").not.toBe("");
    expect(to("/classes/join")).toHaveLength(0);
    // Still on the code step, with nothing to agree to.
    expect(screen.queryByRole("button", { name: /^Join the class$/i })).toBeNull();
  });
});
