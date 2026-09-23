# What a school is buying

For the questions that come before pedagogy in an education procurement: what
happens to children's data, and whether the thing is accessible. Every claim
below names what enforces it, and the one gap is at the end rather than
omitted.

Written 2026-09-21.

---

## Children's data

### A child's recording is not kept

Audio is sent to the scorer and discarded. Nothing writes a learner's voice to
disk in normal operation.

There is one diagnostic exception and it is worth stating rather than hiding:
`SAVE_AUDIO_DIR` will write the exact audio the scorer received, for debugging
a class of recognition failure that cannot be diagnosed from signal statistics
alone. It is **off unless set**, it logs a warning on every write while it is
on, and the code that implements it says in as many words that it must never be
set in a deployment serving real learners.

*Enforced by: the absence of any other write path, and `attempts.ts`, which
records that storing learner voice recordings is a data-protection decision
rather than a build one.*

### A teacher is never sent a pupil's score

Accuracies become standings — *just started*, *getting there*, *holding* —
**before** they cross the class boundary. The teacher's screen is not sent a
number, so it cannot show one.

It is also tested from the other direction: the screen is handed a score it
should never have received and must still display none. Defence in depth,
because the cost of being wrong once is a child's pronunciation score on a
classroom display.

*Enforced by: `server/domain/classSummary.ts`, and `src/pages/Teacher.test.tsx`.*

### A teacher sees their own class, and no other

A class has an owner. Creating one mints a key, returns it **once**, and stores
only a keyed digest of it — so a lost key means a class nobody can administer
rather than one anybody can. Every teacher route checks the presented key
against the class being asked about.

This was not true until 21 September 2026, and the history is worth stating
because a buyer's question is about what the software does now rather than what
it intended. Before that, one shared operator token gated every teacher surface
and the routes then read whichever class was asked for: a holder could read any
class on the deployment. Nothing linked to the board, so the only holder was
the operator — but the fix landed before any teacher was given a link, which
was the step that would have mattered.

A refusal answers "that class does not exist", identically to a class that
genuinely does not, so the guard cannot be used to discover which class ids are
real.

*Enforced by: `server/middleware/classOwner.test.ts`, which also checks the
guard is **mounted** on every teacher route rather than merely written, and
`src/pages/Teacher.test.tsx` for the key's journey from creation to a second
device.*

### A pupil's name is theirs

- They see what joining means **before** they join — the decision screen sits
  between looking a class up and joining it, so typing a code is not the act of
  joining.
- They can **join without their name**. The teacher then sees a positional
  label, never an identifier.
- They can **remove their name without leaving**, or leave entirely, at any
  time. Both report honestly whether they worked, because a pupil told their
  name is gone when it is not has been told the opposite of the truth about
  something they asked for.
- **Looking a class up sends no credential**, so it is not an act the server
  can attribute to anyone.

*Enforced by: `src/components/JoinClassFlow.test.tsx`, which reads the actual
network requests rather than asking which helper was called.*

### There is no analytics, and no third-party tracking

No Google Analytics, no Segment, no Mixpanel, no Sentry, no advertising
pixels, no session recording. The application makes no request to any
analytics or marketing service, because none is present in it.

### Data can be taken out, and deleted

The You tab carries **Export your data** and **Delete everything**. Deletion
clears the local record and the server's, and the two are tested to agree about
what "everything" means.

### Practice works with no network

The bundled activity set is the offline floor, served by a service worker that
is tested in a real browser to serve the application on a second visit **with
the network cut**. A school with poor connectivity has a working product, and a
learner's practice does not require their audio to leave the device to be
useful to them.

---

## Accessibility

Public-sector education buyers procure against **EN 301 549** in the UK and EU,
and **Section 508** in the US. Both reduce to **WCAG 2.1 Level AA**.

