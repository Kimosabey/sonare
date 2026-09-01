/**
 * Four screens: the language picker (front door), the activity test for
 * whichever language is in the URL (:slug), and two internal-only screens
 * reached by typing the URL directly — /diagnostics and /fixture — with no
 * nav link to either anywhere in the product UI. HashRouter specifically:
 * URLs stay #/-prefixed exactly as before, which survives a direct visit or
 * refresh through a tunnel (ngrok) with zero server-side rewrite config — a
 * plain BrowserRouter would 404 on a fresh #/diagnostics visit without that
 * config.
 */

import { HashRouter, Routes, Route, Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { LanguagePicker } from "./pages/LanguagePicker.js";
import { ActivityTest } from "./pages/ActivityTest.js";
import { Diagnostics } from "./pages/Diagnostics.js";
import { FixtureRunner } from "./pages/FixtureRunner.js";
import { getLanguage, LANGUAGES } from "./activities/languages/index.js";

/**
 * React Router does NOT remount a component when only route params change
 * — navigating /fr -> /es matches the same path="/:slug" element, so
 * without this, switching languages would carry over the previous
 * language's session state (progress, started, even the previous
 * activity's target text briefly) instead of starting fresh. The key forces
 * a real unmount/remount on every slug change.
 */
function ActivityTestRoute() {
  const { slug } = useParams<{ slug: string }>();
  return <ActivityTest key={slug} />;
}

/**
 * The only way back to the language picker used to be the browser's own
 * back button — there was no in-app link once you were past it (see the
 * "no nav link anywhere" comment above). A single crumb is enough here:
 * the flow is two levels deep at most (picker -> one language's activities,
 * or picker -> diagnostics), never a real hierarchy to climb.
 *
 * On a language's activity page, the language name is itself a <select> —
 * jumping straight to another language, not just back to the picker. Safe
 * to do without warning: progress now persists per language+learner
 * (useProgressPersistence.ts), so switching away and back restores exactly
 * where the learner left off instead of losing the session.
 */
function Breadcrumb() {
  const location = useLocation();
  const navigate = useNavigate();
  if (location.pathname === "/") return null;

  const isDiagnostics = location.pathname === "/diagnostics";
  const isFixture = location.pathname === "/fixture";
  const slug = location.pathname.replace(/^\//, "");
  const language = !isDiagnostics && !isFixture ? getLanguage(slug) : undefined;

  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <Link to="/">Sonare</Link>
      {isDiagnostics && (
        <>
          <span aria-hidden="true">›</span>
          <span>Diagnostics</span>
        </>
      )}
      {isFixture && (
        <>
          <span aria-hidden="true">›</span>
          <span>Fixture</span>
        </>
      )}
      {language && (
        <>
          <span aria-hidden="true">›</span>
          <span className="breadcrumb-lang-wrap">
            <select
              className="breadcrumb-lang"
              aria-label="Switch language"
              value={language.slug}
              onChange={(e) => navigate(`/${e.target.value}`)}
            >
              {LANGUAGES.map((lang) => (
                <option key={lang.slug} value={lang.slug}>
                  {lang.label}
                </option>
              ))}
            </select>
            <span aria-hidden="true" className="breadcrumb-lang-caret">
              ▾
            </span>
          </span>
        </>
      )}
    </nav>
  );
}

function Header() {
  const location = useLocation();

  if (location.pathname === "/diagnostics") {
    return (
      <>
        <div className="eyebrow">Sonare · internal diagnostics</div>
        <h1>Diagnostics</h1>
      </>
    );
  }

  if (location.pathname === "/fixture") {
    return (
      <>
        <div className="eyebrow">Sonare · internal fixture recording</div>
        <h1>Fixture runner</h1>
      </>
    );
  }

  // Parsed straight from the path rather than via useParams() — the header
  // sits outside the <Routes> tree that actually matches /:slug, so it has
  // no route params of its own to read.
  const slug = location.pathname.replace(/^\//, "");
  const language = getLanguage(slug);

  return (
    <>
      <div className="eyebrow">Sonare · phoneme pronunciation scoring</div>
      <h1>{language ? `${language.label} speech activity` : "Speech activity"}</h1>
    </>
  );
}

function Shell() {
  return (
    <div className="wrap">
      <header>
        <img className="logo" src="/brand/wordmark-purple.png" alt="Lingotran" />
        <Breadcrumb />
        <Header />
      </header>

      <Routes>
        <Route path="/" element={<LanguagePicker />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
        <Route path="/fixture" element={<FixtureRunner />} />
        <Route path="/:slug" element={<ActivityTestRoute />} />
      </Routes>
    </div>
  );
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
