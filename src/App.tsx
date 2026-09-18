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
const Teacher = lazy(() => import("./pages/Teacher.js").then((m) => ({ default: m.Teacher })));
const Authoring = lazy(() =>
  import("./pages/Authoring.js").then((m) => ({ default: m.Authoring })),
);
/**
 * Split for the same reason, and it is learner-facing rather than internal:
 * exporting or deleting a record is a once-ever visit, so it should not be in
 * the bundle every learner downloads to say one phrase.
 */
const Settings = lazy(() => import("./pages/Settings.js").then((m) => ({ default: m.Settings })));
/**
 * The microphone check. Split like the others, and the reasoning is the same
 * shape with a different conclusion: a learner meets it once, during
 * onboarding, and then only if a take comes back unclear. It carries an
 * AudioContext, a level meter and eight states' worth of copy, none of which
 * belongs in the bundle downloaded to say a phrase.
 */
const MicCheck = lazy(() => import("./pages/MicCheck.js").then((m) => ({ default: m.MicCheck })));
/**
 * Onboarding. Split for the plainest reason of all: a learner sees it once,
 * ever, and a returning learner never downloads it again.
 */
const Onboarding = lazy(() =>
  import("./pages/Onboarding.js").then((m) => ({ default: m.Onboarding })),
);
const Journey = lazy(() => import("./pages/Journey.js").then((m) => ({ default: m.Journey })));
import { BackLink } from "./components/BackLink.js";
import { Navigation } from "./components/Navigation.js";
import { allProgress } from "./learning/nextUp.js";
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

  /**
   * Screens that render their own `<h1>`, where the shell must not.
   *
   * Every screen that shipped before the course work relied on the shell for
   * its heading, and the ones added since name themselves — which produced
   * **two** `<h1>`s on each of these routes, the shell's saying "Today"
   * because it did not recognise the path. A screen-reader user navigating by
   * heading landed on a wrong label before the right one.
   *
   * Listed rather than inferred, because the alternative — moving every screen
   * onto its own heading — is a change to eight screens' markup and their
   * tests for a defect that is three routes wide.
   *
   * This comment used to end by saying the route-level test asserts exactly
   * one `<h1>` everywhere, so the pair could not come back silently. It did
   * come back silently: `/teacher` names itself, was never added here, and the
   * route test's list of "every route" was hand-written and did not have it
   * either. That list is now read out of the `<Routes>` block below, so a
   * route cannot be added without the heading check meeting it.
   */
  const ownsItsHeading =
    location.pathname === "/welcome" ||
    location.pathname === "/check" ||
    location.pathname === "/teacher" ||
    /^\/[a-z]{2}\/journey$/.test(location.pathname);

  if (ownsItsHeading) {
    return <div className="eyebrow">Sonare · phoneme pronunciation scoring</div>;
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
  const location = useLocation();

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

  /**
   * Which language the two per-language destinations point at.
   *
   * Read from the path when the learner is inside one, and otherwise from
   * whichever they practised most recently — so the Journey and Progress tabs
   * lead somewhere useful from Today, rather than to a picker the learner has
   * already answered once.
   */
  const inLanguage = /^\/([a-z]{2})(\/|$)/.exec(location.pathname)?.[1];
  const currentSlug =
    (inLanguage !== undefined && resolveLanguage(inLanguage) !== undefined
      ? inLanguage
      : allProgress(learnerName)[0]?.slug) ?? null;

  /**
   * A sitting takes the screen. The board is explicit that it runs *over* the
   * tabs, with its own back and close as the only two ways out — a tab bar
   * beside a sitting is a standing invitation to leave it half-done, and a
   * sitting is the one flow in the product with a finish line.
   *
   * Decided here rather than inside `Navigation`, because "is a sitting
   * running" is the session's fact and the nav has no business knowing how to
   * work it out.
   */
  const inSitting = /^\/[a-z]{2}$/.test(location.pathname);

  /**
   * Where back goes from this screen, or null on a tab root.
   *
   * An explicit destination rather than `history.back()`, deliberately: a
   * screen opened from a typed URL or a shared link has no history to step
   * through, and a back control that did nothing in exactly that case would
   * fail whenever it mattered most. The four tab roots get none, because the
   * board says so and because Android's system back already closes the app
   * from them.
   */
  const back = (() => {
    const path = location.pathname;
    if (path === "/" || path === "/settings" || inSitting) return null;
    const perLanguage = /^\/([a-z]{2})\/(journey|progress)$/.exec(path);
    if (perLanguage !== null) return null; // tab roots too
    if (currentSlug !== null && /^\/[a-z]{2}\//.test(path)) {
      return { to: `/${currentSlug}`, label: resolveLanguage(currentSlug)?.label ?? "practice" };
    }
    return { to: "/", label: "Today" };
  })();

  return (
    <div className={inSitting ? "wrap" : "wrap has-tabs"}>
      <header>
        {/*
          `width` and `height` carry the *intrinsic* size, not the rendered
          one. CSS sets the height to 28px and leaves the width automatic, so
          these attributes are read only for the ratio — which is what lets the
          browser reserve the right box before the PNG has downloaded. Without
          them the header is zero-width on first paint and everything beside it
          jumps when the image arrives.
        */}
        <img
          className="logo"
          src="/brand/wordmark-purple.png"
          alt="Lingotran"
          width={1819}
          height={571}
          /* Decoded off the main thread; nothing is waiting on it. */
          decoding="async"
        />
        {/*
          The way back, on every screen that is not a tab root — board 1e.
          An installed iOS PWA has no browser back button at all, so without
          this a learner who opened Journey or Progress is on a dead end
          reachable only by force-quitting.

          It replaces an 11px breadcrumb link, which NFR-03 never saw: that
          rule flags CSS *declaring* a sub-44px min-height, and a link that
          never declared one at all slipped past it. The breadcrumb stays for
          the language switcher it carries; the back affordance is now a real
          target beside it.
        */}
        {back !== null && <BackLink to={back.to} label={back.label} />}
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
          <Route path="/:slug/journey" element={<Journey />} />
          <Route path="/diagnostics" element={<Diagnostics />} />
          <Route path="/fixture" element={<FixtureRunner />} />
          <Route path="/welcome" element={<Onboarding />} />
          <Route path="/check" element={<MicCheck />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/authoring" element={<Authoring />} />
          {/* Internal, like /authoring and /diagnostics — linked from nowhere,
              and deliberately absent from the learner's four tabs. */}
          <Route path="/teacher" element={<Teacher />} />
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
      {/*
        Four destinations, and gone during a sitting. See `Navigation` for why
        it is four and never five, and why the three widths are a stylesheet
        decision rather than a JavaScript one.
      */}
      <Navigation slug={currentSlug} hidden={inSitting} />

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
