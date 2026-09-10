/**
 * The screen behind the deletion endpoint, and the export it was missing.
 *
 * `DELETE /api/v1/learners/me` has erased a learner across every collection,
 * reported what it removed, and been covered end-to-end for some time. Nothing
 * called it. A right that can only be exercised by somebody with a terminal is
 * not a right, so this screen is the whole point of the endpoint rather than a
 * decoration on it.
 *
 * Three properties this file is built around:
 *
 * **One deletion path.** The server endpoint is the mechanism; nothing here
 * reimplements any part of it. The counts shown are the counts it returned,
 * not counts assembled locally — a screen that computed its own totals could
 * report a successful deletion of records that are still there.
 *
 * **The confirmation is a deliberate act.** Not a bare button, and not a
 * native `confirm()` either: the learner types the word. This is irreversible
 * and there is no undo anywhere behind it, so the cost of the gesture should
 * be proportionate to the cost of the mistake.
 *
 * **Per-learner storage, never per-device.** Two learners on one shared device
 * have separate ids, tokens, progress, skills and streaks, all keyed by the
 * name they chose (learnerId.ts, tokenStore.ts) — because they previously
 * collided into a single server identity and pooled their records. Every clear
 * here goes through those modules' own per-learner functions, so erasing one
 * learner cannot reach the other's keys. The classroom tablet is the stated
 * commercial surface; this is exactly the wrong thing to get wrong twice.
 *
 * Deliberately carries no policy, consent, notice or retention wording. What
 * is on screen is a factual account of what the two buttons do and what they
 * did — that is engineering. What a learner should be *told* about retention
 * is the owner's decision, and inventing it here would put words in their
 * mouth.
 */

import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { resolveLanguages } from "../content/resolve.js";
import { useLearnerName } from "../hooks/useLearnerName.js";
import { useTheme } from "../hooks/useTheme.js";
import { THEMES, type Theme } from "../lib/theme.js";
import { clearProgress, readProgress } from "../hooks/useProgressPersistence.js";
import { clearLearnerId, readLearnerId } from "../lib/learnerId.js";
import { clearSkills, readSkills } from "../stores/skillStore.js";
import { clearStreak, readStreak } from "../stores/streakStore.js";
import { clearAllDirty, readDirty } from "../sync/dirty.js";
import { clearToken, ensureToken } from "../sync/tokenStore.js";

/**
 * Typed to confirm. Matched case-insensitively after trimming: requiring an
 * exact capitalisation would turn a phone keyboard's autocapitalise into a
 * puzzle, and the deliberate act being asked for is typing a specific word,
 * not typing it in a specific case.
 */
const CONFIRM_WORD = "DELETE";

/**
 * What each theme is called on screen.
 *
 * "System" rather than "Auto": it names where the setting comes from, which is
 * the thing a learner needs in order to know why the app is dark when they did
 * not ask for it. "Auto" describes a behaviour and leaves the cause a mystery.
 */
const THEME_LABELS: Record<Theme, string> = {
  system: "System",
  light: "Light",
  dark: "Dark",
};

const THEME_EXPLANATIONS: Record<Theme, string> = {
  system: "Follows your device's appearance setting.",
  light: "Always light, whatever your device is set to.",
  dark: "Always dark, whatever your device is set to.",
};

/** What the server returned. Read defensively — it crossed a network. */
interface ExportPayload {
  format?: unknown;
  exportedAt?: unknown;
  learnerId?: unknown;
  collections?: Record<string, unknown>;
  truncated?: Record<string, unknown>;
}

interface DeleteReport {
  attempts: number;
  diagnostics: number;
}

/**
 * Which action failed, so the message renders beside the button that caused
 * it.
 *
 * One banner at the foot of the screen was the first version. On a phone the
 * deletion controls are below the fold, so a failed deletion put its only
 * explanation somewhere the learner was not looking — and "nothing appeared to
 * happen" after pressing that button is the worst possible outcome.
 */
interface ActionError {
  where: "export" | "delete";
  message: string;
}

interface ExportReport {
  /** Collection name to the number of documents in it. */
  counts: Array<[string, number]>;
  /** Collections the server said it had to cut short. */
  truncated: string[];
  filename: string;
}

/** How many documents a collection's value represents. */
function countOf(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  // `streaks` and `learners` hold one document or none, because the export's
  // keys are collection names rather than shapes.
  return value === null || value === undefined ? 0 : 1;
}

