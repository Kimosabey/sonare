/**
 * The screen behind the publish endpoint — content authoring, and the reason
 * the versioned content store was built.
 *
 * Content has been servable from the database for a while. Publishing it was
 * `npm run seed-content` from a checkout, and correcting one phrase was a
 * Mongo client. Both of those are engineer tools, so the person whose job
 * curriculum actually is could not do their job without one — which makes
 * curriculum depth an engineering queue rather than an authoring task. This
 * screen is the whole of the loop: **list the versions, edit a set, publish it
 * as the next version.**
 *
 * Internal-only, like /diagnostics and /fixture: reached by typing the URL,
 * with no nav link to it anywhere in the product UI. Token-gated server-side —
 * pass it once as #/authoring?token=… and it is remembered, the same gesture
 * and the same secret the diagnostics screen uses.
 *
 * Four properties this file is built around.
 *
 * **Publishing only ever adds a version.** There is no edit-in-place control
 * here because there is no edit-in-place endpoint: a correction is a new
 * version, so a learner mid-session keeps the words they started being scored
 * against. Rolling back is loading an older version and publishing it forward,
 * which is why every version in the list has a Load button.
 *
 * **The publish button cannot be the thing that breaks a language.** The
 * server refuses anything unusable through the same gate `seed-content` uses;
 * this screen mirrors those rules so the author sees *which field* is wrong
 * before spending a round trip, and renders the server's own `problems`
 * verbatim if the two ever disagree. Disagreement can cost a failed publish.
 * It cannot produce a bad one.
 *
 * **A learner offline is unaffected by anything done here.** Publishing writes
 * a new document; the client prefers served content and falls back to the
 * bundle, per language, silently. The worst a bad publish can do is be
 * refused, and the worst a good one can do is take effect on the next fetch.
 *
 * **The bundle is the starting point, not a rival.** For a language nobody has
 * published, "start from the bundled set" is the honest first draft — it is
 * what every learner is using right now. It is read from the bundle rather
 * than from the resolver's cache, so it cannot quietly seed from stale served
 * content while claiming to be what shipped.
 *
 * Deliberately carries no curriculum and no policy wording. What is on screen
 * is a factual account of what publishing does; what the content should *say*
 * is the author's job, which is the point.
 */

import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { LANGUAGES, getLanguage } from "../activities/languages/index.js";
import { getCourse } from "../activities/courses/index.js";
import {
  DRAFT_KINDS,
  MAX_DRAFT_LESSON_ACTIVITIES,
  MIN_DRAFT_LESSON_ACTIVITIES,
  draftFromSet,
  draftProblems,
  draftToPayload,
  emptyActivity,
  emptyLesson,
  emptyUnit,
  type ContentDraft,
  type DraftActivity,
  type DraftLesson,
} from "../content/draft.js";

/** The same key the diagnostics screen writes, because it is the same secret. */
const TOKEN_STORAGE_KEY = "sonare.diagnosticsToken";

/** Mirrors the summary from GET /content/:slug/versions. Read defensively — it crossed a network. */
interface VersionSummary {
  version: number;
  publishedAt: string;
  activityCount: number;
}

interface PublishedSet {
  slug: string;
  code: string;
  label: string;
  version: number;
  activities: {
    id: number;
    title: string;
    kind: string;
    prompt: string;
    gloss: string;
    target: string;
    focus: string;
    soundTargets?: string[];
  }[];
  /** Absent on every set published before the course spine existed. */
  units?: {
    id: number;
    title: string;
    outcome: string;
    lessons: { id: number; title: string; outcome: string; activityIds: number[] }[];
  }[];
}

/**
 * What the last publish did, kept apart from the editor's own state.
 *
 * `problems` here are the *server's*, not this screen's. They are the
 * authoritative answer, so they are shown as they arrived rather than
 * re-derived — if the mirror in draft.ts has drifted, this is what says so.
 */
interface PublishOutcome {
  kind: "published" | "refused" | "conflict" | "failed";
  message: string;
  problems?: string[];
}

