# T19 runbook — running the fixture

Everything needed to execute T19 in one place, because the tooling is built and
nobody has written down how to drive it. The instrument works; this is the
procedure.

Read `PRD.md` §8 first if you have not. The one line that matters most:
**a contaminated Set A invalidates the entire experiment.**

---

## 0. The decision that comes first

PRD §8 specifies "40 target words". **Use phrases instead.** Measured on the
same vocabulary in one run (`npm run fixture-design`, 4 Sep 2026):

| Design | Set A p25 | Set B p75 | Separation |
|---|---|---|---|
| Single words | 95.8 | 90.0 | **5.8** |
| Phrases | 97.0 | 78.5 | **18.5** |

Words separate positively, so a word fixture would not produce a *null* result
— but a quarter of the deliberately-mispronounced words still scored 90 or
above, because a single word gives the scorer less to be wrong about. Phrases
leave room.

Cost is not a tiebreaker: OQ-2 established $1.00 per audio hour with no minimum
billable duration, so the whole 80-recording run is **2–13 cents** either way.

If you overrule this and use words, the runbook still works — change what goes
in the reference-text field. But record the decision, because the separation
figure it produces will be smaller and someone will ask why.

---

## 1. What you are collecting

Per PRD §8, two sets of the **same** phrases:

- **Set A** — spoken *acceptably* by speakers with strong L1 accents. Accented
  is the point; wrong is not. **Every Set A recording must be independently
  confirmed acceptable by a fluent speaker before it counts.** Drop anything
  ambiguous rather than arguing about it.
- **Set B** — the same phrases *deliberately mispronounced* by fluent speakers.
  Realistic learner errors: substituted phonemes, wrong stress, dropped final
  consonants. Not comic mispronunciation — that tests nothing.

**80 recordings total**, split across at least two platforms (PRD §3 S2 names
iPhone Safari and desktop Chrome as the minimum pair). A workable shape:

| | Speakers | Phrases each | Recordings |
|---|---|---|---|
| Set A, iPhone | 2 | 10 | 20 |
| Set A, desktop | 2 | 10 | 20 |
| Set B, iPhone | 2 | 10 | 20 |
| Set B, desktop | 2 | 10 | 20 |

The ten phrases are already in the product — `src/activities/languages/french.ts`,
and the fixture runner offers them in a dropdown, so nobody has to retype them.

---

## 2. Before the speakers arrive

```bash
npm ci
npm run dev:server      # API on :5181
npm run dev:client      # web on :5180, separate terminal
```

Needs `mongod` running and `AZURE_SPEECH_KEY` in `.env`. Check both:

```bash
curl -s localhost:5181/api/v1/health     # expect {"ok":true,...,"configured":true}
```

`configured: true` means the key and region are present. It does **not** prove
Azure is reachable — score one clip to prove that:

```bash
npm run smoke fixtures/sample.wav "Would you like something to drink" en-US
```

**For iPhone recording you need an HTTPS tunnel.** `getUserMedia` will not open
the microphone on a LAN address — it is not a secure context, and `localhost` is
the only exempt origin.

```bash
ngrok http 5180
```

`vite.config.ts` already allowlists ngrok hosts. Open the HTTPS URL on the
phone; on a free ngrok domain, tap through the one-time interstitial.

> **Untested path.** No iOS session has ever been run. The per-activity
> microphone prewarm calls `getUserMedia` outside a user gesture, which works on
> Chrome and is exactly the kind of thing Safari refuses. Budget time for this
> to misbehave, and record what happens — it is a finding either way.

---

## 3. Recording a session

Go to **`#/fixture`** (typed directly — there is no nav link to it).

For each recording:

1. **Set** — `Set A — accented, correct` or `Set B — fluent, deliberately wrong`.
   Getting this wrong silently poisons the analysis; it is the one field with no
   second chance.
2. **Speaker label** — stable per person, e.g. `S03-tamil-en`. The analysis
   groups by it, so the same person must carry the same label across platforms.
