# Store screenshots

Captured 2026-08-21 at 1280x800, the Chrome Web Store's larger accepted size.

| file | what it shows | where it was taken |
|---|---|---|
| `01-summary.jpg` | a real summary of a real video, with the timestamp chips that seek the player | live youtube.com |
| `02-ask.jpg` | the follow-up question box open under a summary | live youtube.com |
| `03-settings.jpg` | the settings page: OpenRouter sign-in, or bring your own key | the real settings page, served by `dev/serve.py` |
| `90-error-feedback.jpg` | not for the listing — the failure state with Copy diagnostics and Report on GitHub | live youtube.com |

`03-settings.jpg` is the real `src/options/options.html`, `options.css` and `options.js`;
only the `chrome` API underneath is stubbed, so what is on screen is what a user sees.
The first-run tour was skipped before the shot.

`docs/screenshot.png` is the OLD one and must not be submitted: it came from the dev
harness's fake watch page, it is 1512x797 (neither accepted size), and it shows a
"WALKTHROUGH" heading no summary style produces any more.
