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

Sonare is tested against WCAG 2.1 A and AA **on every screen, in continuous
integration, across three browser engines** — Chromium, WebKit and mobile
WebKit. Not audited once and asserted thereafter: the build fails.

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

## The gap, stated plainly

**Fonts are loaded from Google's CDN.** `index.html` requests Nunito and Noto
Sans Devanagari from `fonts.googleapis.com`, which means every learner's
browser sends its IP address to Google on page load.

This is the single external request the application makes, and it is the one
thing on this page that would not survive a strict reading of GDPR — a German
court has already found embedding Google Fonts this way to be a transfer
requiring consent. It is also the easiest thing here to fix: the font files can
be served from the same origin as the application, which removes the request
entirely.

It is listed here rather than left out because a procurement answer that omits
its own exception is worth nothing the first time somebody checks.

---

## What this document does not claim

- **No certification.** Nothing here has been audited by a third party. These
  are properties the build enforces, which is a different and smaller claim
  than a badge.
- **No legal advice.** GDPR, COPPA and FERPA compliance is a question about a
  deployment, a data-processing agreement and a school's own policies. This
  describes what the software does.
- **No manual accessibility testing** with real assistive technology, as above.
