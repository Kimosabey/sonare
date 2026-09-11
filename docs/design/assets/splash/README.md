# Splash and icon assets

Exported at true resolution from `Sonare Splash.dc.html`. Ground is `#fcfbfe` —
the app's own `--ground` — so there is no colour jump between the splash and
first paint.

| File | Size | For |
|---|---|---|
| `apple-splash-1170x2532.png` | 1170×2532 | iPhone 12 / 13 / 14 / 15 |
| `apple-splash-1290x2796.png` | 1290×2796 | Pro Max |
| `apple-splash-1179x2556.png` | 1179×2556 | 15 / 16 Pro |
| `apple-splash-1125x2436.png` | 1125×2436 | X / XS / 11 Pro |
| `apple-splash-828x1792.png` | 828×1792 | XR / 11 |
| `icon-maskable-512.png` | 512×512 | Android maskable — art at 60%, inside the safe circle |
| `icon-1024.png` | 1024×1024 | Android splash source icon |

Five iPhone resolutions, chosen deliberately. Anything older falls back to the
browser default rather than joining a list of forty nobody audits.

## Manifest

```json
{
  "name": "Sonare",
  "background_color": "#fcfbfe",
  "theme_color": "#41009a",
  "icons": [
    { "src": "/brand/icon.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/splash/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "/splash/icon-1024.png", "sizes": "1024x1024", "type": "image/png", "purpose": "any" }
  ]
}
```

`background_color` **must** equal `--ground`. `theme_color` paints OS chrome and
is the brand violet; using the violet as `background_color` is the visible flash
at launch. Only the padded file is declared `maskable` — the existing
`brand/icon.png` was not drawn for a circular crop.

## iOS links

Safari ignores the manifest for splash and wants one link per resolution:

```html
<link rel="apple-touch-startup-image" href="/splash/apple-splash-1290x2796.png"
      media="(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)">
<link rel="apple-touch-startup-image" href="/splash/apple-splash-1179x2556.png"
      media="(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)">
<link rel="apple-touch-startup-image" href="/splash/apple-splash-1170x2532.png"
      media="(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)">
<link rel="apple-touch-startup-image" href="/splash/apple-splash-1125x2436.png"
      media="(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)">
<link rel="apple-touch-startup-image" href="/splash/apple-splash-828x1792.png"
      media="(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)">
```

Coverage is inconsistent across iOS versions; a device that matches no `media`
query gets the browser default, which is why the background colour matching
`--ground` matters more than the list being exhaustive.

## Check the handover

A splash covers until first paint. If the app then shows a route-level
"Loading…", the learner sees two loading states in a row — so the first screen
must paint content, not a spinner.
