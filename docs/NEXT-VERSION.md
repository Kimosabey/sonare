# 0.3.0 — the classroom release

**Where we are:** `package.json` says `0.2.0-alpha.1`, the last tag says the
same, and **212 commits have landed since it**. See `docs/VERSIONS.md`. The
first thing this release does is give that work a name.

**Written:** 2026-09-18, from `docs/COMPETITIVE-POSITION.md`.

**Thesis of this version:** everything built in those 212 commits is a
classroom product that no classroom can currently reach. 0.3.0 is the release
that makes it reachable, and says out loud what it is already good at.

---

## Part 1 — Decisions, not engineering

Nothing below Part 2 moves until these are settled. Each carries a
recommendation rather than a menu.

### D7 · Cut the version

212 commits with no name means nobody can say which build they are running, and
a bug report cannot be tied to anything.

**Recommended: tag the current tree `v0.3.0-alpha.1` now**, before any of the
work below, so this release has a floor to measure from. The alternative — one
tag at the end — leaves the largest body of work in the project permanently
unnamed.

### D1 · How does a teacher get in?

The board is built, tested, axe-clean, and **reachable only by typing a URL**.

| Option | What it means |
|---|---|
| **Token link per teacher** *(recommended)* | A URL with a token. No accounts, no password reset, no personal data. Fits the existing gate and the data posture that is a procurement asset. |
| Full accounts | Email, password, recovery, and child-adjacent data policy. Buys little the token does not. |
| Leave it internal | The class features reach nobody, and the second USP claim is about a screen nobody uses. |

### D2 · Kannada and Hindi — perception courses?

Azure names **0 syllables** in both, so production scoring cannot be honest.
`listen` and `locate` need no scorer, and a perception-only course is proven to
publish, compose and run (`src/learning/perceptionCourse.test.ts`).

**Recommended: yes, one language first.** It also gives `listen` its first home
— the kind currently ships in no language at all.

### D3 · Who checks the language?

The most recurring blocker in the repo. Spanish has never had a native reader.
A mispronounced generated clip is worse than none — every learner copies the
error *and* the scorer marks them down for matching it — and the provider
returns HTTP 200 for audio it mispronounces, so nothing automated detects it.

**Recommended: one reviewer per language as a standing arrangement.**
`voice-check.html` is already the review surface.

### D4 · Image activities — start?

**Recommended: yes, scoped to articulation diagrams only** — a picture of where
the tongue goes, per scorable sound. Highest-value single borrow from ELSA,
closes the warmth gap, concedes no measurement honesty, and carries no privacy
cost. Picture-naming activities are a different product and should wait.

### D5 · Publish a course?

`COURSES` exists — French has 21 activities against the bundled 10 — and
publishes only via `npm run seed-content -- --course`. If yes, the model voice
must regenerate at publish time, because the cache key includes the content
version.

**Recommended: yes, after D3.**

### D6 · Who runs the browser suite, and when?

Not a gate, deliberately. But the 28px Safari `<select>` was live with all five
gates green, and two of 18 September's defects were only visible there.

**Recommended: a pre-release step owned by a person.** Three minutes. Something
has to make it happen and nothing does.

### D10 · Price — **decided: free for now**

Recorded 18 September 2026. Sonare is free.

That is the right posture for D9: the schools losing Duolingo for Schools on
31 July 2027 had a free incumbent, and arriving with a price against a
departing free product is the harder sale.

It also removes work rather than adding it — no billing, no payment accounts,
no price negotiation — which makes D1's recommendation (a token link, no
accounts) cleaner still.

**But free has one consequence that is not yet handled.** Scoring is metered:
$1.00 per audio hour, and every take costs money whether it scores or not.
Realistic use is small — $1.69 to $5.70 per learner per school year — but the
ceiling is the question, and there is currently no ceiling.

`MAX_DAILY_SCORING_CALLS` exists, defaults to 2000, and is **read, reported and
alerted on but never enforced**. `server/spend.ts` computes the fraction used,
`server/infra/alerts.ts` fires on it, and the alert's own text says *"calls
keep succeeding until the cap, then they stop"*. They do not stop. Nothing in
`server/routes/pronunciation.ts` checks it.

What does exist is rate limiting: 30 requests per minute per address, 20 per
minute per identified learner. Those bound the *rate*, not the day. A single
token used flat out is bounded at roughly $0.028 a minute.

**Recommended: enforce the cap before announcing free anywhere.** The code
already computes everything needed, and the alert already promises the
behaviour — this is making reality match a documented intent rather than
inventing policy.

The number needs deciding, though, and it is not obviously 2000: at a typical
ten takes per sitting that is about 200 learners a day, so a cap set to protect
a budget could lock out a school mid-lesson. That trade — a surprise bill
versus a class that stops working — is yours.

### D9 · The Duolingo for Schools window

**Duolingo for Schools is being withdrawn.** New accounts are already closed
and it sunsets on **31 July 2027**. Every school on it will need a replacement,
on a published date, and their incumbent was free.

This is the only dated opportunity in the whole analysis, and 0.3.0 is the
classroom release. Whether to aim at it changes what gets built first: a
free-for-one-teacher tier and a fast join flow matter far more against a
departing free incumbent than a site-licence sales motion does.