function numberFrom(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Everything this device holds for one learner, read through the typed
 * readers rather than by scanning `localStorage`.
 *
 * Scanning by key prefix was the obvious way to write this and the wrong one:
 * the keys end in a learner's chosen name, so a prefix scan is one filtering
 * mistake away from putting somebody else's practice record in this learner's
 * export. Going through each store's own per-learner reader makes that
 * impossible by construction instead of by care.
 *
 * Included in the saved file because the deletion below clears it. An export
 * that covered less than the delete would leave a learner unable to keep the
 * part they are about to lose — and the device's copy is the *richer* one: it
 * holds every individual take, which the server never receives.
 */
function deviceRecord(learnerName: string | null): Record<string, unknown> {
  return {
    learnerName,
    learnerId: readLearnerId(learnerName),
    streak: readStreak(learnerName),
    pendingSync: readDirty(learnerName),
    languages: resolveLanguages().map((language) => ({
      slug: language.slug,
      progress: readProgress(language.slug, learnerName),
      skills: readSkills(language.slug, learnerName),
    })),
  };
}

/**
 * Clears this learner's own keys, and only theirs.
 *
 * Every call is a per-learner function from the module that owns the key, so
 * the other learner on a shared device is untouched — see the file comment.
 * The learner's chosen name (`sonare.learnerName`) is deliberately left: it is
 * the device's current-learner pointer rather than a record of practice, and
 * whether "delete everything" should also make the app forget who is using it
 * is a product decision, not this file's.
 *
 * The identity goes last. Nothing above is keyed on it — every local key is
 * keyed on the name — so the order is not load-bearing, but it mirrors the
 * server route, where the learner record is removed last so a part-way failure
 * leaves the retry able to find everything.
 */
function eraseDevice(learnerName: string | null): void {
  for (const language of resolveLanguages()) {
    clearProgress(language.slug, learnerName);
    clearSkills(language.slug, learnerName);
  }
  clearStreak(learnerName);
  clearAllDirty(learnerName);
  clearToken(learnerName);
  clearLearnerId(learnerName);
}

/**
 * Hands the learner a file. No library: an object URL and a synthetic click is
 * the whole mechanism, and it is what two other screens here already do.
 */
function save(filename: string, json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** A server error's own wording where there is one, so it is not paraphrased. */
async function userMessageFrom(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { userMessage?: unknown } };
    const message = body.error?.userMessage;
    return typeof message === "string" && message.length > 0 ? message : fallback;
  } catch {
    return fallback;
  }
}

