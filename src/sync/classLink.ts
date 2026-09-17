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
