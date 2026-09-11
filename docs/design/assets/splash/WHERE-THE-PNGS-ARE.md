# The exported PNGs live in `public/splash/`

Seven files, 1.09 MiB, byte-identical to the handoff export. They are **source
assets that get served**, so they belong in `public/`, not in `docs/` —
committing them in both places would put 1.09 MiB of identical bytes in the tree
twice, which is why this note is here instead of the images.

| In the handoff | In the repository |
|---|---|
| `assets/splash/apple-splash-*.png` | `public/splash/apple-splash-*.png` |
| `assets/splash/icon-maskable-512.png` | `public/splash/icon-maskable-512.png` |
| `assets/splash/icon-1024.png` | `public/splash/icon-1024.png` |

The five `apple-touch-startup-image` links and their `media` queries are in
`index.html`, with the reasoning beside them. The two icons are in
`public/manifest.webmanifest`; only `icon-maskable-512.png` is declared
`purpose: "maskable"`, and `scripts/pwa-manifest.test.ts` holds that both ways —
relabelling `brand/icon.png` fails, and dropping the padded one fails too.

## The budget was split rather than raised

They could not land while `scripts/perf-budgets.test.ts` held all of `public/`
to one ceiling of about 205 KiB against 33 KiB of headroom. That ceiling
conflated two costs:

- **What every learner fetches** — the brand images, the manifest, the service
  worker. Paid on every visit, the worker in main-thread parse time. It keeps
  the tight ceiling, still 205 KiB, and now measures 186.7 KiB because two files
  that were never in any budget are in this one.
- **What one device conditionally fetches** — a splash frame. iOS requests only
  the file whose `media` query describes the phone it is running on, once, at
  install; the other four are never asked for by that device, and an Android
  phone asks for none of them. Summing them measures a transfer nobody makes.

So conditionally-fetched media has its own limit and it is keyed on **the
largest single file**: 256 KiB, against 236.2 KiB measured for the largest
(`icon-1024.png`). A count ceiling sits beside it — at most twelve such files —
because the number of files is a repository cost the per-asset ceiling cannot
see, and pasting Apple's full thirty-odd-entry startup-image matrix would pass
every byte ceiling while putting 6 MB in every clone.

## These exports are about 45% larger than they need to be

Measured, not guessed. All seven are 8-bit **RGBA** and **every pixel is fully
opaque** — the alpha channel carries one value across 1.09 MiB of image. A
splash is a wordmark on a flat ground; it has nothing to be transparent for.

Re-exported as alpha-free 8-bit RGB, at the same resolution and with no loss of
any kind, the estimated sizes are:

| File | Now | Alpha-free RGB | Saving |
|---|---|---|---|
| `apple-splash-1290x2796.png` | 201,353 | ~103,550 | 48.6% |
| `apple-splash-1179x2556.png` | 175,984 | ~89,824 | 49.0% |
| `apple-splash-1170x2532.png` | 175,749 | ~89,717 | 49.0% |
| `apple-splash-1125x2436.png` | 163,371 | ~84,151 | 48.5% |
| `apple-splash-828x1792.png` | 107,604 | ~57,263 | 46.8% |
| `icon-1024.png` | 241,914 | ~149,914 | 38.0% |
| `icon-maskable-512.png` | 80,330 | ~50,967 | 36.6% |
| **Total** | **1,146,305** | **~625,386** | **45.4%** |

Estimated by decoding each file, dropping the alpha byte, re-filtering and
deflating at level 9 — which is what a real encoder's IDAT would come to, plus a
few dozen bytes of chunk framing.

**Palettising is not the answer.** The images carry 3,661 to 14,124 distinct
colours after antialiasing, so an 8-bit palette does not fit without
quantisation, and quantising a gradient-free flat ground is how banding appears
on a screen the learner stares at for a second and a half. Alpha-free RGB is
lossless and gets almost all of it.

There is also **5,770 bytes per file — 40,390 in total** — of `caBX` chunk in
every export: the design tool's own canvas metadata, ancillary, ignored by every
decoder, and shipped to every device.

**This repository cannot do the re-encode.** Nothing installed can write a PNG:
there is no `sharp`, `pngjs`, `optipng`, `pngquant` or `zopflipng`, and adding
one is a new dependency. macOS's `sips` is present but cannot drop an alpha
channel — a round-trip through it re-deflates and strips `caBX` for about 12% on
the largest file and leaves the image RGBA. Hand-rolling an encoder to save
500 KiB is not a trade worth making.

So the ask goes back to the design side: **re-export the seven with the alpha
channel off**. Nothing else about them needs to change, and the committed files
stay byte-identical to whatever arrives so the two copies can be diffed.
