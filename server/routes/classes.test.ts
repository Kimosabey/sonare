/**
 * The class endpoints.
 *
 * The teacher board's identity model decides most of what is worth testing
 * here: "a class is pupils choosing to attach themselves, never a list a
 * teacher types in about children". So the properties are about who may write
 * what, and about what a pupil is shown *before* they have agreed to anything.
 *
 * Real Express on an ephemeral port; the store is mocked, because what is
 * under test is the routes' handling rather than Mongo.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

const store = {
  createClass: vi.fn(),
  regenerateCode: vi.fn(),
  previewByCode: vi.fn(),
  joinClass: vi.fn(),
  leaveClass: vi.fn(),
  readClass: vi.fn(),
  membersOf: vi.fn(),
};

vi.mock("../logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../rateLimit.js", () => ({
  diagnosticsLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
  scoringLimiter: (_q: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../db.js", () => ({ getDb: () => Promise.resolve({}) }));
vi.mock("../store/classes.js", () => store);
vi.mock("../store/skills.js", () => ({ readSkills: () => Promise.resolve(null) }));
vi.mock("../store/progress.js", () => ({ readProgress: () => Promise.resolve(null) }));

/**
 * A learner id is present when the header says so, so auth can be exercised.
 *
 * Partial rather than whole: other modules in the graph import the rest of
 * this middleware, and replacing the module outright removed exports nobody
 * in this file uses but the app still needs.
 */
vi.mock("../middleware/identity.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireLearner: (req: { headers: Record<string, string> }, res: { locals: Record<string, unknown>; status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    const id = req.headers["x-test-learner"];
    if (id === undefined) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED" } });
      return;
    }
    res.locals.learnerId = id;
    next();
  },
  learnerIdFrom: (res: { locals: { learnerId?: unknown } }) =>
    typeof res.locals.learnerId === "string" ? res.locals.learnerId : null,
}));

const TOKEN = "s3cret-authoring-token";
const ORIGINAL = process.env.DIAGNOSTICS_TOKEN;
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  const express = (await import("express")).default;
  const { classesRouter } = await import("./classes.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1", classesRouter);
  await new Promise<void>((ready) => {
    server = app.listen(0, () => ready());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (ORIGINAL === undefined) delete process.env.DIAGNOSTICS_TOKEN;
  else process.env.DIAGNOSTICS_TOKEN = ORIGINAL;
  await new Promise<void>((done) => server.close(() => done()));
});

beforeEach(() => {
  process.env.DIAGNOSTICS_TOKEN = TOKEN;
  store.createClass.mockResolvedValue({ classId: "c1", code: "ABCDE-FGHJK" });
  store.previewByCode.mockResolvedValue({
    classId: "c1",
    name: "Year 9 French",
    teacherName: "Mr Okonjo",
    slug: "fr",
  });
  store.joinClass.mockResolvedValue({ ok: true, classId: "c1", alreadyMember: false });
  store.readClass.mockResolvedValue({
    _id: "c1",
    name: "Year 9 French",
    teacherName: "Mr Okonjo",
    slug: "fr",
    expectedCount: 31,
  });
  store.membersOf.mockResolvedValue([]);
});

afterEach(() => vi.clearAllMocks());

const auth = { "x-diagnostics-token": TOKEN, "content-type": "application/json" };
const pupil = { "x-test-learner": "learner-1", "content-type": "application/json" };

