/**
 * What this publish does, shown before it is done — Platform board 1k.
 *
 * The board states the rule this screen is built on: "publishing never blocks
 * and never reaches into a sitting in flight — a client holds the version it
 * resolved until the sitting ends. So this screen's job is not a gate, it is
 * making one irreversible case visible."
 *
 * So nothing here can refuse a publish. The only friction is a typed phrase,
 * and it appears **only when the diff removes something**. A confirmation on
 * every publish is a confirmation nobody reads, and the one publish in fifty
 * that deserved a pause goes through on the same reflex as the rest — which is
 * the board's own reasoning for attaching the friction to the irreversible
 * case rather than to the act of publishing.
 *
 * ── the counts, and the three that are missing ──────────────────────────────
 *
 * The board's "Who this reaches" panel shows four figures: in a sitting right
 * now, mid-lesson, offline on an older version, and losing a started activity.
 * Only the last of those is something this system actually knows — it falls
 * out of the progress collection. The other three would need per-learner
 * session and resolved-version telemetry that is not recorded anywhere, and
 * inventing them is precisely the fabrication the product refuses everywhere
 * it reports a measurement. So this panel shows the count it has, names the
 * ones it does not, and says what happens to those learners regardless — which
 * is the part an operator actually needs, and is true without a number.
 */

import { useId, useState } from "react";
import type { ContentChange } from "../content/diff.js";

export interface PublishDiffProps {
  /** Shown to the operator, e.g. "French". */
  label: string;
  /** BCP-47 code for the content being published, e.g. "fr-FR". */
  code: string;
  fromVersion: number;
  toVersion: number;
  changes: ContentChange[];
  /**
   * Learners with attempts, per activity id.
   *
   * `null` means the count could not be fetched — distinct from an empty map,
   * which means it was fetched and nobody is affected. The screen must not
   * collapse those: one says a removal is safe, the other says nothing at all.
   */
  reach: Map<number, number> | null;
  busy?: boolean;
  onPublish: () => void;
  onBack: () => void;
}

/** "Unit 2 · Lesson 2 · activity 3", or as much of it as the set knows. */
function whereText(change: ContentChange): string {
  const { unitId, unitTitle, lessonId, lessonTitle } = change.where;
  const parts: string[] = [];
  if (unitId !== null) parts.push(`Unit ${unitId}${unitTitle === null ? "" : ` · ${unitTitle}`}`);
  if (lessonId !== null) {
    parts.push(`Lesson ${lessonId}${lessonTitle === null ? "" : ` · ${lessonTitle}`}`);
  }
  parts.push(`activity ${change.activityId}`);
  return parts.join(" · ");
}