const FIELDS = ["title", "prompt", "gloss", "target", "focus", "soundTargets"] as const;

/** What each field is for, in the terms an author would ask about it. */
const FIELD_HINTS: Record<(typeof FIELDS)[number], string> = {
  title: "Names the activity in the list and the report.",
  prompt: "The task as the learner reads it. For “respond”, the question.",
  gloss: "The English meaning, so nobody is guessing at what they are saying.",
  target: "The text scored against. For “respond”, the expected spoken answer.",
  focus: "What this activity is designed to expose. Drives the report’s advice.",
  soundTargets:
    "The written syllables this phrase drills, separated by commas — “bon, jour”. Each one has to occur in the target, because that is the only thing the scorer can name. Required once the set has units.",
};

export function Authoring() {
  const [searchParams] = useSearchParams();

  /**
   * A token in the URL wins and is remembered; otherwise whatever a previous
   * visit left. Same shape as the diagnostics screen, deliberately — one
   * gesture to learn, and an author who has already used that screen does not
   * retype anything.
   */
  const urlToken = searchParams.get("token");
  if (urlToken) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, urlToken);
    } catch {
      // Private browsing or storage disabled. The token still works for this
      // page load; it just will not be remembered next time.
    }
  }
  const token =
    urlToken ??
    (() => {
      try {
        return localStorage.getItem(TOKEN_STORAGE_KEY);
      } catch {
        return null;
      }
    })();

  const [slug, setSlug] = useState(LANGUAGES[0]?.slug ?? "fr");
  const [versions, setVersions] = useState<VersionSummary[] | null>(null);
  const [versionsError, setVersionsError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ContentDraft | null>(null);
  /** Which version the editor was seeded from, for the heading only. */
  const [loadedFrom, setLoadedFrom] = useState<string | null>(null);
  const [busy, setBusy] = useState<"none" | "loading" | "publishing">("none");
  const [outcome, setOutcome] = useState<PublishOutcome | null>(null);

  const headers: HeadersInit = token ? { "x-diagnostics-token": token } : {};

  /**
   * The newest version anybody has published, which is what `baseVersion` on a
   * publish means: not the version loaded into the editor. Keeping those
   * separate is what lets an older version be published forward as a rollback
   * without the request reading as a conflict with itself.
   */
  const latest = versions?.[0]?.version ?? 0;

  const loadVersions = useCallback(
    async (forSlug: string): Promise<void> => {
      try {
        const response = await fetch(`/api/v1/content/${forSlug}/versions`, { headers });
        if (response.status === 401) {
          setVersions(null);
          setVersionsError("This server requires a token. Add ?token=… to the URL once.");
          return;
        }
        if (!response.ok) throw new Error("request failed");

        const body = (await response.json()) as { versions?: unknown };
        setVersions(Array.isArray(body.versions) ? (body.versions as VersionSummary[]) : []);
        setVersionsError(null);
      } catch {
        setVersions(null);
        setVersionsError("Couldn’t reach the content API — is the server (and MongoDB) up?");
      }
    },
    // `headers` is derived from `token`, which is what actually changes.
    [token],
  );

  useEffect(() => {
    // Switching language abandons the draft rather than carrying it across:
    // the fields belong to a language, and publishing French text under the
    // Spanish slug is the one mistake this screen must not make easy.
    setDraft(null);
    setLoadedFrom(null);
    setOutcome(null);
    void loadVersions(slug);
  }, [slug, loadVersions]);

  const startFromBundle = useCallback(() => {
    const bundled = getLanguage(slug);
    if (bundled === undefined) return;
    setDraft(draftFromSet(bundled));
    setLoadedFrom("the set built into the app");
    setOutcome(null);
  }, [slug]);

  /**
   * The course-shaped set, where one is authored: the same phrases with a
   * spine over them plus the `read` and `recall` activities the flat set has
   * none of.
   *
   * Offered rather than assumed, and from the bundle rather than the resolver's
   * cache for the same reason the flat one is — a draft labelled "the course
   * built into the app" that was actually a stale copy of something already
   * published is worse than no shortcut at all. Typing six lessons by hand to
   * get a spine into a draft is the alternative, and nobody would.
   */
  const course = getCourse(slug);
  const startFromCourse = useCallback(() => {
    const authored = getCourse(slug);
    if (authored === undefined) return;
    setDraft(draftFromSet(authored));
    setLoadedFrom("the course built into the app");
    setOutcome(null);
  }, [slug]);

  const loadVersion = useCallback(
    async (version: number): Promise<void> => {
      setBusy("loading");
      setOutcome(null);
      try {
        const response = await fetch(`/api/v1/content/${slug}/versions/${version}`, { headers });
        if (!response.ok) throw new Error("request failed");

        const body = (await response.json()) as PublishedSet;
        setDraft(draftFromSet(body));
        setLoadedFrom(`version ${version}`);
      } catch {
        setOutcome({ kind: "failed", message: `Couldn’t load version ${version}.` });
      } finally {
        setBusy("none");
      }
    },
    [slug, token],
  );

  const problems = draft === null ? [] : draftProblems(draft);

  const publishDraft = useCallback(async (): Promise<void> => {
    if (draft === null || problems.length > 0) return;

    setBusy("publishing");
    setOutcome(null);
    try {
      const response = await fetch(`/api/v1/content/${slug}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(draftToPayload(draft, latest)),
      });

      if (response.status === 201) {
        const body = (await response.json()) as { version?: number };
        setOutcome({
          kind: "published",
          message: `Published version ${String(body.version ?? latest + 1)}. Earlier versions are untouched.`,
        });
        await loadVersions(slug);
        return;
      }

      const body = (await response.json().catch(() => ({}))) as {
        error?: { userMessage?: string };
        problems?: string[];
      };

      if (response.status === 422) {
        /**
         * The server refused it. Its list is shown rather than this screen's,
         * because the server is the gate — if the mirror in draft.ts has
         * drifted, this is the only place that would reveal it, and the author
         * needs the reason that actually applies.
         */
        setOutcome({
          kind: "refused",
          message: "The server refused this set.",
          problems: body.problems ?? [],
        });
        return;
      }
      if (response.status === 409) {
        setOutcome({
          kind: "conflict",
          message:
            body.error?.userMessage ??
            "Somebody else published while you were editing. Reload to see their version.",
        });
        await loadVersions(slug);
        return;
      }
      if (response.status === 401) {
        setOutcome({
          kind: "failed",
          message: "This server requires a token. Add ?token=… to the URL once.",
        });
        return;
      }
      setOutcome({ kind: "failed", message: body.error?.userMessage ?? "Publishing failed." });
    } catch {
      setOutcome({ kind: "failed", message: "Couldn’t reach the content API. Nothing was published." });
    } finally {
      setBusy("none");
    }
  }, [draft, problems.length, slug, latest, token, loadVersions]);

  function editActivity(index: number, field: keyof DraftActivity, value: string): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        activities: current.activities.map((a, i) => (i === index ? { ...a, [field]: value } : a)),
      };
    });
  }

  function addActivity(): void {
    setDraft((current) => {
      if (current === null) return current;
      // Next unused id rather than length + 1, so removing a middle row and
      // adding one does not hand out an id that is already taken.
      const highest = current.activities.reduce((max, a) => Math.max(max, Number(a.id) || 0), 0);
      return { ...current, activities: [...current.activities, emptyActivity(highest + 1)] };
    });
  }

  function removeActivity(index: number): void {
    setDraft((current) =>
      current === null
        ? current
        : { ...current, activities: current.activities.filter((_, i) => i !== index) },
    );
  }

  function editUnit(index: number, field: "id" | "title" | "outcome", value: string): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        units: current.units.map((u, i) => (i === index ? { ...u, [field]: value } : u)),
      };
    });
  }

  function editLesson(
    unitIndex: number,
    lessonIndex: number,
    field: keyof DraftLesson,
    value: string,
  ): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        units: current.units.map((u, i) =>
          i !== unitIndex
            ? u
            : {
                ...u,
                lessons: u.lessons.map((l, j) => (j === lessonIndex ? { ...l, [field]: value } : l)),
              },
        ),
      };
    });
  }

  /**
   * The next id nothing is using, across the whole draft.
   *
   * Lesson ids are unique across the language rather than per unit — a
   * finished sitting is recorded by lesson id alone — so a new lesson has to be
   * numbered against every unit's lessons, not against the one it is added to.
   */
  function nextLessonId(draftNow: ContentDraft): number {
    const highest = draftNow.units
      .flatMap((u) => u.lessons)
      .reduce((max, l) => Math.max(max, Number(l.id) || 0), 0);
    return highest + 1;
  }

  function addUnit(): void {
    setDraft((current) => {
      if (current === null) return current;
      const highest = current.units.reduce((max, u) => Math.max(max, Number(u.id) || 0), 0);
      return { ...current, units: [...current.units, emptyUnit(highest + 1, nextLessonId(current))] };
    });
  }

  function removeUnit(index: number): void {
    setDraft((current) =>
      current === null ? current : { ...current, units: current.units.filter((_, i) => i !== index) },
    );
  }

  function addLesson(unitIndex: number): void {
    setDraft((current) => {
      if (current === null) return current;
      const id = nextLessonId(current);
      return {
        ...current,
        units: current.units.map((u, i) =>
          i === unitIndex ? { ...u, lessons: [...u.lessons, emptyLesson(id)] } : u,
        ),
      };
    });
  }

  function removeLesson(unitIndex: number, lessonIndex: number): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        units: current.units.map((u, i) =>
          i === unitIndex ? { ...u, lessons: u.lessons.filter((_, j) => j !== lessonIndex) } : u,
        ),
      };
    });
  }

  return (
    <>
      <section>
        <p className="what">
          Publishing adds the next version. It never changes a published one, so a learner
          part-way through a session keeps the words they started with, and rolling back means
          loading an older version and publishing it forward.
        </p>

        <p className="row">
          <label htmlFor="authoring-language">Language</label>
          <select
            id="authoring-language"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          >
            {LANGUAGES.map((language) => (
              <option key={language.slug} value={language.slug}>
                {language.label}
              </option>
            ))}
          </select>
        </p>
      </section>

      <section>
        <h2>Published versions</h2>

        {versionsError !== null && (
          <p className="hint" role="alert">
            {versionsError}
          </p>
        )}

        {versions !== null && versions.length === 0 && (
          <p className="what">
            Nothing published for this language yet. Every learner is using the set built into
            the app, which is where a first draft should start.
          </p>
        )}

        {versions !== null && versions.length > 0 && (
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Published</th>
                  <th>Activities</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {versions.map((entry) => (
                  <tr key={entry.version}>
                    <td>
                      {entry.version}
                      {entry.version === latest && <span className="authoring-live"> live</span>}
                    </td>
                    <td>{new Date(entry.publishedAt).toLocaleString()}</td>
                    <td>{entry.activityCount}</td>
                    <td>
                      <button
                        type="button"
                        className="ghost"
                        disabled={busy !== "none"}
                        onClick={() => void loadVersion(entry.version)}
                      >
                        Load
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="row">
          <button type="button" className="ghost" onClick={startFromBundle}>
            Start from the bundled set
          </button>
          {course !== undefined && (
            <button type="button" className="ghost" onClick={startFromCourse}>
              Start from the course set
            </button>
          )}
          <button
            type="button"
            className="ghost"
            disabled={busy !== "none"}
            onClick={() => void loadVersions(slug)}
          >
            Reload list
          </button>
        </p>
      </section>

      {draft !== null && (
        <section>
          <h2>Editing {loadedFrom === null ? "a set" : loadedFrom}</h2>

          <p className="row">
            <label htmlFor="authoring-label">Label</label>
            <input
              id="authoring-label"
              type="text"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
          </p>
          <p className="row">
            <label htmlFor="authoring-code">Locale</label>
            <input
              id="authoring-code"
              type="text"
              value={draft.code}
              spellCheck={false}
              onChange={(event) => setDraft({ ...draft, code: event.target.value })}
            />
          </p>

          {draft.activities.map((activity, index) => (
            <details key={index} className="authoring-activity">
              <summary>
                {activity.id || "?"} · {activity.title.trim() === "" ? "untitled" : activity.title}
              </summary>

              <p className="row">
                <label htmlFor={`authoring-${index}-id`}>id</label>
                <input
                  id={`authoring-${index}-id`}
                  type="text"
                  inputMode="numeric"
                  className="authoring-narrow"
                  value={activity.id}
                  onChange={(event) => editActivity(index, "id", event.target.value)}
                />
                <label htmlFor={`authoring-${index}-kind`}>kind</label>
                {/* A select, not a text field: a mistyped kind renders as a
                    blank task, and the three the UI can render are known. */}
                <select
                  id={`authoring-${index}-kind`}
                  value={activity.kind}
                  onChange={(event) => editActivity(index, "kind", event.target.value)}
                >
                  {DRAFT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                  {/* An unknown kind loaded from an older document stays
                      visible rather than being silently rewritten to
                      "repeat" — it is a problem to be seen and fixed. */}
                  {!(DRAFT_KINDS as readonly string[]).includes(activity.kind) && (
                    <option value={activity.kind}>{activity.kind || "(none)"}</option>
                  )}
                </select>
              </p>

              {FIELDS.map((field) => (
                <p className="row authoring-field" key={field}>
                  <label htmlFor={`authoring-${index}-${field}`}>{field}</label>
                  <input
                    id={`authoring-${index}-${field}`}
                    type="text"
                    value={activity[field]}
                    onChange={(event) => editActivity(index, field, event.target.value)}
                  />
                  <span className="hint">{FIELD_HINTS[field]}</span>
                </p>
              ))}

              <p className="row">
                <button type="button" className="ghost" onClick={() => removeActivity(index)}>
                  Remove activity {index + 1}
                </button>
              </p>
            </details>
          ))}

          <p className="row">
            <button type="button" className="ghost" onClick={addActivity}>
              Add an activity
            </button>
          </p>

          <h3>Course spine</h3>
          <p className="what">
            Units and lessons are optional. A set with none is a flat list, which is what three
            of the shipped languages still are and what every client understands. Add one and the
            rules tighten: every activity must sit in exactly one lesson, a lesson is{" "}
            {MIN_DRAFT_LESSON_ACTIVITIES}–{MAX_DRAFT_LESSON_ACTIVITIES} activities, and every
            activity in a lesson needs its sound targets.
          </p>

          {draft.units.map((unit, unitIndex) => (
            <details key={unitIndex} className="authoring-activity">
              <summary>
                Unit {unit.id || "?"} · {unit.title.trim() === "" ? "untitled" : unit.title}
              </summary>

              <p className="row">
                <label htmlFor={`authoring-unit-${unitIndex}-id`}>unit id</label>
                <input
                  id={`authoring-unit-${unitIndex}-id`}
                  type="text"
                  inputMode="numeric"
                  className="authoring-narrow"
                  value={unit.id}
                  onChange={(event) => editUnit(unitIndex, "id", event.target.value)}
                />
              </p>
              <p className="row authoring-field">
                <label htmlFor={`authoring-unit-${unitIndex}-title`}>unit title</label>
                <input
                  id={`authoring-unit-${unitIndex}-title`}
                  type="text"
                  value={unit.title}
                  onChange={(event) => editUnit(unitIndex, "title", event.target.value)}
                />
                <span className="hint">The theme, as a learner would name it.</span>
              </p>
              <p className="row authoring-field">
                <label htmlFor={`authoring-unit-${unitIndex}-outcome`}>unit outcome</label>
                <input
                  id={`authoring-unit-${unitIndex}-outcome`}
                  type="text"
                  value={unit.outcome}
                  onChange={(event) => editUnit(unitIndex, "outcome", event.target.value)}
                />
                <span className="hint">
                  The can-do statement, e.g. “You can order food and be understood.” It may only
                  claim what this product measures — pronunciation and attendance.
                </span>
              </p>

              {unit.lessons.map((lesson, lessonIndex) => (
                <div key={lessonIndex} className="authoring-lesson">
                  <p className="row">
                    <label htmlFor={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-id`}>
                      lesson id
                    </label>
                    <input
                      id={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-id`}
                      type="text"
                      inputMode="numeric"
                      className="authoring-narrow"
                      value={lesson.id}
                      onChange={(event) =>
                        editLesson(unitIndex, lessonIndex, "id", event.target.value)
                      }
                    />
                  </p>
                  <p className="row authoring-field">
                    <label htmlFor={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-title`}>
                      lesson title
                    </label>
                    <input
                      id={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-title`}
                      type="text"
                      value={lesson.title}
                      onChange={(event) =>
                        editLesson(unitIndex, lessonIndex, "title", event.target.value)
                      }
                    />
                  </p>
                  <p className="row authoring-field">
                    <label htmlFor={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-outcome`}>
                      lesson outcome
                    </label>
                    <input
                      id={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-outcome`}
                      type="text"
                      value={lesson.outcome}
                      onChange={(event) =>
                        editLesson(unitIndex, lessonIndex, "outcome", event.target.value)
                      }
                    />
                    <span className="hint">What the sitting ends on.</span>
                  </p>
                  <p className="row authoring-field">
                    <label htmlFor={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-activityIds`}>
                      lesson activities
                    </label>
                    <input
                      id={`authoring-unit-${unitIndex}-lesson-${lessonIndex}-activityIds`}
                      type="text"
                      inputMode="numeric"
                      value={lesson.activityIds}
                      onChange={(event) =>
                        editLesson(unitIndex, lessonIndex, "activityIds", event.target.value)
                      }
                    />
                    <span className="hint">
                      Activity ids, separated by commas, in the order they are practised.
                    </span>
                  </p>
                  <p className="row">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => removeLesson(unitIndex, lessonIndex)}
                    >
                      Remove lesson {lessonIndex + 1} of unit {unitIndex + 1}
                    </button>
                  </p>
                </div>
              ))}

              <p className="row">
                <button type="button" className="ghost" onClick={() => addLesson(unitIndex)}>
                  Add a lesson to unit {unitIndex + 1}
                </button>
                <button type="button" className="ghost" onClick={() => removeUnit(unitIndex)}>
                  Remove unit {unitIndex + 1}
                </button>
              </p>
            </details>
          ))}

          <p className="row">
            <button type="button" className="ghost" onClick={addUnit}>
              Add a unit
            </button>
          </p>

          {problems.length > 0 && (
            <div className="authoring-problems" role="status">
              <p className="what">
                {problems.length === 1 ? "One thing" : `${problems.length} things`} to fix before
                this can be published:
              </p>
              <ul>
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}

          <p className="row">
            <button
              type="button"
              onClick={() => void publishDraft()}
              /* Two independent reasons, so a request in flight cannot be sent
                 twice and a set with known problems cannot be sent at all. */
              disabled={problems.length > 0 || busy !== "none"}
            >
              {busy === "publishing" ? "Publishing…" : `Publish as version ${latest + 1}`}
            </button>
          </p>

          {outcome !== null && (
            <div className="authoring-outcome" role="alert">
              <p className="what">{outcome.message}</p>
              {outcome.problems !== undefined && outcome.problems.length > 0 && (
                <ul>
                  {outcome.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      )}

      <section>
        <p className="row">
          <Link to="/">
            <button type="button" className="ghost">
              Back to today
            </button>
          </Link>
        </p>
      </section>
    </>
  );
}
