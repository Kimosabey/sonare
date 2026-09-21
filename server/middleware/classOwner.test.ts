/**
 * The guard that asks *who*, not only *whether*.
 *
 * Before this existed, every teacher surface sat behind one shared
 * `DIAGNOSTICS_TOKEN` and then read whichever `classId` arrived in the path.
 * The token was checked; the caller's relationship to the class was not. A
 * holder of that token could read every class on the server — another
 * teacher's, another school's.
 *
 * It was contained only because nothing linked to the board, so the single
 * holder was the operator. Giving teachers a way in, which is the point of the
 * work this belongs to, is precisely the step that would have turned a
 * contained arrangement into a breach.
 */

import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ownsClass = vi.fn<(classId: string, key: string | null) => Promise<boolean>>();
vi.mock("../store/classes.js", () => ({ ownsClass: (id: string, k: string | null) => ownsClass(id, k) }));
vi.mock("../logger.js", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

const { requireClassOwner, TEACHER_KEY_HEADER } = await import("./classOwner.js");

interface Sent {
  status: number;
  body: unknown;
}

function run(
  headers: Record<string, string>,
  classId = "c-1",
): Promise<{ passed: boolean; sent: Sent | null }> {
  return new Promise((resolve) => {
    let sent: Sent | null = null;
    let passed = false;
    const res = {
      status(code: number) {
        sent = { status: code, body: null };
        return {
          json(body: unknown) {
            sent = { status: code, body };
            resolve({ passed, sent });
          },
        };
      },
    } as unknown as Response;
    const next: NextFunction = () => {
      passed = true;
      resolve({ passed: true, sent: null });
    };
    requireClassOwner({ params: { classId }, headers } as unknown as Request, res, next);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.DIAGNOSTICS_TOKEN = "operator-secret";
  ownsClass.mockResolvedValue(false);
});

afterEach(() => {
  delete process.env.DIAGNOSTICS_TOKEN;
});

describe("a teacher with a key", () => {
  it("is let through for the class they own", async () => {
    ownsClass.mockResolvedValue(true);

    const { passed } = await run({ [TEACHER_KEY_HEADER]: "their-key" });

    expect(passed).toBe(true);
    expect(ownsClass).toHaveBeenCalledWith("c-1", "their-key");
  });

  /**
   * The whole point. A valid key for one class must not open another, or the
   * guard is the shared token again with extra steps.
   */
  it("is refused for a class they do not own", async () => {
    ownsClass.mockResolvedValue(false);

    const { passed, sent } = await run({ [TEACHER_KEY_HEADER]: "someone-elses-key" });

    expect(passed).toBe(false);
    expect(sent?.status).toBe(404);
  });

  /**
   * 404 and not 403, and the message says nothing either. A 403 on a class
   * that exists against a 404 on one that does not is an oracle: a caller with
   * any key could walk ids and learn which are real, which is the first half
   * of reading across classes.
   */
  it("cannot tell an existing class from an absent one", async () => {
    const real = await run({ [TEACHER_KEY_HEADER]: "k" }, "a-real-class");
    const absent = await run({ [TEACHER_KEY_HEADER]: "k" }, "not-a-class");

    expect(real.sent?.status).toBe(absent.sent?.status);
    expect(JSON.stringify(real.sent?.body)).toBe(JSON.stringify(absent.sent?.body));
  });
});

describe("a caller with no key", () => {
  it("is refused", async () => {
    const { passed, sent } = await run({});

    expect(passed).toBe(false);
    expect(sent?.status).toBe(404);
  });

  it("is refused when the header is empty rather than absent", async () => {
    const { passed } = await run({ [TEACHER_KEY_HEADER]: "" });

    expect(passed).toBe(false);
    expect(ownsClass).toHaveBeenCalledWith("c-1", null);
  });
});

describe("the operator", () => {
  /**
   * Still sufficient, deliberately. Somebody has to administer a deployment,
   * and classes made before ownership existed have no owner to present a key
   * for. The change is that it is one holder by design rather than everyone by
   * accident.
   */
  it("passes without owning the class, and without a store read", async () => {
    const { passed } = await run({ "x-diagnostics-token": "operator-secret" });

    expect(passed).toBe(true);
    expect(ownsClass).not.toHaveBeenCalled();
  });

  it("is not admitted by a wrong token", async () => {
    const { passed, sent } = await run({ "x-diagnostics-token": "guess" });

    expect(passed).toBe(false);
    expect(sent?.status).toBe(404);
  });

  /**
   * Fail closed. With no token configured, an absent header must not match an
   * absent secret and let everybody through — the failure mode that turns a
   * missing environment variable into an open server.
   */
  it("does not let an unset token admit everyone", async () => {
    delete process.env.DIAGNOSTICS_TOKEN;

    const { passed } = await run({});

    expect(passed).toBe(false);
  });

  it("does not let an empty token admit an empty header", async () => {
    process.env.DIAGNOSTICS_TOKEN = "";

    const { passed } = await run({ "x-diagnostics-token": "" });

    expect(passed).toBe(false);
  });
});

describe("when the store cannot answer", () => {
  /**
   * Refuses rather than falling through. A thrown store read that reached the
   * handler would be an outage that opens the door instead of closing it.
   */
  it("refuses instead of passing the request on", async () => {
    ownsClass.mockRejectedValue(new Error("mongo is down"));

    const { passed, sent } = await run({ [TEACHER_KEY_HEADER]: "k" });

    expect(passed).toBe(false);
    expect(sent?.status).toBe(503);
  });
});

/**
 * The two things a mocked `ownsClass` cannot see.
 *
 * Every test above stubs the store, which is right for testing the guard's own
 * decisions and blind to two failures that live either side of it. Both
 * survived a mutation run against the block above, so both are here.
 */
describe("what the guard cannot check about itself", () => {
  const routes = readFileSync(new URL("../routes/classes.ts", import.meta.url), "utf8");
  const store = readFileSync(new URL("../store/classes.ts", import.meta.url), "utf8");

  /**
   * Mounted, not merely written. A middleware that exists and is not in the
   * chain is the exact shape of the daily-spend cap that was read, reported,
   * alerted on and consulted by no route for months.
   *
   * Every route addressing a `:classId` must carry it — those are precisely
   * the ones that read or change one class's data.
   */
  it("is mounted on every teacher route that addresses a class", () => {
    /**
     * Scoped to the routes behind `requireDiagnosticsToken`, and the first
     * version was not — it demanded the guard on every `:classId` route and
     * failed on `DELETE /classes/:classId/membership`, correctly.
     *
     * That one is a **pupil** leaving their own class. It addresses a class id
     * and is guarded by `requireLearner`, which is the right guard: the
     * question there is "are you this learner", not "do you own this class".
     * Putting an owner check on it would mean a pupil could only leave a class
     * if they were its teacher.
     *
     * So the invariant is per guard, not per path shape: a route that trusts
     * the operator token must also ask who is asking, because that token is
     * one shared secret and answers nothing about identity.
     */
    const handlers = routes.match(/classesRouter\.(get|post|delete)\([\s\S]*?\(req: Request/g) ?? [];
    const teacherRoutes = handlers.filter(
      (block) => block.includes(":classId") && block.includes("requireDiagnosticsToken"),
    );

    expect(teacherRoutes.length, "no teacher route addresses a classId").toBeGreaterThan(2);
    for (const block of teacherRoutes) {
      const route = /"([^"]+)"/.exec(block)?.[1] ?? "?";
      expect(block, `${route} trusts the shared token and never asks who is asking`).toMatch(
        /requireClassOwner/,
      );
    }

    /**
     * And the pupil route is still guarded by something. Narrowing the rule
     * above must not quietly exempt a route from having any guard at all.
     */
    const pupilRoutes = handlers.filter(
      (block) => block.includes(":classId") && !block.includes("requireDiagnosticsToken"),
    );
    for (const block of pupilRoutes) {
      const route = /"([^"]+)"/.exec(block)?.[1] ?? "?";
      expect(block, `${route} has no identity guard at all`).toMatch(/requireLearner/);
    }
  });

  /**
   * A class with no owner belongs to nobody, not to everybody.
   *
   * Classes created before ownership existed carry no `ownerDigest`. Treating
   * that as a match would mean anyone who minted themselves a key could open
   * every legacy class — the precise hole this work closes, reintroduced
   * through the back door. They stay reachable by the operator token that
   * created them, and by nothing else.
   */
  it("treats a class with no owner as owned by nobody", () => {
    const fn = store.slice(store.indexOf("export async function ownsClass"));
    const body = fn.slice(0, fn.indexOf("\n}"));

    expect(body).toMatch(/if\s*\(stored === null\)\s*return false;/);
  });

  /** And the key itself is never stored — only a digest of it. */
  it("stores a digest of the teacher key and never the key", () => {
    const create = store.slice(store.indexOf("export async function createClass"));
    const body = create.slice(0, create.indexOf("\n}"));

    expect(body).toMatch(/ownerDigest: teacherKeyDigest\(teacherKey\)/);
    expect(body, "the key itself is written to the document").not.toMatch(/ownerDigest: teacherKey,/);
  });
});
