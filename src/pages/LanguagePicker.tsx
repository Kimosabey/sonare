/**
 * The new front door — was implicitly "always French" before. Picking a
 * language is now a real step, so it gets its own screen rather than a
 * dropdown buried in settings.
 *
 * Also where a learner's name is captured: asked once, before the first
 * language pick, then remembered — so attempts and diagnostics can be
 * attributed to a person instead of only an opaque session id.
 */

import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { LANGUAGES } from "../activities/languages/index.js";
import { useLearnerName } from "../ui/useLearnerName.js";
import { DeviceMetaPanel } from "../ui/DeviceMetaPanel.js";

export function LanguagePicker() {
  const [name, setName] = useLearnerName();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);

  if (!name || editing) {
    const submit = (e: FormEvent) => {
      e.preventDefault();
      const trimmed = draft.trim();
      if (!trimmed) return;
      setName(trimmed);
      setEditing(false);
    };

    return (
      <section>
        <h2 className="enter-1">What should we call you?</h2>
        <p className="what enter-2">So your results are yours, not just a session number.</p>

        <form onSubmit={submit}>
          <label htmlFor="learner-name">Your name</label>
          <input
            id="learner-name"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. Priya"
            maxLength={60}
            autoFocus
            autoComplete="off"
          />
          <div className="row">
            <button type="submit" className="enter-cta" disabled={!draft.trim()}>
              Continue
            </button>
          </div>
        </form>
      </section>
    );
  }

  return (
    <section>
      <h2 className="enter-1">Which language?</h2>
      <p className="what enter-2">
        Ten short activities per language, phoneme-level pronunciation scoring.
      </p>
      <p className="hint enter-2">
        Hi, {name}.{" "}
        <button
          type="button"
          onClick={() => {
            setDraft(name);
            setEditing(true);
          }}
        >
          Not you?
        </button>
      </p>

      <div className="lang-grid">
        {LANGUAGES.map((lang, i) => (
          <Link
            key={lang.slug}
            to={`/${lang.slug}`}
            className="lang-card enter-1"
            style={{ animationDelay: `${i * 60}ms` }}
          >
            <span className="lang-card-label">{lang.label}</span>
            <span className="lang-card-count">{lang.activities.length} activities</span>
          </Link>
        ))}
      </div>

      <DeviceMetaPanel />
    </section>
  );
}
