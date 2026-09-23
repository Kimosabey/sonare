/**
 * The teacher's view — Teacher board 1a, 1d and 1e on one route.
 *
 * Internal in the same way `/authoring` and `/diagnostics` are: reached by
 * typing the URL, token-gated server-side, and linked from nowhere in the
 * product. The board is explicit that it must not be reachable from a
 * learner's four tabs, and the simplest way to hold that is for the learner's
 * navigation to have no idea this exists.
 *
 * The limits come first and are always visible — board 1a: "the limits are the
 * first screen, not a settings page nobody opens, because a teacher who
 * expects a gradebook and finds none will otherwise spend a week looking for
 * it". They are not behind a disclosure for the same reason.
 *
 * Every figure on this page arrives from `GET /classes/:id/summary`, which
 * converts accuracies to standings before they cross the class boundary. This
 * screen therefore cannot show a pupil's score, because it is never sent one.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ClassLimits } from "../components/ClassLimits.js";
import { ClassOverview } from "../components/ClassOverview.js";
import { ClassGlance } from "../components/ClassGlance.js";
import { SoundDetail } from "../components/SoundDetail.js";
import { CourseSyllabus } from "../components/CourseSyllabus.js";
import { soundNoteFor } from "../teacher/soundNote.js";
import { PupilList } from "../components/PupilList.js";
import { PupilDetail } from "../components/PupilDetail.js";
import { CreateClass, type NameVisibility } from "../components/CreateClass.js";
import { SetSitting, type SuggestionWindow } from "../components/SetSitting.js";
import { resolveLanguage } from "../content/resolve.js";
import type { PupilRow } from "../teacher/roster.js";
import type { ClassSummary } from "../teacher/classSummary.js";

/** The same key the diagnostics and authoring screens write. One secret. */
const TOKEN_STORAGE_KEY = "sonare.diagnosticsToken";

/**
 * Teacher keys, one per class, kept per class id.
 *
 * A single key would be wrong: a teacher may own more than one class, and the
 * key is what proves ownership of a *particular* one. Storing them together
 * under one name would mean creating a second class silently revoked access to
 * the first.
 */
const TEACHER_KEYS_STORAGE_KEY = "sonare.teacherKeys";

function readTeacherKeys(): Record<string, string> {
  try {
    const raw = localStorage.getItem(TEACHER_KEYS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, string> = {};
    for (const [id, key] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof key === "string" && key !== "") out[id] = key;
    }
    return out;
  } catch {
    // Unreadable storage is no keys, never a throw — this screen also carries
    // the only route to a class somebody may need right now.
    return {};
  }
}

function rememberTeacherKey(classId: string, key: string): void {
  try {
    localStorage.setItem(
      TEACHER_KEYS_STORAGE_KEY,
      JSON.stringify({ ...readTeacherKeys(), [classId]: key }),
    );
  } catch {
    // Storage full or blocked. The key is still on screen as a link, which is
    // the copy that matters — it cannot be shown again.
  }
}
/** Where the teacher's chosen class is remembered between visits. */
const CLASS_STORAGE_KEY = "sonare.teacherClassId";

interface ClassResponse {
  className: string;
  slug: string;
  expectedCount: number | null;
  summary: ClassSummary;
  /** Board 1g's list. Names, attendance and sounds — never a figure. */
  roster?: PupilRow[];
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A browser refusing storage costs a remembered class id, nothing more.
  }
}

/** The last five days, oldest first — the strip the pupil list draws. */
function lastFiveDays(today: Date = new Date()): string[] {
  return Array.from({ length: 5 }, (_, i) => {
    const day = new Date(today);
    day.setUTCDate(day.getUTCDate() - (4 - i));
    return day.toISOString().slice(0, 10);
  });
}

