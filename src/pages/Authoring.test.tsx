// @vitest-environment jsdom

/**
 * The authoring screen, and the four ways it could be worse than not existing.
 *
 * It could **publish something broken**, so the publish button must be
 * unavailable while the draft has problems, and the server's own refusal must
 * end up on screen rather than being swallowed.
 *
 * It could **lose somebody's work** — two authors editing at once, the second
 * publish quietly winning. That is what `baseVersion` is for, and this screen
 * has to send the newest version it has *seen* rather than the one it loaded,
 * or rolling back would read as a conflict with itself.
 *
 * It could **be unreachable**, which is where it started: the token has to be
 * accepted once from the URL and remembered, or every visit is a retype.
 *
 * And it could **quietly publish under the wrong language**, which is why
 * switching language abandons the draft rather than carrying the fields over.
 *
 * jsdom exposes `localStorage` as a bare object with no methods, so the tests
 * install a real in-memory Storage. Not a formality: the token is read from and
 * written to it, and a stub without `setItem` would make "remembered" pass
 * against nothing.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { MemoryRouter } from "react-router-dom";
import { Authoring } from "./Authoring.js";
import { LANGUAGES } from "../activities/languages/index.js";
import { getCourse } from "../activities/courses/index.js";

let store: Map<string, string>;

function installStorage(seed?: Record<string, string>): void {
  store = new Map(Object.entries(seed ?? {}));
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const TOKEN = "s3cret-authoring-token";
const TOKEN_KEY = "sonare.diagnosticsToken";

function language(index: number) {
  const found = LANGUAGES[index];
  if (found === undefined) throw new Error(`no language at ${index}`);
  return found;
}

const FIRST = language(0);
/** The language switched to, to prove the draft does not travel with it. */
const SECOND = language(1);

interface Reply {
  status: number;
  body?: unknown;
}

/** Every request the component made, so the payload can be asserted on. */
let calls: { url: string; init?: RequestInit }[];
/** Keyed by a fragment of the URL, first match wins. */
let replies: [string, Reply][];

function respond(url: string): Reply {
  const found = replies.find(([fragment]) => url.includes(fragment));
  return found?.[1] ?? { status: 404, body: {} };
}

function version(over: Record<string, unknown> = {}) {
  return { version: 1, publishedAt: "2026-01-01T10:00:00.000Z", activityCount: 10, ...over };
}

