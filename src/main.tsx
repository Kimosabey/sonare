import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { ToastProvider } from "./components/ToastProvider.js";
import { UpdatePrompt } from "./pwa/UpdatePrompt.js";
import "./styles/index.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <ToastProvider>
        {/*
          Inside ToastProvider because that is where its announcement goes, and
          above <App /> because the service worker is an app-level concern —
          mounted on a screen it would re-register on every navigation.
        */}
        <UpdatePrompt />
        <App />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>,
);