export function Teacher() {
  const [params] = useSearchParams();

  const token =
    (() => {
      const fromUrl = params.get("token");
      if (fromUrl !== null && fromUrl !== "") {
        store(TOKEN_STORAGE_KEY, fromUrl);
        return fromUrl;
      }
      return readStored(TOKEN_STORAGE_KEY);
    })();

  const [classId, setClassId] = useState(() => params.get("class") ?? readStored(CLASS_STORAGE_KEY) ?? "");

  /**
   * The key proving this device owns the class it is asking about.
   *
   * Taken from the URL first, so a teacher who opens their link on a second
   * device is recognised there too; then from storage. A class the operator
   * created before ownership existed has neither, and the operator token still
   * opens it.
   */
  const teacherKey = useMemo(() => {
    const fromUrl = params.get("key");
    if (fromUrl !== null && fromUrl !== "" && classId !== "") {
      rememberTeacherKey(classId, fromUrl);
      return fromUrl;
    }
    return readTeacherKeys()[classId] ?? null;
  }, [params, classId]);

  const [newKey, setNewKey] = useState<string | null>(null);
  const [data, setData] = useState<ClassResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** Which sound is opened, by grapheme. Null is the overview. */
  const [openSound, setOpenSound] = useState<string | null>(null);
  /** Which pupil is opened, by label. Null is the list. */
  const [openPupil, setOpenPupil] = useState<string | null>(null);
  /** Which lesson is open for suggesting, by id. Null is none. */
  const [openLesson, setOpenLesson] = useState<number | null>(null);
  const [suggested, setSuggested] = useState<number | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  /** The code a freshly created class returned. Shown once, never stored. */
  const [newCode, setNewCode] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const createClass = useCallback(
    async (input: {
      name: string;
      teacherName: string;
      slug: string;
      visibility: NameVisibility;
    }): Promise<void> => {
      setCreating(true);
      setCreateError(null);
      try {
        const response = await fetch("/api/v1/classes", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token === null ? {} : { "x-diagnostics-token": token }),
          },
          body: JSON.stringify(input),
        });
        if (response.status === 401) {
          setCreateError("This server requires a token. Add ?token=… to the URL once.");
          return;
        }
        if (!response.ok) throw new Error("request failed");

        const body = (await response.json()) as {
          classId?: string;
          code?: string;
          teacherKey?: string;
        };
        if (typeof body.code !== "string" || typeof body.classId !== "string") {
          throw new Error("malformed");
        }
        // Shown once and never again — only its digest is stored server-side,
        // so a key that is not kept means a class nobody can administer rather
        // than one anybody can.
        if (typeof body.teacherKey === "string" && body.teacherKey !== "") {
          rememberTeacherKey(body.classId, body.teacherKey);
          setNewKey(body.teacherKey);
        }
        setNewCode(body.code);
        // Remembered so the summary below loads the class just created.
        setClassId(body.classId);
      } catch {
        setCreateError("Couldn’t create the class. Nothing was saved.");
      } finally {
        setCreating(false);
      }
    },
    [token, teacherKey],
  );

  const suggest = useCallback(
    async (input: { lessonId: number; window: SuggestionWindow }): Promise<void> => {
      if (classId === "") return;
      setSuggesting(true);
      setSuggestError(null);
      try {
        const response = await fetch(
          `/api/v1/classes/${encodeURIComponent(classId)}/suggestion`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(token === null ? {} : { "x-diagnostics-token": token }),
              ...(teacherKey === null ? {} : { "x-teacher-key": teacherKey }),
            },
            body: JSON.stringify(input),
          },
        );
        if (!response.ok) throw new Error("request failed");

        setSuggested(input.lessonId);
        setOpenLesson(null);
      } catch {
        // Said plainly, because the alternative is a screen claiming a
        // suggestion reached a class it never left this device for.
        setSuggestError("Couldn’t suggest that sitting. Nothing was sent.");
      } finally {
        setSuggesting(false);
      }
    },
    [classId, token, teacherKey],
  );

  const regenerate = useCallback(async (): Promise<void> => {
    if (classId === "") return;
    setCreating(true);
    setCreateError(null);
    try {
      const response = await fetch(
        `/api/v1/classes/${encodeURIComponent(classId)}/code`,
        {
          method: "POST",
          headers: {
            ...(token === null ? {} : { "x-diagnostics-token": token }),
            ...(teacherKey === null ? {} : { "x-teacher-key": teacherKey }),
          },
        },
      );
      if (!response.ok) throw new Error("request failed");

      const body = (await response.json()) as { code?: string };
      if (typeof body.code !== "string") throw new Error("malformed");
      setNewCode(body.code);
    } catch {
      // The old code is still the live one, so say nothing changed rather
      // than leaving a teacher unsure which code is on the board.
      setCreateError("Couldn’t regenerate. The old code still works.");
    } finally {
      setCreating(false);
    }
  }, [classId, token]);

  const load = useCallback(
    async (id: string): Promise<void> => {
      if (id === "") return;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/v1/classes/${encodeURIComponent(id)}/summary`, {
          headers: {
            ...(token === null ? {} : { "x-diagnostics-token": token }),
            ...(teacherKey === null ? {} : { "x-teacher-key": teacherKey }),
          },
        });
        if (response.status === 401) {
          setData(null);
          setError("This server requires a token. Add ?token=… to the URL once.");
          return;
        }
        if (response.status === 404) {
          setData(null);
          setError("That class does not exist.");
          return;
        }
        if (!response.ok) throw new Error("request failed");

        setData((await response.json()) as ClassResponse);
        store(CLASS_STORAGE_KEY, id);
      } catch {
        setData(null);
        setError("Couldn’t reach the server. Nothing about your class has changed.");
      } finally {
        setLoading(false);
      }
    },
    [token, teacherKey],
  );

  useEffect(() => {
    if (classId !== "") void load(classId);
  }, [classId, teacherKey, load]);

  const opened =
    data?.summary.reportable === true && openSound !== null
      ? data.summary.sounds.find((sound) => sound.grapheme === openSound)
      : undefined;

  return (
    <>
      <section>
        <h1>Sonare for a class</h1>
        <ClassLimits showCapabilities />
      </section>

      {/*
        Creating comes before opening one, because a teacher arriving here for
        the first time has no class id to type — and the board's first run is
        the limits followed by a class, not a form asking for an id they have
        never seen.
      */}
      <section>
        <CreateClass
          busy={creating}
          code={newCode}
          error={createError}
          onCreate={(input) => void createClass(input)}
          {...(newCode !== null ? { onOpen: () => setNewCode(null) } : {})}
          {...(newCode !== null ? { onRegenerate: () => void regenerate() } : {})}
        />
      </section>

      {/*
        The key, shown once.

        This is the door D1 asked for, and it is a link rather than an account
        because an account for a teacher means email, password recovery and a
        child-adjacent data policy, none of which buys anything this does not.

        Shown exactly once because only its digest is stored. A teacher who
        loses it has a class nobody can open, which is the correct failure —
        the alternative is a key the server can hand back, which is a key
        anybody who reaches the server can hand themselves.
      */}
      {newKey !== null && (
        <section>
          <h2>Your link to this class</h2>
          <p className="what">
            This opens the class on any device. It is shown once and cannot be shown again —
            keep it somewhere you will still have it next term.
          </p>
          <p className="row">
            <label htmlFor="teacher-link">Link</label>
            <input
              id="teacher-link"
              type="text"
              readOnly
              spellCheck={false}
              value={`${window.location.origin}/#/teacher?class=${encodeURIComponent(classId)}&key=${encodeURIComponent(newKey)}`}
              onFocus={(event) => event.currentTarget.select()}
            />
          </p>
          <p className="hint">
            Anyone with this link can see this class. It shows no pupil&rsquo;s score — nothing
            here ever does — but it does show who has practised and which sounds they are
            working on.
          </p>
          <p className="row">
            <button type="button" className="ghost" onClick={() => setNewKey(null)}>
              I have saved it
            </button>
          </p>
        </section>
      )}

      <section>
        <h2>Your class</h2>
        <p className="row">
          <label htmlFor="teacher-class">Class id</label>
          <input
            id="teacher-class"
            type="text"
            value={classId}
            spellCheck={false}
            onChange={(event) => setClassId(event.target.value.trim())}
          />
        </p>
        {loading && <p className="hint">Loading…</p>}
        {error !== null && (
          <div className="authoring-outcome" role="alert">
            <p className="what">{error}</p>
          </div>
        )}
      </section>

      {/*
        Board 1i beside board 1d. Both render and a media query picks one —
        `display: none` also takes the other out of the accessibility tree, so
        a screen reader meets one rather than both. A JavaScript breakpoint
        would have to guess before first paint and would get a rotation wrong.
      */}
      {data !== null && opened === undefined && (
        <section className="class-glance-wrap">
          <ClassGlance
            className={data.className}
            code={data.slug}
            summary={data.summary}
          />
        </section>
      )}

      {data !== null && opened === undefined && (
        <section className="class-desk">
          <ClassOverview
            className={data.className}
            code={data.slug}
            summary={data.summary}
            expectedCount={data.expectedCount}
            onOpenSound={setOpenSound}
          />
        </section>
      )}

      {data !== null && opened !== undefined && data.summary.reportable && (
        <section>
          <p className="row">
            <button type="button" className="ghost" onClick={() => setOpenSound(null)}>
              Back to {data.className}
            </button>
          </p>
          <SoundDetail
            /*
              The note the table has always held and nothing ever passed. See
              src/teacher/soundNote.ts — null when no guidance exists for this
              sound, which renders nothing rather than a filled-in sentence
              nobody stands behind.

              Resolved to a locale rather than handed `slug`. The difficulty
              table is keyed by pair — "en→fr-FR" — and the class response
              carries "fr". The first version passed the slug, which matched
              nothing, so every note was null and the screen looked exactly as
              it had when the prop was never passed at all. Caught by the test
              that opens a sound and reads what is on it.
            */
            note={soundNoteFor(resolveLanguage(data.slug)?.code ?? data.slug, opened.grapheme)}
            grapheme={opened.grapheme}
            code={data.slug}
            difficulty={opened}
            joinedCount={data.summary.joinedCount}
          />
        </section>
      )}

      {/*
        What the course covers, in the vocabulary a department buys in.

        Rendered from the same resolver a learner reads, so a teacher sees the
        syllabus for the content their pupils will actually meet rather than
        for whatever is newest in the repository. Takes activity ids and never
        a learner: a CEFR level attached to a named child is exactly the kind
        of figure the class boundary exists to keep off this screen.
      */}
      {data !== null &&
        (() => {
          const language = resolveLanguage(data.slug);
          if (language === undefined) return null;
          return (
            <section>
              <CourseSyllabus
                slug={data.slug}
                label={language.label}
                activityIds={language.activities.map((activity) => activity.id)}
              />
            </section>
          );
        })()}

      {/*
        Suggesting a sitting. The lesson list comes from the same resolver a
        learner reads, so a teacher previews what pupils will actually be
        offered rather than what happened to be bundled at build time. The
        suggestion itself travels as a lesson id, which is stable across
        content versions by design.
      */}
      {data !== null && (() => {
        const language = resolveLanguage(data.slug);
        const lessons = (language?.units ?? []).flatMap((unit) => unit.lessons);
        if (lessons.length === 0) return null;

        const open = lessons.find((lesson) => lesson.id === openLesson);
        if (open === undefined) {
          return (
            <section>
              <h2>Set a sitting</h2>
              <p className="hint">
                A suggestion on their Today screen — never a lock, and never a mark.
              </p>
              <ul className="sitting-windows">
                {lessons.map((lesson) => (
                  <li key={lesson.id}>
                    <button type="button" className="ghost" onClick={() => setOpenLesson(lesson.id)}>
                      {lesson.title}
                    </button>
                  </li>
                ))}
              </ul>
              {suggested !== null && (
                <p className="what" role="status">
                  Suggested. It is on their Today screen now.
                </p>
              )}
              {suggestError !== null && (
                <p className="what" role="alert">
                  {suggestError}
                </p>
              )}
            </section>
          );
        }

        const activities = open.activityIds
          .map((id) => language?.activities.find((activity) => activity.id === id))
          .filter((activity): activity is NonNullable<typeof activity> => activity !== undefined);

        return (
          <section>
            <p className="row">
              <button type="button" className="ghost" onClick={() => setOpenLesson(null)}>
                Back to the lessons
              </button>
            </p>
            <SetSitting
              lesson={open}
              activities={activities}
              code={data.slug}
              joinedCount={data.summary.reportable ? data.summary.joinedCount : 0}
              busy={suggesting}
              onSuggest={(input) => void suggest(input)}
            />
          </section>
        );
      })()}

      {data?.roster !== undefined && data.roster.length > 0 && (
        <section>
          {openPupil === null ? (
            <PupilList
              rows={data.roster}
              week={lastFiveDays()}
              onOpen={setOpenPupil}
            />
          ) : (
            (() => {
              const row = data.roster.find((r) => r.label === openPupil);
              if (row === undefined) return null;
              return (
                <>
                  <p className="row">
                    <button type="button" className="ghost" onClick={() => setOpenPupil(null)}>
                      Back to the class list
                    </button>
                  </p>
                  <PupilDetail
                    row={row}
                    code={data.slug}
                    classSounds={
                      data.summary.reportable ? data.summary.sounds.map((s) => s.grapheme) : []
                    }
                  />
                </>
              );
            })()
          )}
        </section>
      )}

      <section>
        <p className="row">
          <Link to="/" className="ghost">
            Back to today
          </Link>
        </p>
      </section>
    </>
  );
}
