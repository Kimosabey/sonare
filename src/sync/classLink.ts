/**
 * The pupil's half of joining a class — the two calls, and what they refuse.
 *
 * Thin on purpose, like `deviceLink.ts` beside it: the rules about codes live
 * on the server, and a second set here would be a second thing to keep in
 * step. What this file does own is the ordering, because getting it wrong is
 * how a pupil ends up in a class they did not agree to.
 *
 * **Preview, then decide, then join.** Never preview-and-join in one call. The
 * whole of board 1c is a screen shown *between* those two steps: a pupil reads
 * what a teacher will and will not see and then chooses. A single call would
 * make typing a code the act of joining, and the consent screen decoration.
 *
 * The code goes in the request body, never a URL — a query string reaches
 * server logs, proxy logs and browser history, and this one identifies a class
 * of children.
 */

import { normaliseLinkCode } from "../lib/linkCode.js";
import { readToken } from "./tokenStore.js";

export interface ClassOptions {
  fetchImpl?: typeof fetch;
}

export interface ClassPreview {
  classId: string;
  name: string;
  teacherName: string;
  slug: string;
}

export type PreviewResult =
  | { ok: true; preview: ClassPreview }
  | { ok: false; message: string };

const NOT_A_CODE = "That does not look like a class code. Check it and try again.";
const NO_MATCH = "That code does not match a class. Check it and try again.";
const OFFLINE = "Couldn’t reach the server. Check your connection and try again.";
const JOIN_FALLBACK = "Couldn’t join the class right now. Please try again.";

async function messageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { userMessage?: unknown } };
    const message = body.error?.userMessage;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Looks up a class so the pupil can be shown what joining would share.
 *
 * Unauthenticated: a pupil typing a code off a board has no relationship with
 * the class yet, and requiring one would mean the decision screen could only
 * be reached by somebody already in it.
 *
 * Normalised here first so a string the server could not accept under any
 * circumstances does not spend a request — the same client-side copy of the
 * server's rule that `claimCode` makes, refusing unknown characters rather
 * than stripping them into something valid.
 */
export async function previewClass(
  code: string,
  options: ClassOptions = {},
): Promise<PreviewResult> {
  const normalised = normaliseLinkCode(code);
  if (normalised === null) return { ok: false, message: NOT_A_CODE };

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch("/api/v1/classes/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: normalised }),
    });

    if (!response.ok) return { ok: false, message: await messageFrom(response, NO_MATCH) };

    const body = (await response.json()) as Partial<ClassPreview>;
    // Checked rather than trusted. A preview missing its class name would show
    // a pupil "Join ?" and ask them to agree to it.
    if (
      typeof body.classId !== "string" ||
      typeof body.name !== "string" ||
      typeof body.teacherName !== "string" ||
      body.name === "" ||
      body.teacherName === ""
    ) {
      return { ok: false, message: NO_MATCH };
    }

    return {
      ok: true,
      preview: {
        classId: body.classId,
        name: body.name,
        teacherName: body.teacherName,
        slug: typeof body.slug === "string" ? body.slug : "",
      },
    };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

export type JoinResult = { ok: true; classId: string } | { ok: false; message: string };

/**
 * Joins, with or without a name.
 *
 * `sharedName` is what the pupil chose on the decision screen, and `null` is a
 * decision rather than a missing value — board 1c offers "Join without my
 * name" as a peer of "Join the class", so the two must reach the server as
 * different requests rather than as one request with a field left out.
 *
 * Authenticated as the pupil. The server attaches whoever the token says is
 * asking and ignores any id in the body, so this cannot enrol somebody else.
 */
export async function joinClass(
  code: string,
  learnerName: string | null,
  sharedName: string | null,
  options: ClassOptions = {},
): Promise<JoinResult> {
  const normalised = normaliseLinkCode(code);
  if (normalised === null) return { ok: false, message: NOT_A_CODE };

  const token = readToken(learnerName);
  if (token === null) {
    return {
      ok: false,
      message: "This device isn’t set up yet. Open Today once, then try joining again.",
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch("/api/v1/classes/join", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ code: normalised, sharedName }),
    });

    if (!response.ok) return { ok: false, message: await messageFrom(response, JOIN_FALLBACK) };

    const body = (await response.json()) as { classId?: unknown };
    if (typeof body.classId !== "string") return { ok: false, message: JOIN_FALLBACK };

    return { ok: true, classId: body.classId };
  } catch {
    return { ok: false, message: OFFLINE };
  }
}

export interface MyClass {
  classId: string;
  className: string;
  teacherName: string;
  slug: string;
  /** ISO day. */
  joinedAt: string;
  sharedName: string | null;
}

/**
 * The classes this device's learner is in.
 *
 * An empty list is the ordinary answer — most learners are in none — so a
 * failure here returns one too rather than an error the You tab would have to
 * render. The panel simply does not appear, which is the same thing a learner
 * in no class sees.
 */
export async function myClasses(
  learnerName: string | null,
  options: ClassOptions = {},
): Promise<MyClass[]> {
  const token = readToken(learnerName);
  if (token === null) return [];

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch("/api/v1/classes/mine", {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) return [];

    const body = (await response.json()) as { classes?: unknown };
    if (!Array.isArray(body.classes)) return [];

    const usable: MyClass[] = [];
    for (const raw of body.classes as unknown[]) {
      /**
       * Null and undefined before anything reads a property off them.
       *
       * Without this the cast is a lie that throws: `typeof null.classId` is a
       * TypeError, it escapes the loop, and the outer catch turns it into an
       * empty list — so **one** unreadable row hides every class the pupil is
       * actually in. The panel then disappears, and with it the only route to
       * "remove my name" and "leave the class", which are the two things the
       * join screen promises they can always do.
       *
       * The per-row `continue` below was meant to be the leniency. It only
       * ever worked for rows that were objects.
       */
      if (typeof raw !== "object" || raw === null) continue;
      const c = raw as Partial<MyClass>;
      if (
        typeof c.classId !== "string" ||
        typeof c.className !== "string" ||
        typeof c.teacherName !== "string" ||
        typeof c.slug !== "string" ||
        typeof c.joinedAt !== "string"
      ) {
        continue;
      }
      usable.push({
        classId: c.classId,
        className: c.className,
        teacherName: c.teacherName,
        slug: c.slug,
        joinedAt: c.joinedAt,
        sharedName: typeof c.sharedName === "string" ? c.sharedName : null,
      });
    }
    return usable;
  } catch {
    return [];
  }
}

/**
 * Removes the name a pupil shares, keeping the membership.
 *
 * Returns whether it worked, because this one must not be optimistic: a pupil
 * told their name is gone when it is not has been told the opposite of the
 * truth about a thing they asked for.
 */
export async function removeMyName(
  classId: string,
  learnerName: string | null,
  options: ClassOptions = {},
): Promise<boolean> {
  const token = readToken(learnerName);
  if (token === null) return false;

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(`/api/v1/classes/${encodeURIComponent(classId)}/name`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** Leaves a class. Nothing the learner has practised is touched. */
export async function leaveClass(
  classId: string,
  learnerName: string | null,
  options: ClassOptions = {},
): Promise<boolean> {
  const token = readToken(learnerName);
  if (token === null) return false;

  const doFetch = options.fetchImpl ?? fetch;
  try {
    const response = await doFetch(
      `/api/v1/classes/${encodeURIComponent(classId)}/membership`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
    );
    return response.ok;
  } catch {
    return false;
  }
}
