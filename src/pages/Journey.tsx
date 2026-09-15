/**
 * The journey — board 1d, the outcomes list.
 *
 * Each unit is a can-do statement with its receipts underneath: lessons
 * finished, and the sounds holding at rung 3 or better. The receipts are the
 * point rather than decoration — a claim about what a learner can do, made by
 * software that measured them, has to show what it measured.
 *
 * ## No padlocks, anywhere
 *
 * Every unit and every lesson is openable, in any order. The rule between them
 * is the only thing that reads as sequence. That is a product decision with a
 * reason: a hard gate traps a learner on a sound they cannot yet make, and the
 * review ladder will bring it back round on its own — locking the course adds
 * nothing to that except the feeling of being stuck.
 *
 * So there are no disabled controls on this screen, and `journeyFor` has no
 * state meaning "not allowed" for one to be derived from.
 *
 * ## What it does when there is no course
 *
 * A language published before the spine existed is flat, and says so, with a
 * route into the activities. Inventing a unit to wrap them would mean inventing
 * a can-do statement, which is precisely the claim this screen may not make.
 */

import { Link, useParams } from "react-router-dom";
import { journeyFor } from "../learning/journey.js";
import { resolveLanguage } from "../content/resolve.js";
import { readProgress } from "../hooks/useProgressPersistence.js";
import { readSkills } from "../stores/skillStore.js";
import { useLearnerName } from "../hooks/useLearnerName.js";

/** "2 days ago", or null when there is nothing to date. */
function since(at: string | null, now: Date): string | null {
  if (at === null) return null;
  const days = Math.floor((now.getTime() - new Date(at).getTime()) / 86_400_000);
  if (Number.isNaN(days) || days < 0) return null;
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${String(days)} days ago`;
}

export function Journey() {
  const { slug } = useParams<{ slug: string }>();
  const [learnerName] = useLearnerName();
  const content = resolveLanguage(slug);

  if (content === undefined) {
    return (
      <section className="enter-1">
        <h1>No such language</h1>
        <p className="what">
          <Link to="/languages">Pick one that is here</Link>.
        </p>
      </section>
    );
  }

  const progress = readProgress(content.slug, learnerName).progress;
  const skills = readSkills(content.slug, learnerName);
  const journey = journeyFor(content, progress, skills);
  const now = new Date();

  if (journey.flat) {
    return (
      <section className="enter-1">
        <h1>{content.label}</h1>
        <p className="what">
          This language is a set of phrases rather than a course — there are no units yet, so there
          is nothing here to map.
        </p>
        <div className="row">
          <Link className="enter-cta" to={`/${content.slug}`}>
            Practise the phrases
          </Link>
        </div>
      </section>
    );
  }

  return (
    <section className="enter-1 journey">
      <h1>{content.label} · your journey</h1>
      <p className="what">
        {journey.units.length} units. You can open any of them, in any order.
      </p>

      <ol className="journey-units">
        {journey.units.map((unit) => {
          const practised = since(unit.lastPractisedAt, now);

          return (
            <li key={unit.id} className={`journey-unit is-${unit.state}`}>
              <div className="journey-unit-head">
                <h2>
                  Unit {unit.id}
                  {unit.state === "done" && " · done"}
                  {unit.state === "current" && " · you are here"}
                </h2>
                <span className="journey-count">
                  {unit.lessonsDone} of {unit.lessonsTotal}
                </span>
              </div>

              {/*
                The can-do statement, and whether it has been earned. Shown as
                a claim only when `outcomeEarned` — otherwise it is what the
                unit is *for*, which is a different sentence and must not be
                allowed to read as an achievement.
              */}
              <p className={unit.outcomeEarned ? "journey-outcome is-earned" : "journey-outcome"}>
                {unit.outcomeEarned && (
                  <span className="journey-tick" aria-label="met">
                    ✓
                  </span>
                )}
                {unit.outcome}
              </p>

              {/*
                The receipts. Every figure here is one a learner can go and
                check on Progress, which is what stops the claim above being an
                assertion they have to take on trust.
              */}
              <p className="hint journey-receipts">
                {unit.lessonsTotal} lessons
                {unit.touchedSounds.length > 0 && (
                  <>
                    {" · "}
                    {unit.holdingSounds.length} of {unit.touchedSounds.length} sounds holding
                  </>
                )}
                {practised !== null && <> · last practised {practised}</>}
              </p>

              {unit.touchedSounds.length > 0 && !unit.outcomeEarned && (
                <p className="hint">
                  Checked by: every lesson finished, and these sounds holding —{" "}
                  <span lang={journey.code}>{unit.touchedSounds.join(" · ")}</span>.
                </p>
              )}

              <ul className="journey-lessons">
                {unit.lessons.map((lesson) => (
                  <li key={lesson.id} className={`journey-lesson is-${lesson.state}`}>
                    {/*
                      A link, never a disabled button, whatever the state. See
                      the file comment: there are no padlocks on this screen.
                    */}
                    <Link to={`/${journey.slug}`}>
                      <span className="journey-lesson-mark" aria-hidden="true">
                        {lesson.state === "done" ? "✓" : lesson.state === "current" ? "▶" : "○"}
                      </span>
                      <span className="journey-lesson-title">{lesson.title}</span>
                      <span className="hint">
                        {lesson.state === "done"
                          ? "done"
                          : lesson.done > 0
                            ? `${String(lesson.total - lesson.done)} left`
                            : `${String(lesson.total)} activities`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ol>

      <p className="hint">
        No padlocks anywhere. The order shows what follows what, not what you are allowed to do.
      </p>
    </section>
  );
}
