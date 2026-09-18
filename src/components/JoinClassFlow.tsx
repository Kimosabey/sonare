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

import { useEffect, useState } from "react";
import { JoinClass } from "./JoinClass.js";
import { MyClass } from "./MyClass.js";
import {
  joinClass,
  leaveClass,
  myClasses,
  previewClass,
  removeMyName,
  type ClassPreview,
  type MyClass as Membership,
} from "../sync/classLink.js";

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
  /**
   * Classes this device is already in, read on mount.
   *
   * Without this the You tab forgot a membership the moment the page reloaded:
   * the join flow showed "you are in X" from local state and nothing asked the
   * server afterwards, so board 1h's mirror — the screen a pupil checks the
   * promise on — was reachable exactly once, immediately after joining.
   */
  const [memberships, setMemberships] = useState<Membership[]>([]);

  useEffect(() => {
    let live = true;
    void myClasses(learnerName).then((classes) => {
      if (live) setMemberships(classes);
    });
    return () => {
      live = false;
    };
  }, [learnerName, joined]);

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

  async function removeName(membership: Membership): Promise<void> {
    setBusy(true);
    const ok = await removeMyName(membership.classId, learnerName);
    setBusy(false);
    if (!ok) {
      setMessage("Couldn’t remove your name. It has not changed.");
      return;
    }
    setMemberships((current) =>
      current.map((c) => (c.classId === membership.classId ? { ...c, sharedName: null } : c)),
    );
  }

  async function leave(membership: Membership): Promise<void> {
    setBusy(true);
    const ok = await leaveClass(membership.classId, learnerName);
    setBusy(false);
    if (!ok) {
      setMessage("Couldn’t leave the class. Nothing has changed.");
      return;
    }
    setMemberships((current) => current.filter((c) => c.classId !== membership.classId));
    setJoined(null);
  }

  // A membership renders the mirror, whether it was joined a minute ago or a
  // term ago. `joined` only decides whether the code field is worth showing.
  if (memberships.length > 0) {
    return (
      <div className="join-flow">
        {memberships.map((membership) => (
          <MyClass
            key={membership.classId}
            className={membership.className}
            teacherName={membership.teacherName}
            joinedAt={membership.joinedAt}
            sharedName={membership.sharedName}
            busy={busy}
            onRemoveName={() => void removeName(membership)}
            onLeave={() => void leave(membership)}
          />
        ))}
        {message !== null && (
          <p className="what" role="alert">
            {message}
          </p>
        )}
      </div>
    );
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