**Recommended: aim at it.** It costs little — the class and join-code
machinery already exists — and the alternative is arriving after schools have
already chosen something else.

### D8 · Which market — the new one

**This is the largest strategic question and it was missing from the first
analysis.** ELSA teaches English to speakers of other languages. Sonare teaches
French and Spanish to English speakers. Those are not comparable markets:
learners of English outnumber the other two by an order of magnitude, and
English is where the exam pressure is.

The mechanism is language-agnostic — the scorer takes a locale — and the
syllable-coverage problem that blocks Kannada as a *taught* language does not
apply when the taught language is English.

**No recommendation.** This is a business decision, not a technical one. It is
here so it is asked deliberately rather than settled by inertia.

---

## Part 2 — The work

Ordered by what it unblocks. ✅ = done in this cycle already.

### ✅ 1 · Make the anti-gamification constraint structural

`scripts/verify.mjs` **T16**. Seven plausible additions were planted and each
failed the build. **Done — `f3863e8`.**

### 2 · A way into the teacher board

**Borrowed from:** Rosetta Stone — a classroom product needs a door that is not
a typed URL. **Blocked on:** D1. **Cost:** small.

### 3 · Say the procurement story out loud

**Borrowed from:** nobody — this is being undersold, not missing.

Two assets exist and are framed as ethics rather than as sales:

- **Data protection.** GDPR, COPPA and FERPA are frequently the *first*
  question in education procurement. A teacher is never sent a pupil's score;
  a name is opt-in per class; looking up a class sends no credential; practice
  works offline. Competitors are consumer accounts with a school skin.
- **Accessibility compliance.** EN 301 549 and Section 508 both reduce to WCAG
  2.1 AA, and it is an RFP line with a yes/no answer. Sonare enforces it *in
  CI*, on every screen, across three engines, plus rendered tap targets and
  keyboard reachability. Few products of any size can evidence that.

**Cost:** writing, not building. **Blocked on:** nothing.

### 4 · Install path and the web-app story

**Borrowed from:** nobody — competitors cannot do this.

Running on locked-down school fleets and Chromebooks is a distribution
advantage being treated as a constraint. The one real cost is that nobody is
told they can keep the app.

`src/lib/install.ts` exists: three routes, because Chromium fires
`beforeinstallprompt`, iOS fires nothing and never has, and everything else
gets neither. **No popup** — it lives on a screen somebody chose to open. A
product built on not nagging does not get to make its first interruption an ad
for itself.

**Cost:** small, in progress. **Blocked on:** nothing.

### 5 · One perception course

**Borrowed from:** Pimsleur. Template written
(`docs/PERCEPTION-COURSE-TEMPLATE.md`). **Blocked on:** D2, then D3.

### 6 · Native review as a process

**Borrowed from:** Busuu. **Blocked on:** D3. **Cost:** recurring, small.

### 7 · Articulation diagrams per scorable sound

**Borrowed from:** ELSA. **Blocked on:** D4.

### 8 · Curriculum alignment — a real gap

Schools buy against a syllabus. CEFR levels, and in the UK exam-board
specifications, are how a department justifies a purchase.

**Sonare has no alignment story at all.** Content is chosen for the sounds it
drills, which is pedagogically right and commercially invisible. Cheaper to fix
than it looks — the content exists and the mapping is what is missing.

**Cost:** moderate. **Blocked on:** nothing, though a language reviewer helps.

### 9 · Content depth — the weakest dimension

Competitors ship hundreds of hours; French has 21 activities. Every honesty
advantage is worth nothing to a learner who finishes in a fortnight, and this
is the gap most likely to lose a trial.

**Blocked on:** D3 — depth without a native reader is depth nobody has checked.

### 10 · Regenerate the model voice at publish time

**Blocked on:** D5. **Cost:** small.

---

## Part 3 — Definition of done for 0.3.0

1. The tree is tagged and `package.json` matches.
2. A teacher can reach the board without typing a URL.
3. The browser suite has an owner and a place in the release steps.
4. The procurement story — data protection and accessibility compliance — is
   written somewhere a buyer can be sent.
5. All five gates green, and the browser suite green on three engines.

Items 5 to 10 are 0.3.x or 0.4.0 depending on the decisions above.

---

## Part 4 — Deliberately out

- **The vowel chart.** Male voices 11–17 Hz error, female 327–368, child up to
  1087, against a 60 Hz tolerance. The gate refusing to draw it is correct.
- **Production scoring for Kannada or Hindi.** 0 syllables named.
- **Engagement mechanics.** Not an omission — the position, and now T16.
- **A native app.** The web is the advantage, not a stage to grow out of.

## Part 5 — Needs hands, not decisions

- **VoiceOver and TalkBack**, one activity each. Unautomatable.
- **The accent fairness study** (T19) — whether the scorer is harder on some
  first languages than others. Needs scope and a reviewer.
- **Willingness to pay.** Competitor prices and our own unit costs are now in
  `docs/COMPETITIVE-POSITION.md` — single-digit dollars per learner per year in
  variable cost, against a market anchored at $70–$160. What a school would
  actually pay is the part nobody has asked, and it is not derivable from
  either number.