export function Settings() {
  const [learnerName] = useLearnerName();
  const [theme, setTheme] = useTheme();
  const [busy, setBusy] = useState<"none" | "export" | "delete">("none");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<ActionError | null>(null);
  const [exported, setExported] = useState<ExportReport | null>(null);
  const [deleted, setDeleted] = useState<DeleteReport | null>(null);

  const confirmed = confirmation.trim().toUpperCase() === CONFIRM_WORD;

  /**
   * The token, registering for one if this browser has none.
   *
   * Registering in order to delete looks odd and is the honest thing: the id
   * authorises nothing on its own, so there is no way to ask the server about
   * a learner without presenting a signed token for them. A learner who has
   * never synced has nothing stored, and the deletion truthfully reports zero.
   */
  const authorise = useCallback(
    async (where: ActionError["where"]): Promise<string | null> => {
      const token = await ensureToken({ displayName: learnerName });
      if (token === null) {
        setError({
          where,
          message:
            "This device could not identify itself to the server. Check your connection and try again.",
        });
        return null;
      }
      return token;
    },
    [learnerName],
  );

  const runExport = useCallback(async () => {
    setBusy("export");
    setError(null);
    setExported(null);

    try {
      const token = await authorise("export");
      if (token === null) return;

      const response = await fetch("/api/v1/learners/me/export", {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        setError({
          where: "export",
          message: await userMessageFrom(
            response,
            "Your data could not be exported. Please try again.",
          ),
        });
        return;
      }

      const payload = (await response.json()) as ExportPayload;
      const collections = payload.collections ?? {};
      const truncated = payload.truncated ?? {};

      /**
       * The server's payload verbatim, plus this device's copy. Nothing is
       * reshaped or summarised on the way through: the file is the record, and
       * a screen that rewrote it would be handing over its own account of the
       * data rather than the data.
       */
      const file = { server: payload, device: deviceRecord(learnerName) };
      const filename = `sonare-data-export-${new Date().toISOString().slice(0, 10)}.json`;
      save(filename, JSON.stringify(file, null, 2));

      setExported({
        counts: Object.entries(collections).map(([name, value]) => [name, countOf(value)]),
        truncated: Object.entries(truncated)
          .filter(([, cut]) => cut === true)
          .map(([name]) => name),
        filename,
      });
    } catch {
      // Offline, blocked, aborted. Nothing was saved and nothing was changed.
      setError({
        where: "export",
        message: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setBusy("none");
    }
  }, [authorise, learnerName]);

  const runDelete = useCallback(async () => {
    if (!confirmed) return;
    setBusy("delete");
    setError(null);
    setDeleted(null);

    try {
      const token = await authorise("delete");
      if (token === null) return;

      const response = await fetch("/api/v1/learners/me", {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        /**
         * The device's copy is kept. A part-way server deletion is idempotent
         * and retrying finishes it, but clearing the only remaining copy of a
         * learner's practice because the server failed would destroy data the
         * failure did not touch.
         */
        setError({
          where: "delete",
          message: await userMessageFrom(
            response,
            "Your data was not fully deleted. Please try again.",
          ),
        });
        return;
      }

      const body = (await response.json()) as { attempts?: unknown; diagnostics?: unknown };
      // Only once the server has confirmed.
      eraseDevice(learnerName);
      setConfirmation("");
      setDeleted({ attempts: numberFrom(body.attempts), diagnostics: numberFrom(body.diagnostics) });
      // Anything on screen from before now describes data that is gone.
      setExported(null);
    } catch {
      setError({
        where: "delete",
        message:
          "Could not reach the server. Nothing was deleted. Check your connection and try again.",
      });
    } finally {
      setBusy("none");
    }
  }, [authorise, confirmed, learnerName]);

  return (
    <>
      <section>
        <h2>Appearance</h2>
        <p className="what">
          The dark palette is measured against both dark surfaces, so text stays readable on
          the panels that carry the most of it.
        </p>

        {/*
          A plain element wired up with aria-labelledby rather than a <label
          htmlFor>: this heads a group of three buttons, and a label
          associates its text with one element and renames it — which is how
          the middle sensitivity button in CaptureSettings lost its own
          accessible name. Same reasoning, same shape. See base.css.
        */}
        <span className="field-label" id="theme-heading">
          Theme
        </span>
        <div className="modes" role="group" aria-labelledby="theme-heading">
          {THEMES.map((option) => (
            <button
              key={option}
              type="button"
              /*
                aria-pressed, matching the sensitivity toggle: three buttons of
                which exactly one is on. A radiogroup would also be defensible
                and would need arrow-key handling to be correct — pressed
                buttons are what this app already uses and already styles.
              */
              aria-pressed={theme === option}
              onClick={() => setTheme(option)}
            >
              {THEME_LABELS[option]}
            </button>
          ))}
        </div>

        {/* Says what the current choice means, so "System" is not a mystery. */}
        <p className="hint">{THEME_EXPLANATIONS[theme]}</p>
      </section>

      <section>
        <h2>Export your data</h2>
        <p className="what">
          Saves a JSON file of everything the server holds for
          {learnerName === null ? " this device" : ` ${learnerName}`}, together with this
          device&rsquo;s own copy.
        </p>

        <p className="row">
          <button
            type="button"
            onClick={() => void runExport()}
            disabled={busy !== "none"}
          >
            {busy === "export" ? "Preparing…" : "Export my data"}
          </button>
        </p>

        {error?.where === "export" && (
          <p className="hint" role="alert">
            {error.message}
          </p>
        )}

        {exported !== null && (
          <div className="settings-report" role="status">
            <p className="what">
              Saved <b>{exported.filename}</b>.
            </p>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Collection</th>
                    <th scope="col">Records</th>
                  </tr>
                </thead>
                <tbody>
                  {exported.counts.map(([name, count]) => (
                    <tr key={name}>
                      <td>{name}</td>
                      <td className="num">{count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {exported.truncated.length > 0 && (
              /* Said out loud rather than left as a history that stops at a
                 round number. */
              <p className="hint">
                Capped by the server: {exported.truncated.join(" and ")} holds only its most
                recent records.
              </p>
            )}
          </div>
        )}
      </section>

      <section className="danger-zone">
        <h2>Delete everything</h2>
        <p className="what">
          Erases this learner&rsquo;s record from the server and clears it from this device.
          This cannot be undone, and there is no copy to restore from.
        </p>

        <label htmlFor="settings-confirm">Type {CONFIRM_WORD} to confirm</label>
        <input
          id="settings-confirm"
          type="text"
          value={confirmation}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setConfirmation(event.target.value)}
        />

        <p className="row">
          <button
            type="button"
            className="danger"
            onClick={() => void runDelete()}
            /* Two independent reasons, so a request in flight cannot be sent
               twice and an untyped confirmation cannot be sent at all. */
            disabled={!confirmed || busy !== "none"}
          >
            {busy === "delete" ? "Deleting…" : "Delete everything"}
          </button>
        </p>

        {error?.where === "delete" && (
          <p className="hint" role="alert">
            {error.message}
          </p>
        )}

        {deleted !== null && (
          <div className="settings-report" role="status">
            {/*
              The counts are the endpoint's own. It returns a figure for the
              two trails and none for the rest, so the rest are named without
              inventing numbers for them — a fabricated count on a deletion
              report is worse than no count, because it looks like evidence.
            */}
            <p className="what">
              Deleted from the server: <b>{deleted.attempts}</b>{" "}
              {deleted.attempts === 1 ? "attempt" : "attempts"} and <b>{deleted.diagnostics}</b>{" "}
              {deleted.diagnostics === 1 ? "error report" : "error reports"}, plus your progress,
              sounds, streak, rate-limit windows and learner record — the endpoint returns no
              count for those.
            </p>
            <p className="what">
              Cleared on this device: progress, sounds, streak, pending sync flags, and this
              device&rsquo;s learner id and token.
            </p>
          </div>
        )}
      </section>

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
