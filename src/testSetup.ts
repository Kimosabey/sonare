/**
 * What jsdom is missing that every component test assumes it has.
 *
 * jsdom implements no media stack at all: `navigator.mediaDevices` is
 * undefined. That is indistinguishable, to feature detection, from a browser on
 * an insecure origin — which is exactly the check `useMicEnvironment` makes,
 * and correctly so, since an `http://` page genuinely has no `mediaDevices`.
 *
 * Without this, every screen that reads the microphone environment renders its
 * "no microphone here" state, and four end-to-end suites assert against a
 * blocked app rather than a working one. Stubbing the hook in each of them
 * would fix the symptom and cost the thing those suites exist for: they drive
 * the real app, and a mocked hook is one less piece of the real app.
 *
 * So the stub is here, once, and it says "an ordinary browser with a working
 * microphone" — the condition the suites already believe they are running
 * under. The states where that is *not* true are covered directly, against the
 * real logic, in `micCheck.test.ts` and `MicUnavailable.test.tsx`.
 *
 * Node-environment suites are untouched: there is no `window` there, and
 * everything below is behind that check.
 */

if (typeof window !== "undefined" && typeof navigator !== "undefined") {
  /**
   * jsdom serves `http://localhost/` and reports `isSecureContext: false`.
   * A real browser treats localhost as a secure origin precisely so that
   * development works, so the default here is the one condition no browser
   * actually presents — and `useMicEnvironment` reads it first, which is right
   * for production and wrong for every suite running under jsdom.
   */
  if (window.isSecureContext !== true) {
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  }

  if (navigator.mediaDevices === undefined) {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        // Present so feature detection passes. Any test that actually records
        // stubs `useRecorder`, which is the layer that calls this.
        getUserMedia: () => Promise.reject(new Error("no media in jsdom")),
        enumerateDevices: () =>
          Promise.resolve([
            { deviceId: "default", kind: "audioinput", label: "", groupId: "" },
          ]),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
  }
}
