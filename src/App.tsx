/**
 * Today is the front door: one tap to whatever the learner was last doing.
 * The language picker moved to /languages, because a returning learner had
 * been made to answer a question they already had. Then the activity test for
 * whichever language is in the URL (:slug), and three internal-only screens
 * reached by typing the URL directly — /diagnostics, /fixture and /authoring —
 * with no nav link to any of them anywhere in the product UI. /settings is the exception
 * to that: it is learner-facing and carries the export and deletion controls,
 * so it has a footer link on every screen — a right nobody can find is not
 * one. HashRouter specifically:
 * URLs stay #/-prefixed exactly as before, which survives a direct visit or
 * refresh through a tunnel (ngrok) with zero server-side rewrite config — a
 * plain BrowserRouter would 404 on a fresh #/diagnostics visit without that
 * config.
 */

import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import { HashRouter, Routes, Route, Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { Today } from "./pages/Today.js";
import { useSync } from "./sync/useSync.js";
import { useLearnerName } from "./hooks/useLearnerName.js";
import { LanguagePicker } from "./pages/LanguagePicker.js";
import { Progress } from "./pages/Progress.js";
import { ActivityTest } from "./pages/ActivityTest.js";

/**
 * Split, not statically imported. These screens are reached only by typing the
 * URL — there is no nav link to any of them anywhere in the product UI (see the
 * file comment above) — so every learner was downloading and parsing ~30 kB
 * of internal tooling they will never open. The learner flow (picker +
 * activities) is what should be fast; these can afford a fetch on the
 * rare visit that actually wants them.
 */
const Diagnostics = lazy(() =>
  import("./pages/Diagnostics.js").then((m) => ({ default: m.Diagnostics })),
);
const FixtureRunner = lazy(() =>
  import("./pages/FixtureRunner.js").then((m) => ({ default: m.FixtureRunner })),
);
/**
 * Content authoring. Internal, and the most clearly-split of the three: it
 * carries an editor for every field of every activity, and the learner who
 * opens it is nobody.
 */
const Authoring = lazy(() =>
  import("./pages/Authoring.js").then((m) => ({ default: m.Authoring })),
);
/**
 * Split for the same reason, and it is learner-facing rather than internal:
 * exporting or deleting a record is a once-ever visit, so it should not be in
 * the bundle every learner downloads to say one phrase.
 */
const Settings = lazy(() => import("./pages/Settings.js").then((m) => ({ default: m.Settings })));
import { resolveLanguage, resolveLanguages } from "./content/resolve.js";
import { useContentSync } from "./content/useContentSync.js";

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
  const isLanguages = location.pathname === "/languages";
  const isSettings = location.pathname === "/settings";
  const isAuthoring = location.pathname === "/authoring";
  const progressMatch = /^\/([a-z]+)\/progress$/.exec(location.pathname);
  const slug = progressMatch?.[1] ?? location.pathname.replace(/^\//, "");
  // getLanguage would return undefined for "languages" anyway, but checking
  // explicitly keeps the crumb from depending on no language ever being
  // slugged "languages".
  const language =
    !isDiagnostics && !isFixture && !isLanguages && !isSettings && !isAuthoring
      ? resolveLanguage(slug)
      : undefined;
  const onProgress = progressMatch !== null && language !== undefined;

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
      {isLanguages && (
        <>
          <span aria-hidden="true">›</span>
          <span>Languages</span>
        </>
      )}
      {isSettings && (
        <>
          <span aria-hidden="true">›</span>
          <span>Settings</span>
        </>
      )}
      {isAuthoring && (
        <>
          <span aria-hidden="true">›</span>
          <span>Content</span>
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
              {resolveLanguages().map((lang) => (
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
      {onProgress && (
        <>
          <span aria-hidden="true">›</span>
          <span>Progress</span>
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

  if (location.pathname === "/authoring") {
    return (
      <>
        <div className="eyebrow">Sonare · internal content authoring</div>
        <h1>Content</h1>
      </>
    );
  }

  // Parsed straight from the path rather than via useParams() — the header
  // sits outside the <Routes> tree that actually matches /:slug, so it has
  // no route params of its own to read.
  const progressMatch = /^\/([a-z]+)\/progress$/.exec(location.pathname);
  const slug = progressMatch?.[1] ?? location.pathname.replace(/^\//, "");
  const language = resolveLanguage(slug);

  // Named per screen. "Speech activity" as the heading on the home screen
  // described the thing one tap away rather than the thing being looked at.
  const heading =
    language !== undefined
      ? progressMatch !== null
        ? `${language.label} progress`
        : `${language.label} speech activity`
      : location.pathname === "/languages"
        ? "Choose a language"
        : location.pathname === "/settings"
          ? "Settings"
          : "Today";

  return (
    <>
      <div className="eyebrow">Sonare · phoneme pronunciation scoring</div>
      <h1>{heading}</h1>
    </>
  );
}

/**
 * A 240ms entrance per screen.
 *
 * The key is the whole mechanism: React discards the previous subtree and the
 * animation runs on the new one. There is deliberately no exit animation —
 * an exit has to finish before the next screen can start, which turns every
 * tap into a round trip twice as long as it needs to be.
 */
function ScreenTransition({ children }: { children: ReactNode }) {
  const location = useLocation();
  return (
    <div className="screen" key={location.pathname}>
      {children}
    </div>
  );
}

function Shell() {
  const [learnerName] = useLearnerName();

  /**
   * Mounted once, here, rather than per screen. Sync is an app-level
   * background concern: a screen that mounted it would re-sync every time the
   * learner navigated, and the Record screen would do it mid-take.
   */
  useSync({ learnerName });

  /**
   * Fetch published content once, in the background. Nothing waits on it —
   * the resolver reads the cache synchronously, so a screen renders with what
   * it already has and a completed fetch only means the next render has newer
   * words.
   */
  useContentSync();

  return (
    <div className="wrap">
      <header>
        <img className="logo" src="/brand/wordmark-purple.png" alt="Lingotran" />
        <Breadcrumb />
        <Header />
      </header>

      {/* Suspense wraps only the lazy routes. The learner path (picker and
          activities) is statically imported and never suspends, so it renders
          exactly as before with no fallback flash. */}
      {/*
        `role="status"` because this is the only loading state in the app that
        announced nothing. `ScoreCardSkeleton` marks its decorative parts
        `aria-hidden` and puts `aria-live` on the part that is not, and the
        authoring screen uses `role="status"`/`role="alert"` for its own
        pending and outcome states — this fallback was the exception.
        Settings is a lazy route and learner-facing, so a learner on a screen
        reader tapping it got a silent swap to a screen with nothing on it.
      */}
      <Suspense fallback={<RouteFallback />}>
        {/*
          Keyed on the path so each screen animates in on arrival.
          This adds no remounting the app did not already do: a different
          route renders a different component regardless, and /:slug already
          carries its own key so switching language starts a fresh session.
        */}
        <ScreenTransition>
        <Routes>
          <Route path="/" element={<Today />} />
          <Route path="/languages" element={<LanguagePicker />} />
          {/* Declared before /:slug for readability; React Router ranks by
              specificity, so a language can never shadow it. */}
          <Route path="/:slug/progress" element={<Progress />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/fixture" element={<FixtureRunner />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/authoring" element={<Authoring />} />
          <Route path="/:slug" element={<ActivityTestRoute />} />
        </Routes>
        </ScreenTransition>
      </Suspense>

      {/*
        The only way to Settings, and the reason it is here rather than on one
        screen: exporting or deleting a record is a right, and a right reached
        by typing a URL is one only a developer has. The breadcrumb cannot
        carry it — that is hidden on the front door, which is where a learner
        who wants to leave actually starts.

        Outside <Suspense> and after the routes, so it neither participates in
        a lazy screen's fallback nor sits inside any screen's layout.
      */}
      <footer className="app-footer">
        <Link to="/settings">Your data</Link>
      </footer>
    </div>
  );
}

/**
 * What a lazy route shows while its chunk arrives.
 *
 * A named component rather than inline JSX so a test can assert the real
 * thing. Inline, the only way to cover it was to render a copy of the markup
 * in the test and assert on that — which passes whatever `App` actually does,
 * and is the vacuous shape this repository keeps catching elsewhere.
 *
 * `role="status"` because this was the one loading state in the app that
 * announced nothing. `ScoreCardSkeleton` marks its decorative parts
 * `aria-hidden` and puts `aria-live` on the part that is not; the authoring
 * screen uses `role="status"` and `role="alert"` for pending and outcome. This
 * fallback was the exception, and Settings is both lazy and learner-facing, so
 * a learner on a screen reader tapping it got a silent swap to an empty
 * screen.
 */
export function RouteFallback() {
  return (
    <p className="dim" role="status">
      Loading&hellip;
    </p>
  );
}

export function App() {
  return (
    <HashRouter>
      <Shell />
    </HashRouter>
  );
}
