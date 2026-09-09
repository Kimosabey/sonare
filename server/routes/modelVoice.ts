/**
 * Serving the cached model voice — a static file read and nothing else.
 *
 * **No synthesis happens here.** That is the point of the cache: this route
 * cannot call a paid API, cannot cost money, and cannot be made slow by a
 * provider having a bad day. Generation is `npm run generate-model-voice`.
 *
 * ## Why it lives under /api/v1
 *
 * Because the dev server proxies exactly `/api` to this process
 * (vite.config.ts). A path anywhere else would be answered by Vite in
 * development, 404, and send whoever hit it looking for a bug in the client.
 * Mounting here means one URL works in dev, in a preview build and in
 * production with no configuration.
 *
 * ## Caching headers, which differ on purpose
 *
 * The audio file names are cache keys — sha256 over content version, language,
 * phrase, voice and model — so a file's bytes can never change under its name.
 * Those get a year and `immutable`, which is what makes a learner who has
 * heard a phrase once not pay for it again.
 *
 * `manifest.json` is the opposite: it is rewritten on every generation run and
 * is the only thing that tells a client which audio exists. Served with
 * `no-cache`, so a browser revalidates rather than serving yesterday's index
 * of files that have since been pruned. Getting these the same way round would
 * either break the immutability win or serve a stale manifest — the second is
 * worse, because the client would request audio that is gone.
 *
 * ## A 404 is a normal answer
 *
 * Nothing generated, no key configured, the directory absent entirely: all
 * three answer 404, and the client reads that as "use the platform voice",
 * exactly as `GET /content/:slug` 404s into the bundled activity set. There is
 * no error state to render, because there is no error — the app has a model
 * voice either way.
 *
 * ## The whole directory is served
 *
 * `express.static` answers for every file under the cache directory, not only
 * the two shapes this cache writes. That is fine and stated rather than
 * assumed: the directory holds our own reference audio and an index of it, all
 * of it already public, and `MODEL_VOICE_CACHE_DIR` must therefore point at a
 * directory used for nothing else. Filtering to `*.mp3` and `manifest.json`
 * here would read as a security boundary that this is not — the boundary is
 * the directory.
 *
 * ## Not rate-limited, and why that is defensible
 *
 * Every other route on this server that touches a metered provider is behind a
 * limiter. This one reads a small file off local disk, and 40 files is the
 * whole corpus. Adding the diagnostics limiter would put a 100-request ceiling
 * in front of an asset a page can legitimately request repeatedly, which is a
 * self-inflicted outage in exchange for bounding something that costs nothing.
 */

import express, { Router } from "express";
import { cacheDir, MANIFEST_FILE } from "../modelVoice/cache.js";

export const modelVoiceRouter = Router();

/** A year. Safe only because the file name is a hash of the file's inputs. */
const IMMUTABLE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

modelVoiceRouter.use(
  "/model-voice",
  express.static(cacheDir(), {
    // No directory listings: the cache directory is not a browsable index,
    // and a client that needs to know what exists reads the manifest.
    index: false,
    dotfiles: "deny",
    extensions: false,
    /**
     * Left as-is (`true`) so a missing file falls through to the app's own
     * 404 rather than being answered by this middleware — and so a request
     * for something that is not an mp3 or a manifest cannot be mistaken for
     * a served asset.
     */
    fallthrough: true,
    setHeaders: (res, path) => {
      if (path.endsWith(`/${MANIFEST_FILE}`)) {
        res.setHeader("Cache-Control", "no-cache");
        return;
      }
      res.setHeader("Cache-Control", `public, max-age=${IMMUTABLE_MAX_AGE_SECONDS}, immutable`);
    },
  }),
);
