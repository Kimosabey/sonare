/**
 * Creating a class — Teacher board 1b.
 *
 * The board's framing decides the whole shape: "A join code rather than a
 * roster upload: identity here is anonymous and locally minted, so a class is
 * pupils choosing to attach themselves, never a list a teacher types in about
 * children."
 *
 * So there is no field here for a pupil. A teacher names the class, picks the
 * language, decides how pupils appear to them, and gets a code to put on the
 * board. Everything after that is somebody else's decision.
 *
 * ── the visibility setting is the interesting control ──────────────────────
 *
 * "Not at all" is a real option, not a courtesy. The board says why in one
 * line — "a name list is itself a privacy surface" — and the consequence is
 * spelled out beside each choice rather than left for a teacher to work out:
 * with names off, attendance is a count and nobody is named, which changes
 * what the class list can do for them.
 *
 * Both are reversible and the screen says so, because a setting that looks
 * permanent gets chosen defensively.
 */

import { useState } from "react";
import { LANGUAGES } from "../activities/languages/index.js";

export type NameVisibility = "first-name" | "anonymous";

export interface CreateClassProps {
  busy?: boolean;
  /** The code, once the class exists. Shown, never stored. */
  code?: string | null;
  error?: string | null;
  onCreate: (input: { name: string; teacherName: string; slug: string; visibility: NameVisibility }) => void;
  onOpen?: () => void;
}

export function CreateClass({
  busy = false,
  code = null,
  error = null,
  onCreate,
  onOpen,
}: CreateClassProps) {
  const [name, setName] = useState("");
  const [teacherName, setTeacherName] = useState("");
  const [slug, setSlug] = useState(LANGUAGES[0]?.slug ?? "fr");
  const [visibility, setVisibility] = useState<NameVisibility>("first-name");

  if (code !== null) {
    return (
      <section className="create-class">
        <h2>{name === "" ? "Your class" : name} is ready</h2>

        <p className="join-code" lang="en">
          {code}
        </p>
        <p className="hint create-class-code-note">Valid for this term · regenerate any time</p>

        <p>
          Put it on the board. A pupil enters it in their You tab, reads what joining shares, and
          decides. Nothing about them reaches you before that.
        </p>

        {onOpen !== undefined && (
          <p className="row">
            <button type="button" onClick={onOpen}>
              Open the class
            </button>
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="create-class">
      <h2>New class</h2>

      <p className="row">
        <label htmlFor="class-name">Class name</label>
        <input
          id="class-name"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </p>

      <p className="row">
        <label htmlFor="class-teacher">How pupils see you</label>
        <input
          id="class-teacher"
          type="text"
          value={teacherName}
          placeholder="Mr Okonjo"
          onChange={(event) => setTeacherName(event.target.value)}
        />
      </p>

      <p className="row">
        <label htmlFor="class-language">Language</label>
        {/*
          Only the languages this product actually has. The board lists five;
          offering one with no content would let a teacher create a class whose
          pupils have nothing to practise, and find out from them.
        */}
        <select
          id="class-language"
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

      <h3>How pupils appear to you</h3>
      <ul className="visibility-choices">
        <li>
          <label>
            <input
              type="radio"
              name="visibility"
              value="first-name"
              checked={visibility === "first-name"}
              onChange={() => setVisibility("first-name")}
            />
            <b>First name only</b>
            <span className="hint">What they typed, if they typed one.</span>
          </label>
        </li>
        <li>
          <label>
            <input
              type="radio"
              name="visibility"
              value="anonymous"
              checked={visibility === "anonymous"}
              onChange={() => setVisibility("anonymous")}
            />
            <b>Not at all</b>
            <span className="hint">Attendance as a count, nobody named.</span>
          </label>
        </li>
      </ul>
      <p className="hint">
        A name list is itself a privacy surface. Either setting can be changed later, and a pupil
        can always remove their own name.
      </p>

      {error !== null && (
        <p className="what" role="alert">
          {error}
        </p>
      )}

      <p className="row">
        <button
          type="button"
          onClick={() => onCreate({ name: name.trim(), teacherName: teacherName.trim(), slug, visibility })}
          disabled={busy || name.trim() === "" || teacherName.trim() === ""}
        >
          {busy ? "Creating…" : "Create the class"}
        </button>
      </p>
    </section>
  );
}
