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

## Done — they were 47% larger than they needed to be

All seven arrived as 8-bit **RGBA with every pixel fully opaque**: the alpha
channel carried one value across 1.09 MiB of image. A splash is a wordmark on a
flat ground; it has nothing to be transparent for.

Re-encoded as alpha-free RGB, at the same resolution, with no loss of any kind:

| File | Was | Now | Saved |
|---|---|---|---|
| `apple-splash-1290x2796.png` | 201,353 | 100,319 | 50.2% |
| `apple-splash-1179x2556.png` | 175,984 | 86,767 | 50.7% |
| `apple-splash-1170x2532.png` | 175,749 | 86,958 | 50.5% |
| `apple-splash-1125x2436.png` | 163,371 | 80,845 | 50.5% |
| `apple-splash-828x1792.png` | 107,604 | 55,569 | 48.4% |
| `icon-1024.png` | 241,914 | 148,514 | 38.6% |
| `icon-maskable-512.png` | 80,330 | 49,281 | 38.7% |
| **Total** | **1,146,305** | **608,253** | **46.9%** |

Slightly better than the 45.4% estimated here, because the estimate assumed the
existing filter choices rather than re-choosing per scanline.

### This note used to say the repository could not do it

> "Nothing installed can write a PNG: there is no `sharp`, `pngjs`, `optipng`,
> `pngquant` or `zopflipng`, and adding one is a new dependency."

The premise was right and the conclusion was wrong. None of those is installed
and none is needed. A PNG is a signature, an IHDR, deflated scanlines and an
IEND — and **Node ships zlib**. `scripts/strip-png-alpha.mjs` is 200 lines and
adds no dependency.

Two things it refuses to do, because both would be silent:

- **It converts only a file where every pixel is fully opaque.** The brand
  favicons are 66% transparent by design — the mark takes the colour of the
  chrome behind it — and flattening one would put a square in a browser tab.
  The check is per file and refusal is the default.
- **It re-decodes its own output and compares every RGB byte before writing.**
  A "lossless" conversion that is not is the one failure nobody would notice
  until a learner saw it. An independent decoder confirmed all seven.

`scripts/png-encoding.test.ts` holds it: the splash files must be colour type
2, the brand images must stay type 6, and the set must weigh about half what it
did. A re-export that brings the channel back fails.

The `caBX` chunks went with the re-encode — 5,770 bytes per file of the design
tool's own canvas metadata, ancillary, ignored by every decoder, and previously
shipped to every device.
