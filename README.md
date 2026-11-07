# That's my Egg! player reports

Report an issue with the game using a screenshot and a short description.
Drop, paste while hovering, or choose an image, draw red highlights, reset
marks and submit. Player reports and screenshots are private.

## Website

GitHub Pages hosts public/. A separate Cloudflare Worker saves reports in D1.
Public configuration is in public/config.json. Never put access keys there.
The site stays closed to submissions until its live API is configured.

## Local development

Use Node.js 24 or later. No dependencies are required for the website,
local development server or tests.

```
npm run dev
npm test
```

The server listens only on http://127.0.0.1:8897. The local inbox key is
local-preview-only. It is not a production key. Development data stays local.

## Cloudflare

Use the official Wrangler CLI from worker/. Create a D1 database, set its
ID in wrangler.jsonc and execute schema.sql on that database. Add ADMIN_TOKEN
and TURNSTILE_SECRET as Worker secrets. Set the exact website origin and
Turnstile hostname, then deploy. Keep the Workers Free plan.

Set the returned Worker HTTPS URL and public Turnstile key in public/config.json.
Production writes require verification and throttling. Private reads and
conditional report removal require the developer access key.

## Collect reports privately

Set REPORT_API_URL and private REPORT_ADMIN_TOKEN in the collector environment.
Set REPORT_OUTPUT_DIR to your private bugs folder, then run npm run retrieve.
The collector verifies saved text and image bytes before removing the report
from the remote active table. Minimal ID/checksum receipts prevent late retries
from recreating archived reports. A failed transfer leaves the remote report
intact. The collector never deletes local evidence. Do not edit the downloaded
original files; retain investigation notes separately.

The developer inbox displays reports still waiting for collection. Collected
reports are available in the developer's private local archive.

## Assets

The game logo and Backyard scene are reused project artwork. The new
Labraduck detective image was generated with built-in ImageGen. Its original,
exact prompt and provenance are in artwork/. Runtime copies are in public/art/.
The visual tokens follow the game's dark panels, blue buttons and gold accents.
Builder Sans fonts are embedded unchanged for this Roblox game's branded site;
see public/fonts/NOTICE.txt and the official linked font terms.

No private player reports, deployment credentials or local data are included.
