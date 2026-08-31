/**
 * Two screens: the French speech activity (the product, default route) and
 * /diagnostics (internal-only — no nav link anywhere, reached by typing the
 * URL directly). HashRouter specifically: URLs stay #/-prefixed exactly as
 * before, which survives a direct visit or refresh through a tunnel (ngrok)
 * with zero server-side rewrite config — a plain BrowserRouter would 404 on
 * a fresh #/diagnostics visit without that config.
 */

import { HashRouter, Routes, Route, useLocation } from "react-router-dom";
import { FrenchActivityTest } from "./pages/FrenchActivityTest.js";
import { Diagnostics } from "./pages/Diagnostics.js";

function Shell() {
  const location = useLocation();
  const diagnostics = location.pathname === "/diagnostics";

  return (
    <div className="wrap">
      <header>
        <img className="logo" src="/brand/wordmark-purple.png" alt="Lingotran" />
        <div className="eyebrow">Sonare · {diagnostics ? "internal diagnostics" : "phoneme pronunciation scoring"}</div>
        <h1>{diagnostics ? "Diagnostics" : "French speech activity"}</h1>
      </header>

      <Routes>
        <Route path="/" element={<FrenchActivityTest />} />
        <Route path="/diagnostics" element={<Diagnostics />} />
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
