/**
 * The new front door — was implicitly "always French" before. Picking a
 * language is now a real step, so it gets its own screen rather than a
 * dropdown buried in settings.
 */

import { Link } from "react-router-dom";
import { LANGUAGES } from "../activities/languages/index.js";

export function LanguagePicker() {
  return (
    <section>
      <h2 className="enter-1">Which language?</h2>
      <p className="what enter-2">
        Ten short activities per language, phoneme-level pronunciation scoring.
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
    </section>
  );
}
