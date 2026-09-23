# Releasing

Short, because the five gates do most of it. What is here is the part no gate
covers.

## Before a release

### 1. The five gates

```bash
npm run typecheck && npm run lint && npm run build && npm run verify && npm test
```

Read them **by exit code**. Piping to `grep -c` exits zero when it finds errors
and has let a broken typecheck through before; so has chaining a commit after
an `echo` rather than after the gate.

### 2. The browser suite — the step nothing else forces

```bash
npm run test:browser
```

About three minutes, Chromium and WebKit and a mobile WebKit viewport.

**This is deliberately not one of the five gates.** Four thousand jsdom tests
run in thirty seconds, and making each of them wait on a browser launch is the
surest way to stop anyone running them at all.

The consequence is that it needs a person, and this file is the only thing that
says so. It has earned its place twice:

- A `<select>` rendered **28px** in Safari against a declared 44px floor —
  WebKit's native dropdown discards the author's box, Chromium honoured it, and
  every gate was green while the target platform shipped an undersized control
  on every screen with a dropdown.
- A `1,400px` table scrolled the document sideways with the whole suite passing.

Both were invisible to everything except a real engine at a real width.

If the preview server is already up, kill it first — `playwright.config.ts`
sets `reuseExistingServer: true`, so a stale server means the suite tests bytes
that are not the ones being released:

```bash
lsof -ti:4173 | xargs kill -9 ; npm run build
```

### 3. The model voice, if content changed

```bash
npm run generate-model-voice -- --dry-run   # what it would spend
npm run generate-model-voice                # rebuilds voice-check.html itself
open voice-check.html
```

The generator rebuilds the review page as its last step, so there is no
separate command to remember. There used to be, and it was missed the first
time it mattered: the cache key changed, all fifty clips were renamed, and the
page was left pointing at files that no longer existed.

A mispronounced clip is worse than no clip: every learner copies the error
*and* the scorer marks them down for matching it. The provider returns HTTP 200
for audio it mispronounces, so **nothing automated can detect this** — somebody
who speaks the language has to listen to `voice-check.html`.

### 4. Tag it

```bash
npm version <x.y.z> --no-git-tag-version   # updates package.json
git commit -am "Release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

A version that lags the tree is worse than none: for a long stretch
`package.json` said `0.2.0-alpha.1` with over two hundred commits on top of it,
so no bug report could be tied to anything.

## What no release step covers

- **VoiceOver and TalkBack**, by hand, one activity each. Nobody can automate
  it, and it is the part of an accessibility claim that most deserves a person.
- **Content nobody who speaks the language has read.** Spanish has never had a
  native reader; the German difficulty advice and the CEFR levels were authored
  without one.
