# MacroScan

A personal barcode meal logger. Scan a food barcode, pull nutrition from the
[Open Food Facts](https://world.openfoodfacts.org/) database, and track a daily
**sodium budget** alongside protein, calories, carbs, and fat. Everything is
stored locally on your device — no account, no server.

## Features

- **Barcode scanning** using the native `BarcodeDetector` API, with an automatic
  fallback to [ZXing](https://github.com/zxing-js/browser) on browsers that lack
  it (e.g. iOS Safari).
- **Manual entry** by barcode number or as a custom food.
- **Sodium budget** with a live gauge, plus protein / calorie goals.
- **7-day history** with a mini bar chart and re-log shortcuts.
- **Backup & restore** to a JSON file so a cleared browser can't erase history.
- **Installable PWA** — works offline and can be added to your home screen.

## Project structure

| File | Purpose |
|------|---------|
| `index.html` | Markup and view structure |
| `styles.css` | All styling |
| `app.js` | App logic: scanning, lookup, logging, history, backup |
| `sw.js` | Service worker — offline app-shell caching |
| `manifest.json` | PWA manifest |
| `icon.svg`, `icon-maskable.svg` | App icons |
| `.nojekyll` | Tells GitHub Pages to serve files as-is |

## Running locally

A service worker needs to be served over HTTP (not opened as a `file://` path),
so start any static server from this folder:

```bash
# Python 3
python3 -m http.server 8000

# or Node
npx serve .
```

Then open `http://localhost:8000`. The camera and barcode scanner also require a
**secure context**, so use `localhost` (which counts as secure) or an HTTPS host.

## Deploying with GitHub Pages

1. Push this folder to a GitHub repository.
2. In the repo, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*,
   pick your default branch (e.g. `main`) and the `/ (root)` folder, then save.
4. After a minute your app is live at
   `https://<your-username>.github.io/<repo-name>/`.

> **Note:** GitHub Pages on a **private** repository requires a paid GitHub Pro
> plan. On the free tier, make the repository public to use Pages.

## Privacy

All data lives in your browser's `localStorage`. Nutrition lookups are the only
network calls, made directly to Open Food Facts. Use **Export backup** in the
Targets tab to save a copy of your history.