Sonare is tested against WCAG 2.1 A and AA **on every screen, across three
browser engines** — Chromium, WebKit and mobile WebKit. Not audited once and
asserted thereafter: the sweep reads the router, so a screen cannot be added
without the audit meeting it, and a violation fails the run.

**This paragraph said "in continuous integration" until 23 September 2026, and
that was not true.** CI runs the five gates — typecheck, lint, verify, the test
suite and the build. It does not launch a browser, so the axe sweep is run by a
person before a release rather than on every push, and a violation does not
block a merge. The suite it belongs to is real, covers every declared route and
is green on all three engines as of that date; what was wrong was the claim
about *when* it runs, which is exactly the kind of detail this document exists
to get right. The jsdom suite that does run in CI checks structural properties —
one `<h1>` per screen, no nested controls, focus rings, the tap floor — and says
in its own header that a real audit still needs axe in a real browser.

*Enforced by: `e2e-browser/accessibility.spec.ts`, which fails if a route the
router declares is not audited, and `scripts/procurement-claims.test.ts`, which
fails if this page claims a check that `.github/workflows/ci.yml` does not
actually run.*

Beyond the automated rules, which catch perhaps half of what matters:

| Property | How it is held |
|---|---|
| **44px minimum target, 48px for thumb-driven controls** | Checked twice — declared values in the stylesheet, and *rendered* heights in real browsers at 360, 430, 768 and 1280 |
| **Exactly one `<h1>` per screen** | So a heading walk has one answer |
| **Nothing pointer-only; a visible focus ring everywhere** | `src/styles/focus.test.ts` |
| **Motion is never the only carrier**, and `prefers-reduced-motion` is honoured | `src/styles/motion.css`, `src/styles/compositing.test.ts` |
| **No control nested inside another** | A source scan, because the automated rules do not catch a button inside a link |
| **`lang` on every language-bearing string** | So a screen reader does not read French in an English voice |
| **Reading load is budgeted per screen** | A consent decision on a 360px phone gets a tighter ceiling than the same facts at a desk |

**What is not covered:** VoiceOver and TalkBack have not been driven by hand.
Nobody can automate that, and it is the part of an accessibility claim that
most deserves a person. It is scheduled and not done.

---

## Deployment

It is a web application. There is nothing to install, which matters in two
places most products treat as edge cases:

- **Managed device fleets** that block application installs. A URL is not an
  install.
- **Chromebooks**, where a native iOS or Android application is not an option
  at all.

A fix reaches every user the day it is deployed — no review queue, and no fleet
running a version from three weeks ago.

---

## The application makes no third-party request at all

Not "almost none". None.

This section previously recorded a gap, and it is worth keeping the history:
fonts were loaded from Google's CDN, so every learner's browser sent its IP
address to Google before the page rendered. It was the single external request
the application made, and the one claim here that would not have survived a
strict GDPR reading — a German court has already found that exact pattern to be
a transfer requiring consent.

The font files are now served from the same origin as the application, and the
request is gone. Two details of the fix matter to a buyer:

- **The subsetting is preserved.** A French learner downloads a 39 KB Latin
  file and never touches the 121 KB of Devanagari, which is fetched only if a
  Devanagari character is rendered. Self-hosting did not turn into a payload
  cost.
- **The faces are now cached with everything else**, so a second visit renders
  in them offline. A cross-origin font never could.

*Enforced by: `scripts/fonts-selfhosted.test.ts`, which fails on a reference to
Google's font hosts, on a stylesheet naming a file that is not shipped, on a
shipped file nothing references, and on a face that loses its unicode range.*

---

## What this document does not claim

- **No certification.** Nothing here has been audited by a third party. These
  are properties the build enforces, which is a different and smaller claim
  than a badge.
- **No legal advice.** GDPR, COPPA and FERPA compliance is a question about a
  deployment, a data-processing agreement and a school's own policies. This
  describes what the software does.
- **No manual accessibility testing** with real assistive technology, as above.
