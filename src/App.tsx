/**
 * Three screens: the language picker (front door), the activity test for
 * whichever language is in the URL (:slug), and /diagnostics (internal-only
 * — no nav link anywhere, reached by typing the URL directly). HashRouter
 * specifically: URLs stay #/-prefixed exactly as before, which survives a
 * direct visit or refresh through a tunnel (ngrok) with zero server-side
 * rewrite config — a plain BrowserRouter would 404 on a fresh #/diagnostics
 * visit without that config.
 */

import { HashRouter, Routes, Route, useLocation, useParams } from "react-router-dom";
import { LanguagePicker } from "./pages/LanguagePicker.js";
import { ActivityTest } from "./pages/ActivityTest.js";
import { Diagnostics } from "./pages/Diagnostics.js";
import { getLanguage } from "./activities/languages/index.js";

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
        <Header />
      </header>

      <Routes>
        <Route path="/" element={<LanguagePicker />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
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