3. **Language** — `French · fr-FR`.
4. **Preloaded phrase** — pick from the dropdown; the reference text fills in.
5. **Start speaking**, then let auto-stop end the take.

Watch the level meter. If it says **"distorting — back off the mic"**, the input
is over-driven: lower the input gain or move the microphone back and redo that
take. Clipping does not stop the scorer (60% clipped still scored 93 in
testing), but it is not what you want in a measurement.

An **UNCLEAR** result does not count as a recording. Redo it. If a speaker
produces several in a row, note it — that is a finding about the scorer, not an
operator error.

**Do not reload the tab.** The session log is in memory only. Export before
closing.

---

## 4. Exporting

**Download JSON** at the bottom of the fixture runner. The file is named
`fixture-set-<set>-<n>-attempts.json`.

Export **once per session**, and keep every file — the analysis accepts several
at once. Name them so you can tell them apart afterwards:

```
fixture-A-iphone-s01s02.json
fixture-A-desktop-s03s04.json
fixture-B-iphone-s05s06.json
fixture-B-desktop-s07s08.json
```

Each entry carries the set, speaker, reference text, user agent, context sample
rate, granted constraints, duration, SNR and the full result. That is
deliberate: it is what lets a surprising score be explained afterwards rather
than argued about.

---

## 5. Analysis

```bash
python3 scripts/analyze_fixture.py fixture-*.json
```

Standard library only. `pip install matplotlib` adds a plot; the tables are the
deliverable.

It prints per-language and per-platform distributions and the separation figure:

```
separation = p25(Set A) − p75(Set B)
```

Percentiles rather than means, deliberately — comparing averages lets a few
confident outliers manufacture a gap the typical learner never experiences.

Indeterminate attempts are **excluded, not counted as zero**. The count is
printed so nobody has to wonder.

---

## 6. Reading the result

TASKS T19's four outcomes, unchanged:

| Outcome | Meaning |
|---|---|
| Sets separate cleanly on both platforms | Scoring works. Ship on web. |
| Sets separate; iPhone consistently lower | Calibratable offset. Ship on web with per-platform thresholds. |
| Sets separate on desktop; noisy on iPhone | Genuine platform problem. Escalate to the native spike. |
| Sets do not separate anywhere | Scorer is not the answer. Stop and investigate. |

For calibration, the TTS proxy run produced **18.5** on phrases. Expect human
numbers to differ — that run used an English voice reading French as a stand-in
for an accent, which is not the same thing as a person.

Write the outcome into `RESULTS.md` with the distributions, the separation
figures and which of the four rows you landed on. That file is T19's actual
deliverable and does not exist yet.

---

## 7. A fifth outcome the table does not have

If the sets fail to separate, check the recordings **before** concluding the
scorer is not the answer. Set A contamination produces exactly the same signal
as a scorer that cannot discriminate, and §8's warning about it exists because
it is easy to do and impossible to detect afterwards.

Two things make it likelier than it sounds. A Set A speaker who is nervous may
produce genuinely wrong pronunciation while everyone present agrees it sounded
fine. And a Set B speaker asked to mispronounce may do it so mildly that the
scorer correctly gives them a high score.

The defence is the one §8 already names: independent confirmation of every Set
A recording by a fluent speaker, and dropping anything ambiguous.

---

## 8. Cost and limits

At $1.00 per audio hour with per-second billing rounded up per request, 80
recordings of 2–6 seconds costs **$0.02–$0.13**. The daily cap is 2000 calls;
a session will use under a hundred. Check spend afterwards at
`#/diagnostics?token=<DIAGNOSTICS_TOKEN>` — it reports calls, billable seconds
and cost against the cap.

Prosody is *not* enabled, so the $0.30/hr enhanced-feature meter does not apply.
If anyone turns it on, the rate becomes $1.30 and
`AZURE_SPEECH_RATE_PER_AUDIO_HOUR` needs updating to match.
