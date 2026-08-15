/**
 * Language + reference text picker.
 *
 * Preloaded phrases make a fixture run fast and consistent; free entry stays
 * available because the phrase list is a starting point, not a closed set.
 *
 * Changing language swaps to that language's first phrase — scoring French
 * audio against an English reference produces a confidently wrong number, and
 * the UI should not make that easy to do by accident.
 */

import { LANGUAGE_LABELS, LANGUAGES, firstPhraseFor, phrasesFor } from "../../phrases.js";

const CUSTOM = "__custom__";

interface PhraseSelectorProps {
  language: string;
  referenceText: string;
  onChange: (next: { language: string; referenceText: string }) => void;
  disabled?: boolean;
}

export function PhraseSelector({ language, referenceText, onChange, disabled }: PhraseSelectorProps) {
  const phrases = phrasesFor(language);
  const matched = phrases.find((p) => p.text === referenceText);
  const selectValue = matched ? matched.text : CUSTOM;

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
              const next = e.target.value;
              onChange({ language: next, referenceText: firstPhraseFor(next) });
            }}
          >
            {LANGUAGES.map((l) => (
              <option key={l} value={l}>
                {LANGUAGE_LABELS[l] ?? l} · {l}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="preset">Preloaded phrase</label>
          <select
            id="preset"
            value={selectValue}
            disabled={disabled || phrases.length === 0}
            onChange={(e) => {
              if (e.target.value === CUSTOM) return;
              onChange({ language, referenceText: e.target.value });
            }}
          >
            {phrases.map((p) => (
              <option key={p.text} value={p.text}>
                {p.text}
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