function post(path: string, body: unknown, headers: Record<string, string>) {
  return fetch(`${base}/api/v1${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("creating a class", () => {
  it("returns the join code once", async () => {
    const response = await post(
      "/classes",
      { name: "Year 9 French", teacherName: "Mr Okonjo", slug: "fr" },
      auth,
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ classId: "c1", code: "ABCDE-FGHJK" });
  });

  it("is closed without the operator token", async () => {
    const response = await post(
      "/classes",
      { name: "Year 9 French", teacherName: "Mr Okonjo", slug: "fr" },
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(401);
    expect(store.createClass).not.toHaveBeenCalled();
  });

  it("refuses a class with no name, teacher or language", async () => {
    for (const body of [
      { teacherName: "Mr Okonjo", slug: "fr" },
      { name: "Year 9", slug: "fr" },
      { name: "Year 9", teacherName: "Mr Okonjo" },
      { name: "  ", teacherName: "Mr Okonjo", slug: "fr" },
      { name: "Year 9", teacherName: "Mr Okonjo", slug: "NOT A SLUG" },
    ]) {
      const response = await post("/classes", body, auth);
      expect(response.status).toBe(400);
    }
    expect(store.createClass).not.toHaveBeenCalled();
  });
});

describe("previewing a class by code", () => {
  /**
   * Unauthenticated by necessity: a pupil typing a code off a board has no
   * relationship with the class yet.
   */
  it("needs no credential", async () => {
    const response = await post("/classes/preview", { code: "ABCDE-FGHJK" }, {
      "content-type": "application/json",
    });

    expect(response.status).toBe(200);
  });

  /**
   * The pupil has agreed to nothing at this point, so the response carries the
   * class's own details and not one fact about anybody in it. "How many have
   * joined" is a fact about other pupils.
   */
  it("reveals the class and nothing about its members", async () => {
    const response = await post("/classes/preview", { code: "ABCDE-FGHJK" }, {
      "content-type": "application/json",
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["classId", "name", "slug", "teacherName"]);
  });

  /**
   * The code goes in the body even though this is a read. A query string
   * reaches server logs, proxy logs and browser history — the same reasoning
   * `deviceLink.ts` follows.
   */
  it("takes the code in the body, never the URL", async () => {
    await post("/classes/preview", { code: "ABCDE-FGHJK" }, { "content-type": "application/json" });

    expect(store.previewByCode).toHaveBeenCalledWith("ABCDE-FGHJK");
  });

  it("says the code does not match rather than failing silently", async () => {
    store.previewByCode.mockResolvedValue(null);

    const response = await post("/classes/preview", { code: "NOPE" }, {
      "content-type": "application/json",
    });

    expect(response.status).toBe(404);
  });
});

describe("joining", () => {
  it("attaches the pupil who asked, not one the body names", async () => {
    await post("/classes/join", { code: "ABCDE-FGHJK", learnerId: "somebody-else" }, pupil);

    expect(store.joinClass).toHaveBeenCalledWith("ABCDE-FGHJK", "learner-1", null);
  });

  it("needs the pupil's own credential", async () => {
    const response = await post("/classes/join", { code: "ABCDE-FGHJK" }, {
      "content-type": "application/json",
    });

    expect(response.status).toBe(401);
    expect(store.joinClass).not.toHaveBeenCalled();
  });

  /**
   * Joining without a name is recorded as null rather than as an absent field,
   * so "chose not to share" is a decision in the data rather than something
   * that looks like a bug somebody might later fill in.
   */
  it("records joining without a name as a decision", async () => {
    await post("/classes/join", { code: "ABCDE-FGHJK", sharedName: "   " }, pupil);

    expect(store.joinClass).toHaveBeenCalledWith("ABCDE-FGHJK", "learner-1", null);
  });

  it("carries a shared name through when one was given", async () => {
    await post("/classes/join", { code: "ABCDE-FGHJK", sharedName: " Maya " }, pupil);

    expect(store.joinClass).toHaveBeenCalledWith("ABCDE-FGHJK", "learner-1", "Maya");
  });

  /**
   * Idempotent. A pupil on a flaky connection who taps join twice must not be
   * counted twice in the figure their teacher plans a lesson from.
   */
  it("treats a repeat join as success rather than an error", async () => {
    store.joinClass.mockResolvedValue({ ok: true, classId: "c1", alreadyMember: true });

    const response = await post("/classes/join", { code: "ABCDE-FGHJK" }, pupil);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { alreadyMember: boolean }).alreadyMember).toBe(true);
  });

  it("has no route by which a teacher adds a pupil", async () => {
    // The only membership write is the pupil's own. A teacher token on the
    // join route is not a pupil credential and is refused.
    const response = await post("/classes/join", { code: "ABCDE-FGHJK" }, auth);
    expect(response.status).toBe(401);
  });
});

describe("the class summary", () => {
  it("is behind the operator token", async () => {
    const response = await fetch(`${base}/api/v1/classes/c1/summary`);
    expect(response.status).toBe(401);
  });

  it("returns the class name and what the teacher expects, with a summary", async () => {
    const response = await fetch(`${base}/api/v1/classes/c1/summary`, { headers: auth });

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.className).toBe("Year 9 French");
    expect(body.expectedCount).toBe(31);
    expect(body.summary).toBeDefined();
  });

  /**
   * The response is built from member records and must carry none of their
   * ids. `summariseClass` guarantees it from its side; this asserts the route
   * did not add one back on the way out.
   */
  it("carries no learner id", async () => {
    store.membersOf.mockResolvedValue([
      { classId: "c1", learnerId: "learner-aaa", sharedName: null, joinedAt: new Date() },
      { classId: "c1", learnerId: "learner-bbb", sharedName: "Maya", joinedAt: new Date() },
    ]);

    const response = await fetch(`${base}/api/v1/classes/c1/summary`, { headers: auth });
    const text = await response.text();

    expect(text).not.toContain("learner-aaa");
    expect(text).not.toContain("learner-bbb");
    // And not the name a pupil shared, which belongs to the roster rather than
    // to the group figures this endpoint reports.
    expect(text).not.toContain("Maya");
  });

  it("says so when the class does not exist", async () => {
    store.readClass.mockResolvedValue(null);

    const response = await fetch(`${base}/api/v1/classes/nope/summary`, { headers: auth });
    expect(response.status).toBe(404);
  });
});
