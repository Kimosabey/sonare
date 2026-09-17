/**
 * Typing a code, reading what it means, then deciding — board 1c, end to end.
 *
 * Three states, and the order is the design: **code → decision → joined**. The
 * decision screen sits between looking a class up and joining it, because the
 * board's whole point is that a pupil sees the consequences before they agree.
 * Collapsing the two calls would make typing a code the act of joining.
 *
 * Nothing about the pupil reaches the server during the first step. The
 * preview is unauthenticated and returns only the class's own name, the
 * teacher's name and the language — so a pupil who types a code and changes
 * their mind has told nobody anything.
 */

import { useState } from "react";
import { JoinClass } from "./JoinClass.js";
import { joinClass, previewClass, type ClassPreview } from "../sync/classLink.js";

export interface JoinClassFlowProps {
  /** Which learner on this device is joining. */
  learnerName: string | null;
  /** Called once a join succeeds, so the You tab can show the class. */
  onJoined?: (classId: string) => void;
}

export function JoinClassFlow({ learnerName, onJoined }: JoinClassFlowProps) {
  const [code, setCode] = useState("");
  const [preview, setPreview] = useState<ClassPreview | null>(null);
  const [joined, setJoined] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function look(): Promise<void> {
    setBusy(true);
    setMessage(null);
    const result = await previewClass(code);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setPreview(result.preview);
  }

  async function decide(shareName: boolean): Promise<void> {
    setBusy(true);
    setMessage(null);
    const result = await joinClass(code, learnerName, shareName ? learnerName : null);
    setBusy(false);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setPreview(null);
    setJoined(preview?.name ?? "your class");
    onJoined?.(result.classId);
  }

  if (joined !== null) {
    return (
      <div className="join-flow">
        <h3>You are in {joined}</h3>
        <p className="hint">
          You can leave at any time, and remove your name without leaving.
        </p>
      </div>
    );
  }

  if (preview !== null) {
    return (
      <JoinClass
        className={preview.name}
        teacherName={preview.teacherName}
        learnerName={learnerName}
        busy={busy}
        onJoin={({ shareName }) => void decide(shareName)}
        /*
          Declining returns to the code field rather than clearing the section
          away. "Not now" is a postponement, and a pupil who mistypes and backs
          out should not have to find the feature again.
        */
        onDecline={() => setPreview(null)}
      />
    );
  }

  return (
    <div className="join-flow">
      <h3>Join a class</h3>
      <p className="hint">
        If your teacher has given you a code, enter it here. You will see exactly what they
        would be able to see before you decide.
      </p>
      <p className="row">
        <label htmlFor="join-code">Class code</label>
        <input
          id="join-code"
          type="text"
          value={code}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="characters"
          onChange={(event) => setCode(event.target.value)}
        />
      </p>
      <p className="row">
        <button type="button" onClick={() => void look()} disabled={busy || code.trim() === ""}>
          {busy ? "Looking…" : "Look up the class"}
        </button>
      </p>
      {message !== null && (
        <p className="what" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