export function PublishDiff({
  label,
  code,
  fromVersion,
  toVersion,
  changes,
  reach,
  busy = false,
  onPublish,
  onBack,
}: PublishDiffProps) {
  const [typed, setTyped] = useState("");
  const confirmId = useId();

  const removals = changes.filter((change) => change.kind === "removed");
  const reKeys = changes.filter(
    (change) => change.kind === "changed" && change.reKeysSoundHistory,
  );

  /**
   * The phrase carries the version number, so typing it is proof the operator
   * read *which* version they are publishing. Case and surrounding space are
   * folded — caps lock is not the thing being confirmed.
   */
  const phrase = `PUBLISH V${toVersion}`;
  const needsTyping = removals.length > 0;
  const confirmed = !needsTyping || typed.trim().toUpperCase() === phrase;

  return (
    <div className="publish-diff">
      <header className="publish-diff-head">
        <div>
          <h2>Publish {label} content</h2>
          <p className="publish-diff-versions">
            v{fromVersion} → v{toVersion} ·{" "}
            {changes.length === 1 ? "1 change" : `${changes.length} changes`}
          </p>
        </div>
        <button type="button" className="ghost" onClick={onBack}>
          Back to editing
        </button>
      </header>

      <h3>Changes, field by field</h3>

      {changes.length === 0 ? (
        <p className="hint">
          Nothing differs from v{fromVersion}. There is nothing to publish.
        </p>
      ) : (
        <ul className="publish-diff-list">
          {changes.map((change) => {
            const key =
              change.kind === "changed"
                ? `${change.kind}-${change.activityId}-${change.field}`
                : `${change.kind}-${change.activityId}`;

            if (change.kind === "added") {
              return (
                <li key={key} className="diff-entry diff-added">
                  <span className="diff-tag">Added</span>
                  <p className="diff-where">{whereText(change)}</p>
                  <p className="diff-kind">{change.activity.kind}</p>
                  <p className="diff-target" lang={code}>
                    {change.activity.target}
                  </p>
                  <p className="hint">
                    New, so no learner has a record against it yet. It reaches everyone on
                    their next sitting.
                  </p>
                </li>
              );
            }

            if (change.kind === "changed") {
              return (
                <li key={key} className="diff-entry diff-changed">
                  <span className="diff-tag">Changed</span>
                  <p className="diff-where">
                    {whereText(change)} · {change.field}
                  </p>
                  <p className="diff-before">
                    <span aria-hidden="true">− </span>
                    <span className="visually-hidden">Was: </span>
                    <span lang={change.field === "target" ? code : undefined}>
                      {change.before === "" ? "(empty)" : change.before}
                    </span>
                  </p>
                  <p className="diff-after">
                    <span aria-hidden="true">+ </span>
                    <span className="visually-hidden">Now: </span>
                    <span lang={change.field === "target" ? code : undefined}>
                      {change.after === "" ? "(empty)" : change.after}
                    </span>
                  </p>
                  {change.reKeysSoundHistory ? (
                    <p className="diff-consequence">
                      This re-keys the syllables the activity measures. Sound history
                      collected against the old phrase stays in every learner’s record but
                      stops matching this activity, which starts again from no history.
                    </p>
                  ) : (
                    <p className="hint">
                      Target text untouched, so no sound history is affected.
                    </p>
                  )}
                </li>
              );
            }

            const affected = reach?.get(change.activityId);
            return (
              <li key={key} className="diff-entry diff-removed">
                <span className="diff-tag">Removed</span>
                <p className="diff-where">{whereText(change)}</p>
                <p className="diff-kind">{change.activity.kind}</p>
                <p className="diff-target" lang={code}>
                  {change.activity.target}
                </p>
                <p className="diff-consequence">
                  {reach === null
                    ? "Could not check how many learners have attempts against this activity."
                    : affected === undefined
                      ? "No learner has attempts against this activity."
                      : affected === 1
                        ? "1 learner has attempts against this activity."
                        : `${affected} learners have attempts against this activity.`}{" "}
                  Their takes and sound history stay in their record — nothing is erased —
                  but the activity stops resolving, so it disappears from their lesson and
                  from any outcome that counted it.
                </p>
              </li>
            );
          })}
        </ul>
      )}

      <section className="publish-diff-reach">
        <h3>Who this reaches</h3>
        <p>
          The learners in a sitting right now finish on v{fromVersion} and pick up v
          {toVersion} on their next one. Nothing mid-take is interrupted, and a learner
          offline keeps practising from their bundle either way.
        </p>
        <p className="hint">
          How many are in a sitting, how many are mid-lesson, and how many are still on an
          older version are not recorded, so they are not shown. The counts above are the
          ones this server can answer: learners who have actually practised an activity
          being removed.
        </p>
        {removals.length > 1 ? (
          <p className="hint">
            Counted per activity, not added up — one learner may have attempts against
            several of these.
          </p>
        ) : null}
      </section>

      <section className="publish-diff-forward">
        <h3>Forward only</h3>
        <p>
          There is no unpublish. Correcting a mistake means publishing v{toVersion + 1}, so
          the number only ever goes up.
        </p>
      </section>

      {needsTyping ? (
        <div className="publish-diff-confirm">
          <label htmlFor={confirmId}>
            Type <b>{phrase}</b> to confirm{" "}
            {removals.length === 1 ? "the removal" : `${removals.length} removals`}
          </label>
          <input
            id={confirmId}
            type="text"
            value={typed}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setTyped(event.target.value)}
          />
        </div>
      ) : (
        <p className="hint">
          {reKeys.length > 0
            ? "Nothing is removed by this publish, so it takes one click."
            : "Nothing is removed by this publish, so it takes one click and no typing."}
        </p>
      )}

      <button type="button" onClick={onPublish} disabled={busy || !confirmed}>
        {busy ? "Publishing…" : `Publish v${toVersion}`}
      </button>
    </div>
  );
}
