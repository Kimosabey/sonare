# Where Sonare sits, and why

Written 2026-09-18. Competitor reads come from public product behaviour, not
from market research — see [What this does not know](#what-this-does-not-know)
at the end. Sonare's own claims are traced to the code that enforces them,
which is the one half of this document that is checkable.

## The thesis

Sonare scores pronunciation at phoneme level and **refuses to produce a number
it cannot stand behind.**

That refusal is the product, not an apology for it:

- An unusable take returns `indeterminate`, spends no attempt, and is never
  celebrated. On a measured **9.4%** of real takes — roughly one in eleven.
- The vowel chart is built and withheld, because the formant estimator is only
  accurate above about 140 Hz. That excludes most women's voices and all
  children's.
- Kannada and Hindi are held back because the scorer names **0 syllables** in
  them. A score would come back around 100 with nothing to act on.

Every other tool in this market is built to always have an answer, because an
answer is what retains a user. That makes the honest position structurally
available to roughly one product — and it is worth more in a classroom than in
an app store, because a teacher who catches a tool being confidently wrong once
will not use it again.

## The field

| Product | Position | Wins on | Gap it leaves |
|---|---|---|---|
| **Duolingo** | The habit engine | Daily return, by a distance — a manufactured behaviour rather than a teaching one | A learner can hold a 400-day streak and never learn which sound they get wrong |
| **ELSA Speak** | The accent coach — **nearest neighbour** | Phoneme granularity, and a clear "this sound, this mouth position" loop | English only, consumer-shaped, always returns a score, no class model |
| **Speechling** | The human ear | Feedback nobody disputes, on things no model detects | Does not scale to 30 pupils practising nightly; the delay breaks the loop |
| **Rosetta Stone** | The immersion institution | Schools already know how to buy it | Pass/fail-feeling feedback with little diagnostic value |
| **Pimsleur** | The audio drillmaster | Ear training, and honesty about assessment by not attempting it | The learner never finds out whether they said it right |
| **Busuu · Babbel** | Curriculum with a crowd | Breadth, and a working answer to "who checks the language?" | Pronunciation feedback is incidental; community correction is uneven |

## The comparison that matters

| | Sonare | ELSA | Duolingo | Speechling | Pimsleur |
|---|---|---|---|---|---|
| Feedback grain | Phoneme & syllable | Phoneme | Word, roughly | Human, holistic | None |
| **When unsure** | **Says so, costs nothing** | Returns a score | Returns a score | Human hedges | n/a |
| **Teacher sees** | **Standings, never a score** | No class model | Full gradebook | Coach notes | Nothing |
| Engagement mechanics | Attendance streak only | Some | The whole product | Minimal | None |
| Languages | French, Spanish shipping | English only | Very many | Several | Many |
| **Child data** | **Name is opt-in per class** | Consumer account | Consumer account | Consumer account | Consumer account |
| Works offline | Yes, bundled floor | Partly | Partly | No | Yes |
| **Platform** | **PWA — no install** | Native | Native | Native | Native |
| Runs on a locked-down school fleet | **Yes, it is a URL** | Install needed | Install needed | Install needed | Install needed |
| Runs on Chromebooks | **Yes** | No native app | No native app | No native app | No native app |
| Ships a fix | **Same day** | Store review | Store review | Store review | Store review |
| Found in an app store | **No** | Yes | Yes | Yes | Yes |

## The USP, at its real strength

Each claim is labelled by **what actually enforces it**, because a positioning
claim that traces to nothing is how a product ends up saying something untrue
in public.

### 1. It will not invent a number — *enforced*

R8 and the indeterminate path, the withheld vowel chart, the withheld
languages. Held by tests and by measured gates.

**This is the defensible one.** A competitor can copy a feature in a quarter.
Copying a refusal means giving up the answer that retains their users.

### 2. A teacher never receives a child's score — *enforced*

Accuracies become standings *before* they cross the class boundary, so the
teacher screen is never sent a number. `Teacher.test.tsx` additionally proves
the screen renders none even when the server sends one — defence in depth,
because the cost of being wrong once is a child's pronunciation score on a
classroom display.

A pupil sees the consequences before agreeing, can **join without their name**,
leave at any time, or remove their name without leaving. The lookup step sends
no credential, so looking is not an act anyone can attribute.

### 3. No points, XP, hearts, leagues or leaderboards — *enforced*

The streak counts attendance only and has no repair tokens or make-up days, so
it cannot become a thing to protect. Three attempts then move on; no hard gate
traps a learner on a sound they cannot yet make.

Held repo-wide by `scripts/verify.mjs` **T16**, which fails the build on a
leaderboard, league, XP, gem, coin, heart, trophy or streak freeze anywhere in
shipped code. Comments are stripped before matching, because this repository
discusses leaderboards in several places precisely to explain why it has none,
and a rule that fails on its own reasoning teaches people to stop writing the
reasoning down.

For most of this project's life the checklist claimed such a rule existed and
it did not — the claim most likely to be said out loud was the least true. It
is true now, and the failure mode it guards against is worth naming: nobody
decides to gamify a product. It arrives as six defensible additions over two
years, none of which is the moment it changed.

## Web app against native apps

**This is the largest structural difference in the table above and it was
missing from the first draft of this document.** Sonare is a PWA. ELSA,
Duolingo, Rosetta Stone, Busuu and Pimsleur are native apps with web
afterthoughts. That is not a detail — it changes distribution, capability and
who can buy.

### Where being a web app wins, and it is not a consolation

- **Managed school devices.** A great many classroom fleets block app installs
  outright. A URL is not an install, so it works where a native competitor
  simply cannot be deployed without an IT ticket per device.
- **Chromebooks.** Where the deployment is Chromebooks, a native iOS or Android
  app is not an option at all. Sonare runs there with no special case.
- **Shipping.** A fix reaches every user the moment it is deployed. No review
  queue, and no fleet sitting on a version from three weeks ago.
- **Trial friction.** A teacher can put a link on a board and have thirty
  pupils practising in a minute. No store account, no install, no age gate.
- **No platform cut**, and no platform able to change the rules of the product.

The codebase already backs this: `display: standalone` with a maskable icon,
and a service worker proven in a real browser to serve the app on a second
visit **with the network cut**. The bundled activity set is the offline floor,
so a learner with no network still practises.

### Where being a web app loses, honestly

- **Discovery.** No store listing. Nobody finds Sonare by searching an app
  store, and a procurement officer may look for one as a proxy for legitimacy.
- **Push notifications.** Weak on iOS and only once added to the home screen.
  *Though see below — this matters less here than it would for anyone else.*
- **Storage durability.** Safari can evict script-writable storage from a site
  not visited in some time. Mitigated, and deliberately: progress syncs to the
  server once a device is linked, so eviction costs a cache rather than a
  learner's history. It is not mitigated for an unlinked device.
- **Microphone.** A secure context is required — a plain LAN address will not
  open the microphone at all — and iOS effectively grants one permission
  prompt. That is why the screen must never spend it on an activity that has
  nothing to record, and now does not.
- **Audio quality.** A native app ships its audio. Sonare generates a model
  voice and caches it; an uncached phrase falls back to the device's own voice,
  which is lower quality and not the reference accent.

### The part worth noticing

**The PWA's single weakest capability is push notification — and this product
deliberately does not use engagement mechanics.** Duolingo would be crippled by
that gap; it is the whole of their re-engagement loop. Sonare has no streak to
protect, no league to fall out of, and nothing to nag about.

The platform's biggest limitation costs this product almost nothing, because
the positioning already ruled out the thing it would have blocked. That is a
rare alignment and it should be said out loud when the web-versus-native
question comes up, which it will.

## In interface terms

**An honest tool has more states than a confident one.** That is the design
consequence of the thesis, and it is uncomfortable. A product that always
returns a score needs one result screen. Sonare needs a result, an
indeterminate, a no-microphone, a no-voice-for-this-language, and a
question-that-could-not-be-composed — each of which has to read as a fact about
the situation rather than a verdict on the learner.

That work is invisible in a demo, and every one of those states is a chance to
blame somebody for a failure that was ours.

### Held by tests rather than by intentions

- **44px floor, 48px for thumb-driven controls**, checked twice: declared
  values in the stylesheet, and *rendered* heights in Chromium and WebKit at
  360, 430, 768 and 1280.
- **axe on every screen** at WCAG 2.1 A and AA, plus a source scan for nested
  interactive elements — axe does not catch a button inside a link.
- **Exactly one `<h1>` per route**, so a heading walk has one answer.
- **Motion is never the only carrier**, and no transition or keyframe touches a
  layout property.
- **Copy is budgeted per screen.** A consent decision on a 360px phone gets a
  tighter word ceiling than the same facts at a desk.
- **Two breakpoints, 620 and 1024**, and a test that refuses a third.
- **`lang` on every language-bearing string**, so a screen reader does not read
  French in an English voice.

Most products treat accessibility as an audit. Here it fails the build.

### Where it is behind, honestly

- **Warmth.** It measures more carefully than ELSA and explains less kindly.
  Per-sound coaching notes exist for some sounds, not all.
- **Onboarding.** No equivalent craft to Duolingo's first minute.
- **Discoverability.** The teacher board is designed, tested and accessible —
  and reachable only by typing a URL.
- **Delight.** Deliberately restrained, but restraint and absence look
  identical to a first-time user.
- **The diagnosis is a number and a syllable.** ELSA shows a mouth. A learner
  who cannot make a sound needs telling what to do with their tongue.

### What five defects in one day say about the method

All five were invisible to 4,287 passing tests and visible only to something
that rendered or drove the real thing. That is the argument for how this UI is
checked, not against it.

| What was wrong | Why nothing caught it | What does now |
|---|---|---|
| Every `<select>` rendered 28px in Safari | WebKit's native dropdown discards the author's box; Chromium honoured it | Rendered-height checks in a real WebKit |
| Teacher board had two `<h1>`s | The route was missing from the list of "every route" | The list is read from the router |
| A listening question opened the microphone | Warming is invisible; nothing on screen shows it | A recorder spy, not a stub |
| A question asked about audio the device could not play | Every part tested alone; the assembly was not | The screen is driven with the voice off |
| Options list had no accessible name | Not a WCAG failure, so axe passed | The list is found by its question |

## The dimensions the first version left out

The analysis above compares products. Schools do not buy products on product
grounds alone, and four of these change what should be built.

### 1. Data protection is a buying gate, not an ethical stance

GDPR, and in other markets COPPA and FERPA, are frequently the **first**
question in education procurement — before pedagogy, before price. A tool that
cannot answer it is not shortlisted, however good it is.

Sonare's posture is unusually strong and this document has been treating it as
a matter of principle rather than as the commercial asset it is:

- A teacher is **never sent a pupil's score** — the conversion happens before
  the class boundary.
- A pupil's name is **opt-in per class**, removable without leaving.
- Looking up a class **sends no credential**, so it is not an attributable act.
- Practice works offline against a bundled set, so a learner's audio and
  progress need not leave the device to use the product at all.

Competitors are consumer accounts with a school skin. This is the one dimension
where Sonare is not catching up — it is ahead, and has not been saying so.

### 2. Accessibility is a legal requirement, not a quality bar

Public-sector education buyers in the UK and EU procure against **EN 301 549**,
and in the US against **Section 508** — both of which reduce to WCAG 2.1 AA.
It is an RFP line item with a yes/no answer.

Sonare enforces WCAG 2.1 AA **in continuous integration**, on every screen,
across three browser engines, and additionally checks rendered tap-target sizes
and keyboard reachability. Very few products of any size can evidence that
rather than assert it.

This is the second asset being undersold: the accessibility work was done for
the right reasons and happens to be worth money.

### 3. Curriculum alignment — a genuine gap

Schools buy against a syllabus. CEFR levels, and in the UK exam-board
specifications, are how a department justifies a purchase to a budget holder.

**Sonare has no alignment story at all.** Content is a set of phrases chosen
for the sounds they drill, which is pedagogically defensible and commercially
invisible. This is a real gap, not a hidden strength, and it is cheaper to fix
than it looks: the content exists, and what is missing is the mapping.

### 4. The market asymmetry — the one that changes strategy

ELSA teaches **English to speakers of other languages**. Sonare teaches
**French and Spanish to English speakers**.

Those are not comparable markets. Learners of English outnumber learners of
French and Spanish by an order of magnitude, and English pronunciation is where
the money, the anxiety and the exam pressure are. Being the honest tool in a
smaller market is a weaker position than being the honest tool in the largest
one.

The mechanism is language-agnostic — the scorer takes a locale, and the whole
pipeline is built around that. **Nothing technical stops Sonare scoring English
for a Hindi or Kannada speaker**, and the syllable-coverage problem that blocks
Kannada as a *taught* language does not apply when the taught language is
English.

That is not a decision this document can make. But it should be asked
deliberately rather than settled by inertia.

### 5. Content depth — the weakest dimension

Competitors ship hundreds of hours. French has 21 activities. Every honesty
advantage above is worth nothing to a learner who finishes the content in a
fortnight, and this is the gap most likely to lose a trial.

### 6. Teacher workload

The thing that actually drives classroom adoption is time saved. Sonare's class
view answers "who is struggling with what sound" without a teacher listening to
thirty recordings — which is a strong workload story that is nowhere in the
positioning.

### Still not covered

**Pricing and business model.** Freemium, per-seat, site licence — no research
has been done and none is invented here. It is the largest remaining hole in
this document.

## What this does not know

- **No market data.** No pricing research, market sizing, funding position or
  user numbers for any competitor.
- **No user research.** No interviews with teachers or learners. "Honesty
  matters more in a classroom than in an app store" is an argument, not a
  finding.
- **Competitors move.** These are gaps as the products currently behave, and
  the nearest neighbour is the most likely to close one.
- **Sonare's claims are traced to code**, which is the only checkable part —
  and doing that traced one stated guarantee to nothing at all.
