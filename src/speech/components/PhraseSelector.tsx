/**
 * Language + reference text picker for the fixture runner.
 *
 * Restored from git history (commit c52fcb3, removed in 5764ef8) and adapted:
 * the original pulled from a standalone src/phrases.ts phrase bank, which no
 * longer exists. This reuses the real per-language activity targets in
 * src/activities/languages/ instead of maintaining a second, divergent list —
 * those already carry a `focus` note per phrase (what sound it's designed to
 * expose), exactly what whoever runs the fixture needs to read a low score.
 * Free entry stays available: PRD §8's actual Set A/B words are unlikely to
 * be exactly these ten activity sentences.
 *
 * Changing language swaps to that language's first activity target —
 * scoring French audio against an English reference produces a confidently
 * wrong number, and the UI should not make that easy to do by accident.
 */

import { LANGUAGES } from "../../activities/languages/index.js";

const CUSTOM = "__custom__";

interface PhraseSelectorProps {
  language: string;
  referenceText: string;
  onChange: (next: { language: string; referenceText: string }) => void;
  disabled?: boolean;
}

export function PhraseSelector({ language, referenceText, onChange, disabled }: PhraseSelectorProps) {
  const activeLanguage = LANGUAGES.find((l) => l.code === language) ?? LANGUAGES[0];
  const activities = activeLanguage?.activities ?? [];
  const matched = activities.find((a) => a.target === referenceText);
  const selectValue = matched ? matched.target : CUSTOM;

  return (
    <>
      <div className="half">
        <div>
          <label htmlFor="lang">Language</label>
          <select
            id="lang"
            value={language}
            disabled={disabled}
            onChange={(e) => {
              const next = LANGUAGES.find((l) => l.code === e.target.value);
              onChange({ language: e.target.value, referenceText: next?.activities[0]?.target ?? "" });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label} · {l.code}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="preset">Preloaded phrase</label>
          <select
            id="preset"
            value={selectValue}
            disabled={disabled || activities.length === 0}
            onChange={(e) => {
              if (e.target.value === CUSTOM) return;
              onChange({ language, referenceText: e.target.value });
            }}
          >
            {activities.map((a) => (
              <option key={a.id} value={a.target}>
                {a.target}
              </option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </select>
        </div>
      </div>

      <label htmlFor="ref">Reference text — what they should say</label>
      <input
        id="ref"
        type="text"
        value={referenceText}
        spellCheck={false}
        disabled={disabled}
        placeholder="Type any phrase to score against"
        onChange={(e) => onChange({ language, referenceText: e.target.value })}
      />

      {matched && <p className="hint">Targets: {matched.focus}</p>}
    </>
  );
}
