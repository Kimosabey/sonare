/**
 * Suggesting a lesson to a class — Teacher board 1f.
 *
 * The board's title for it is the whole constraint: "A suggestion to the
 * class, not an assignment with a deadline — no gate, and a pupil who cannot
 * speak today still has a way through, so the teacher's request cannot strand
 * anyone."
 *
 * Three things follow, and each is on the screen rather than implied:
 *
 * **"No particular time" is a real option**, listed with the other two rather
 * than offered as a way out of them. A timing control whose every value is a
 * deadline is a deadline control.
 *
 * **The microphone-free activity is named.** It is what makes a sitting
 * settable for homework at all — on a bus, in a shared room, or by a pupil
 * whose device is the reason half their takes come back unusable. Without that
 * line a teacher cannot tell which lessons are safe to set.
 *
 * **What the teacher will see afterwards is stated up front.** They will see
 * how many did it and whether the group's shape moved. Not who did well. A
 * teacher who is not told that will look for it, and the looking is what this
 * whole view is built to make impossible.
 */

import { useState } from "react";
import type { Activity, Lesson } from "../activities/types.js";

/** When a teacher suggests it for. None of these is enforced. */
export const SUGGESTION_WINDOWS = [
  { key: "this-week", label: "This week" },
  { key: "before-next-lesson", label: "Before next lesson" },
  { key: "no-particular-time", label: "No particular time" },
] as const;

export type SuggestionWindow = (typeof SUGGESTION_WINDOWS)[number]["key"];

export interface SetSittingProps {
  lesson: Lesson;
  /** The lesson's activities, in order. */
  activities: readonly Activity[];
  /** BCP-47 code, so the phrases carry their language. */
  code: string;
  /** How many pupils have joined, for the button. */
  joinedCount: number;
  busy?: boolean;
  onSuggest: (input: { lessonId: number; window: SuggestionWindow }) => void;
}

/** About five minutes for four activities — the sitting's own shape. */
const MINUTES_PER_ACTIVITY = 1.25;

/**
 * What to show for an activity, by kind.
 *
 * A `listen` activity's target is the **answer**, so the row describes the
 * task instead. Printing the phrase would put the answer on a screen a teacher
 * might project, which is a strange way to lose a question.
 */
function describes(activity: Activity): { text: string; inLanguage: boolean } {
  if (activity.kind === "listen") {
    return { text: "Pick the meaning — no microphone needed", inLanguage: false };
  }
  if (activity.kind === "recall") {
    return { text: `“${activity.gloss}” → say it in the language`, inLanguage: false };
  }
  return { text: activity.target, inLanguage: true };
}

export function SetSitting({
  lesson,
  activities,
  code,
  joinedCount,
  busy = false,
  onSuggest,
}: SetSittingProps) {
  const [window, setWindow] = useState<SuggestionWindow>("this-week");

  const sounds = [...new Set(activities.flatMap((a) => a.soundTargets ?? []))].sort();
  const minutes = Math.round(activities.length * MINUTES_PER_ACTIVITY);
  const micFree = activities.filter((a) => a.kind === "listen").length;

  return (
    <section className="set-sitting">
      <h2>{lesson.title}</h2>
      <p className="what">
        {activities.length} {activities.length === 1 ? "activity" : "activities"}, about {minutes}{" "}
        minutes.
        {sounds.length > 0 && (
          <>
            {" "}
            Targets <span lang={code}>{sounds.join(" and ")}</span>.
          </>
        )}
      </p>

      <ol className="sitting-activities">
        {activities.map((activity) => {
          const description = describes(activity);
          return (
            <li key={activity.id}>
              <span className="sitting-kind">{activity.kind}</span>
              <span {...(description.inLanguage ? { lang: code } : {})}>{description.text}</span>
            </li>
          );
        })}
      </ol>

      {micFree > 0 && (
        <p className="hint">
          {micFree === 1 ? "One activity needs" : `${micFree} activities need`} no microphone,
          which is what makes this settable for homework on a bus or in a shared room.
        </p>
      )}

      <h3>Suggest it for</h3>
      <ul className="sitting-windows">
        {SUGGESTION_WINDOWS.map((option) => (
          <li key={option.key}>
            <label>
              <input
                type="radio"
                name="suggestion-window"
                value={option.key}
                checked={window === option.key}
                onChange={() => setWindow(option.key)}
              />
              {option.label}
            </label>
          </li>
        ))}
      </ul>

      <h3>What this is not</h3>
      <p>
        It is a suggestion on their Today screen, not a lock. Pupils can do it late, do it partly,
        or move on from an activity after three tries — and you will see that they practised,
        never a mark for how it went.
      </p>

      <h3>You will be able to see</h3>
      <p>
        How many did it, and whether the group’s shape moved on{" "}
        {sounds.length > 0 ? <span lang={code}>{sounds[0]}</span> : "these sounds"} afterwards.
        That is the feedback loop — the class’s, not a pupil’s.
      </p>

      <p className="row">
        <button type="button" onClick={() => onSuggest({ lessonId: lesson.id, window })} disabled={busy}>
          {busy
            ? "Suggesting…"
            : `Suggest to ${joinedCount} ${joinedCount === 1 ? "pupil" : "pupils"}`}
        </button>
      </p>
    </section>
  );
}