function publishedSet(over: Record<string, unknown> = {}) {
  return {
    slug: FIRST.slug,
    code: FIRST.code,
    label: FIRST.label,
    version: 1,
    activities: [
      {
        id: 1,
        title: "Greeting",
        kind: "repeat",
        prompt: "Say hello",
        gloss: "hello",
        target: "Bonjour",
        focus: "the r",
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  installStorage();
  calls = [];
  replies = [[`/content/${FIRST.slug}/versions`, { status: 200, body: { versions: [] } }]];

  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const reply = respond(url);
      return Promise.resolve({
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        json: () => Promise.resolve(reply.body ?? {}),
      } as Response);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function open(search = `?token=${TOKEN}`) {
  return render(
    <MemoryRouter initialEntries={[`/authoring${search}`]}>
      <Authoring />
    </MemoryRouter>,
  );
}

/**
 * The first activity's field of that name. Every activity carries a label per
 * field, so a bundled set of ten means ten labels reading "target" — the row
 * has to be chosen rather than assumed unique.
 */
function field(name: string, row = 0): HTMLElement {
  const found = screen.getAllByLabelText(name)[row];
  if (found === undefined) throw new Error(`no ${name} field in row ${row}`);
  return found;
}

/** The POST body the component sent, parsed. */
function publishedPayload() {
  const call = calls.find((c) => c.init?.method === "POST");
  if (call === undefined) throw new Error("nothing was published");
  return JSON.parse(String(call.init?.body)) as {
    baseVersion: number;
    label: string;
    activities: { id: number; target: string; soundTargets: string[] }[];
    units?: { id: number; lessons: { id: number; activityIds: number[] }[] }[];
  };
}

describe("reaching the screen", () => {
  it("remembers a token passed once in the URL", async () => {
    // Otherwise every visit is a retype, which is how an internal tool becomes
    // one only the person who wrote it uses.
    open();

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(store.get(TOKEN_KEY)).toBe(TOKEN);
  });

  it("sends the remembered token on a later visit with no token in the URL", async () => {
    installStorage({ [TOKEN_KEY]: TOKEN });

    open("");

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers["x-diagnostics-token"]).toBe(TOKEN);
  });

  it("says what to do when the server refuses the request", async () => {
    replies = [[`/versions`, { status: 401, body: { error: "unauthorized" } }]];

    open("");

    expect(await screen.findByRole("alert")).toHaveTextContent(/requires a token/i);
  });

  it("says the server is unreachable rather than showing an empty history", async () => {
    /**
     * An empty list reads as "nothing has ever been published", which is the
     * cue to start a first draft over the top of real content.
     */
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));

    open();

    expect(await screen.findByRole("alert")).toHaveTextContent(/Couldn’t reach the content API/);
  });
});

describe("the version history", () => {
  it("lists what is published, and marks which one is live", async () => {
    replies = [
      [
        `/versions`,
        { status: 200, body: { versions: [version({ version: 2 }), version({ version: 1 })] } },
      ],
    ];

    open();

    expect(await screen.findByText("live")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Load" })).toHaveLength(2);
  });

  it("offers the bundled set as the starting point when nothing is published", async () => {
    /**
     * The honest first draft for a language nobody has published: it is what
     * every learner is using right now.
     */
    open();

    await screen.findByText(/Nothing published for this language yet/);
    fireEvent.click(screen.getByRole("button", { name: /Start from the bundled set/ }));

    expect(screen.getByLabelText("Label")).toHaveValue(FIRST.label);
    expect(screen.getByLabelText("Locale")).toHaveValue(FIRST.code);
    const first = FIRST.activities[0];
    if (first === undefined) throw new Error("need an activity");
    expect(field("target")).toHaveValue(first.target);
  });

  it("loads a published version into the editor", async () => {
    replies = [
      [`/versions/1`, { status: 200, body: publishedSet() }],
      [`/versions`, { status: 200, body: { versions: [version()] } }],
    ];

    open();

    fireEvent.click(await screen.findByRole("button", { name: "Load" }));

    await waitFor(() => expect(field("target")).toHaveValue("Bonjour"));
    expect(screen.getByText(/Editing version 1/)).toBeInTheDocument();
  });
});

describe("what may be published", () => {
  async function openWithBundle() {
    open();
    await screen.findByText(/Nothing published/);
    fireEvent.click(screen.getByRole("button", { name: /Start from the bundled set/ }));
  }

  it("offers to publish the next version, not to change the current one", async () => {
    /**
     * The property the whole content store is built on: a correction is a new
     * version, so a learner mid-session keeps the words they started being
     * scored against. There is deliberately no control here that edits one.
     */
    replies = [[`/versions`, { status: 200, body: { versions: [version({ version: 3 })] } }]];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));

    expect(screen.getByRole("button", { name: "Publish as version 4" })).toBeEnabled();
  });

  it("will not publish a draft with a problem in it", async () => {
    // The check that stops this screen being a foot-gun. An empty target is
    // speech scored against nothing.
    await openWithBundle();

    fireEvent.change(field("target"), { target: { value: "" } });

    expect(screen.getByRole("button", { name: /Publish as version/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/target cannot be empty/);
  });

  it("names the row a problem is in", async () => {
    await openWithBundle();

    const ids = screen.getAllByLabelText("id");
    const second = ids[1];
    if (second === undefined) throw new Error("need two activities");
    fireEvent.change(second, { target: { value: "1" } });

    expect(screen.getByRole("status")).toHaveTextContent(/activity 2: id 1 is already used/);
  });

  it("offers only the kinds the UI can render", async () => {
    /**
     * A select rather than a text field. A mistyped kind is accepted by
     * nothing downstream and renders as a blank task, so it is the one field
     * that should not be free text.
     */
    await openWithBundle();

    const kind = screen.getAllByLabelText("kind")[0];
    expect(kind?.tagName).toBe("SELECT");
    expect(screen.getAllByRole("option", { name: "respond" }).length).toBeGreaterThan(0);
  });

  it("becomes publishable again once the problem is fixed", async () => {
    await openWithBundle();
    fireEvent.change(field("target"), { target: { value: "" } });

    fireEvent.change(field("target"), { target: { value: "Bonsoir" } });
    // The bundled row's sound targets are syllables of the phrase it had. A
    // replaced phrase needs replaced syllables, or none — see the test below.
    fireEvent.change(field("soundTargets"), { target: { value: "" } });

    expect(screen.getByRole("button", { name: /Publish as version/ })).toBeEnabled();
  });

  it("refuses a phrase whose sound targets no longer occur in it", async () => {
    /**
     * The likeliest way a mapping rots: somebody corrects a phrase and leaves
     * the syllables alone. Nothing about that looks wrong in the editor — the
     * list is still full of plausible French — but not one of those syllables
     * can come back from the scorer any more, so the activity quietly stops
     * being schedulable while continuing to claim it is.
     */
    await openWithBundle();

    fireEvent.change(field("target"), { target: { value: "Bonsoir" } });

    expect(screen.getByRole("button", { name: /Publish as version/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent(/does not appear in the target/);
  });
});

describe("publishing", () => {
  it("sends the edited set and reports the version it created", async () => {
    replies = [
      [`/versions`, { status: 200, body: { versions: [] } }],
      [`/content/${FIRST.slug}`, { status: 201, body: { slug: FIRST.slug, version: 1 } }],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));
    fireEvent.change(field("target"), { target: { value: "Bonsoir!" } });
    fireEvent.change(field("soundTargets"), { target: { value: "bon, soir" } });
    fireEvent.click(screen.getByRole("button", { name: "Publish as version 1" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Published version 1/);
    expect(publishedPayload().activities[0]?.target).toBe("Bonsoir!");
    // The syllables travel with the phrase, folded to what the skills store
    // actually keys on.
    expect(publishedPayload().activities[0]?.soundTargets).toEqual(["bon", "soir"]);
  });

  it("says earlier versions are untouched, because they are", async () => {
    replies = [
      [`/versions`, { status: 200, body: { versions: [version()] } }],
      [`/content/${FIRST.slug}`, { status: 201, body: { version: 2 } }],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));
    fireEvent.click(screen.getByRole("button", { name: "Publish as version 2" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Earlier versions are untouched/);
  });

  it("sends the newest version it has seen, not the one it loaded", async () => {
    /**
     * `baseVersion` is what stops the plain lost update, and it has to mean
     * "the newest I knew about" rather than "the one in the editor" — because
     * loading version 1 while 2 is current and publishing it forward is the
     * documented way to roll back, and that must not read as a conflict with
     * itself.
     */
    replies = [
      [`/versions/1`, { status: 200, body: publishedSet() }],
      [
        `/${FIRST.slug}/versions`,
        { status: 200, body: { versions: [version({ version: 2 }), version({ version: 1 })] } },
      ],
      [`/content/${FIRST.slug}`, { status: 201, body: { version: 3 } }],
    ];

    open();
    const loads = await screen.findAllByRole("button", { name: "Load" });
    const older = loads[1];
    if (older === undefined) throw new Error("need two versions");
    fireEvent.click(older);

    await waitFor(() => expect(screen.getByText(/Editing version 1/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Publish as version 3" }));

    await waitFor(() => expect(publishedPayload().baseVersion).toBe(2));
  });

  it("shows the server's own refusal rather than deciding it knows better", async () => {
    /**
     * The server is the gate. If the client-side mirror in draft.ts has
     * drifted, this is the only place that would reveal it — and the author
     * needs the reason that actually applies, not the one this screen guessed.
     */
    replies = [
      [`/versions`, { status: 200, body: { versions: [] } }],
      [
        `/content/${FIRST.slug}`,
        { status: 422, body: { problems: ["activity 4: gloss cannot be empty"] } },
      ],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));
    fireEvent.click(screen.getByRole("button", { name: /Publish as version/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/The server refused this set/);
    expect(alert).toHaveTextContent(/activity 4: gloss cannot be empty/);
  });

  it("tells an author to reload when somebody else published first", async () => {
    replies = [
      [`/versions`, { status: 200, body: { versions: [version()] } }],
      [
        `/content/${FIRST.slug}`,
        {
          status: 409,
          body: { error: { userMessage: "Somebody else published while you were editing." } },
        },
      ],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));
    fireEvent.click(screen.getByRole("button", { name: /Publish as version/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Somebody else published/);
  });

  it("says nothing was published when the request never landed", async () => {
    // "Publishing failed" leaves an author wondering whether to retry into a
    // half-written state. There isn't one — the write is a single insert.
    replies = [[`/versions`, { status: 200, body: { versions: [] } }]];
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
    fireEvent.click(screen.getByRole("button", { name: /Publish as version/ }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/Nothing was published/);
  });
});

describe("switching language", () => {
  it("abandons the draft rather than carrying the fields across", async () => {
    /**
     * Publishing one language's phrases under another's slug is the one mistake
     * this screen must not make easy, and a form that kept its contents across
     * a language change would make it a single click.
     */
    replies = [[`/versions`, { status: 200, body: { versions: [] } }]];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));
    expect(screen.getByLabelText("Label")).toHaveValue(FIRST.label);

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: SECOND.slug } });

    await waitFor(() => expect(screen.queryByLabelText("Label")).not.toBeInTheDocument());
  });

  it("asks the server about the language now selected", async () => {
    open();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: SECOND.slug } });

    await waitFor(() =>
      expect(calls.some((c) => c.url.includes(`/content/${SECOND.slug}/versions`))).toBe(true),
    );
  });

  it("seeds from the bundle rather than from served content", async () => {
    /**
     * `getLanguage`, not the resolver. Seeding from the resolver's cache would
     * open a draft labelled "the set built into the app" that was actually a
     * possibly-stale copy of something already published.
     */
    open();
    await screen.findByText(/Nothing published/);

    fireEvent.click(screen.getByRole("button", { name: /Start from the bundled set/ }));

    expect(screen.getAllByLabelText("id")).toHaveLength(FIRST.activities.length);
  });
});

/**
 * The course spine, captured rather than assumed.
 *
 * The screen has to be able to author what the gate accepts. If it could not,
 * the spine would only ever arrive by running a script from a checkout — which
 * is the exact situation this screen exists to end, and it would be invisible
 * because everything else on the screen would keep working.
 */
describe("authoring the course spine", () => {
  const COURSE = getCourse(FIRST.slug);

  it("offers the authored course as a starting point, spine and all", async () => {
    if (COURSE === undefined) throw new Error("expected a course for the first language");

    open();
    await screen.findByText(/Nothing published/);
    fireEvent.click(screen.getByRole("button", { name: /Start from the course set/ }));

    expect(screen.getByText(/Editing the course built into the app/)).toBeInTheDocument();
    expect(screen.getAllByLabelText("id")).toHaveLength(COURSE.activities.length);
    expect(screen.getAllByLabelText("unit id")).toHaveLength(COURSE.units?.length ?? 0);
    const lessons = COURSE.units?.flatMap((u) => u.lessons) ?? [];
    expect(screen.getAllByLabelText("lesson id")).toHaveLength(lessons.length);
  });

  it("offers no course shortcut for a language that has none", async () => {
    // Spanish and Hindi are deliberately still flat, and a button promising a
    // course that does not exist would be worse than no button.
    open();
    await screen.findByText(/Nothing published/);

    fireEvent.change(screen.getByLabelText("Language"), { target: { value: "hi" } });

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Start from the course set/ })).toBeNull(),
    );
  });

  it("publishes the spine it was shown, activity ids and all", async () => {
    if (COURSE === undefined) throw new Error("expected a course for the first language");
    replies = [
      [`/versions`, { status: 200, body: { versions: [] } }],
      [`/content/${FIRST.slug}`, { status: 201, body: { version: 1 } }],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the course set/ }));
    fireEvent.click(screen.getByRole("button", { name: /Publish as version/ }));

    await screen.findByRole("alert");
    expect(publishedPayload().units).toEqual(COURSE.units);
  });

  it("names a spine problem by the unit and lesson it is in", async () => {
    /**
     * A lesson is one sitting. Emptying its activity list is the fastest way
     * to a set that publishes and then ends a sitting on a blank screen, so it
     * has to be refused before the round trip, and named where an author can
     * find it.
     */
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the course set/ }));

    const lists = screen.getAllByLabelText("lesson activities");
    const first = lists[0];
    if (first === undefined) throw new Error("need a lesson");
    fireEvent.change(first, { target: { value: "" } });

    expect(screen.getByRole("status")).toHaveTextContent(/unit 1 lesson 1: 0 activities/);
    expect(screen.getByRole("button", { name: /Publish as version/ })).toBeDisabled();
  });

  it("adds a unit whose lesson is numbered against every other lesson", async () => {
    /**
     * Lesson ids are unique across the language, not per unit — a finished
     * sitting is recorded by lesson id alone. Numbering a new one against its
     * own unit would hand out an id another unit already uses, and the two
     * sittings would share a record.
     */
    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the course set/ }));

    const before = screen.getAllByLabelText("lesson id").map((input) => (input as HTMLInputElement).value);
    fireEvent.click(screen.getByRole("button", { name: "Add a unit" }));

    const after = screen.getAllByLabelText("lesson id").map((input) => (input as HTMLInputElement).value);
    const added = after.filter((id) => !before.includes(id));
    expect(added).toHaveLength(1);
    expect(new Set(after).size).toBe(after.length);
  });

  it("lets a flat set stay flat — no spine is a set, not an unfinished one", async () => {
    replies = [
      [`/versions`, { status: 200, body: { versions: [] } }],
      [`/content/${FIRST.slug}`, { status: 201, body: { version: 1 } }],
    ];

    open();
    fireEvent.click(await screen.findByRole("button", { name: /Start from the bundled set/ }));

    expect(screen.queryAllByLabelText("unit id")).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Publish as version/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /Publish as version/ }));
    await screen.findByRole("alert");
    expect(publishedPayload().units).toBeUndefined();
  });
});
