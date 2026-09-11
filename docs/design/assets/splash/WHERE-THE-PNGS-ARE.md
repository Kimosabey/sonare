# The exported PNGs are not committed here

Seven files, 1.09 MiB. They are **source assets that get served**, so they belong
in `public/`, not in `docs/`. Committing them in both places would put 1.09 MiB
of identical bytes in the tree twice.

They are not in `public/` yet either, and that is deliberate rather than
forgotten: `scripts/perf-budgets.test.ts` holds `public/` to a ceiling of about
205 KiB and it currently sits at roughly 172 KiB. Seven splash exports do not
fit in 33 KiB of headroom, and the honest fix is not to raise the number.

The budget measures bytes on disk, which conflates two different costs:

- **What every learner parses** — JS and CSS. This deserves a tight ceiling,
  because it is paid on every visit and it is paid in main-thread time.
- **What a learner conditionally fetches** — a splash image. iOS fetches only
  the one matching its own `media` query, so per-learner transfer is a single
  file of roughly 170 KiB, once, at install. The other six are never requested
  by that device.

So the budget wants splitting rather than loosening: keep the tight ceiling on
parsed bytes, and give conditionally-fetched media its own limit where the
figure that matters is **the largest single asset**, not the sum.

See `assets/splash/README.md` in the original handoff for the size-to-device
mapping, and the `apple-touch-startup-image` media queries that go with it.
