/**
 * Hash routing, deliberately. Three routes do not justify a router dependency,
 * and a hash route survives being opened from a tunnel or LAN address on a
 * phone without any server-side rewrite — which matters for on-device testing.
 */

import { useEffect, useState } from "react";
import { PronunciationDrill } from "./pages/PronunciationDrill.js";
import { FixtureRunner } from "./pages/FixtureRunner.js";
import { FrenchActivityTest } from "./pages/FrenchActivityTest.js";

type Route = "drill" | "fixture" | "french";

const TITLES: Record<Route, string> = {
  drill: "Pronunciation drill",
  fixture: "Fixture runner",
  french: "French activity test",
};

function currentRoute(): Route {
  const hash = window.location.hash;
  if (hash === "#/fixture") return "fixture";
  if (hash === "#/french") return "french";
  return "drill";
}

export function App() {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(currentRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="wrap">
      <header>
        <div className="eyebrow">Sonare · Lingotran POC A · phoneme scoring</div>
        <h1>{TITLES[route]}</h1>
        <nav>
          <a href="#/" className={route === "drill" ? "on" : ""}>
            Drill
          </a>
          <a href="#/french" className={route === "french" ? "on" : ""}>
            French test
          </a>
          <a href="#/fixture" className={route === "fixture" ? "on" : ""}>
            Fixture
          </a>
        </nav>
      </header>

      {route === "fixture" && <FixtureRunner />}
      {route === "french" && <FrenchActivityTest />}
      {route === "drill" && <PronunciationDrill />}
    </div>
  );
}
