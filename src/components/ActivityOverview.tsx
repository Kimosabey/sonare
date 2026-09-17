/**
 * Every activity in the set at once — Platform board 1h's right-hand table.
 *
 * The board's own framing is "operator density … with the sounds it targets as
 * a first-class field". That is the whole reason this exists as a table rather
 * than as the list of collapsed editors it sits above. `soundTargets` is the
 * field that decides what the scheduler can offer and for what reason, and in
 * a stack of disclosures it is the seventh row inside the eighth panel — so a
 * set where half the activities target nothing looks exactly like a set where
 * none do, and the only way to find out is to open all of them.
 *
 * Read-only. Clicking a row selects an activity for the editor rather than
 * editing in place: a table cell that is also a text input is a control that
 * loses work to a stray click, and the fields differ by kind.
 *
 * ── the `listen` row ───────────────────────────────────────────────────────
 *
 * A `listen` activity asks nothing of the microphone, so it scores no sounds
 * and its `soundTargets` are not a gap to be filled. Its cell says so in
 * words. Leaving it empty would read as an authoring oversight and invite
 * somebody to "fix" it by adding targets the activity cannot measure.
 */

import type { DraftActivity } from "../content/draft.js";

export interface ActivityOverviewProps {
  activities: DraftActivity[];
  /** BCP-47 code, so target phrases are marked as the language being learnt. */
  code: string;
  selected: number | null;
  onSelect: (index: number) => void;
}

/** What the board prints in the sounds cell for an activity that scores none. */
export const NO_SOUNDS_SCORED = "— no mic, no sounds scored";

export function ActivityOverview({ activities, code, selected, onSelect }: ActivityOverviewProps) {
  if (activities.length === 0) {
    return <p className="hint">No activities yet.</p>;
  }

  return (
    <div className="table-scroll">
      <table className="activity-overview">
        <caption className="visually-hidden">
          Every activity in this set, with the sounds each one targets
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Kind</th>
            <th scope="col">Target</th>
            <th scope="col">Sounds targeted</th>
          </tr>
        </thead>
        <tbody>
          {activities.map((activity, index) => {
            const targets = activity.soundTargets
              .split(",")
              .map((s) => s.trim())
              .filter((s) => s.length > 0);

            return (
              <tr key={index} className={selected === index ? "is-selected" : undefined}>
                <td>
                  {/* The row's control is a button rather than a click handler
                      on the <tr>: a row is not focusable and not announced as
                      actionable, so a keyboard or screen-reader operator would
                      have no way to reach the editor at all. */}
                  <button
                    type="button"
                    className="ghost activity-overview-pick"
                    onClick={() => onSelect(index)}
                    aria-current={selected === index ? "true" : undefined}
                  >
                    {activity.id.trim() === "" ? "?" : activity.id}
                  </button>
                </td>
                <td className="activity-overview-kind">{activity.kind}</td>
                <td lang={code}>
                  {activity.target.trim() === "" ? (
                    <span className="hint">(empty)</span>
                  ) : (
                    activity.target
                  )}
                </td>
                <td>
                  {activity.kind === "listen" ? (
                    <span className="hint">{NO_SOUNDS_SCORED}</span>
                  ) : targets.length === 0 ? (
                    /* Not the same sentence as the `listen` row, and not the
                       same situation. This activity *does* score sounds and
                       has been told none, so the scheduler can offer it only
                       as a fallback and never for a reason. */
                    <span className="hint">none — offered without a reason</span>
                  ) : (
                    <span className="activity-overview-sounds" lang={code}>
                      {targets.join(" · ")}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
