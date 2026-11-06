# legacy/

Kept, not used. Nothing here is loaded, imported or built by the launcher — it is the **web
version** of VOID Client that came before the Electron app, plus two one-off verification
scripts that the current suite replaced. It is parked here instead of deleted so the history
and the old stats endpoint stay readable.

## web/ — the pre-Electron version

| File | What it was |
| --- | --- |
| `app.js`, `index.html`, `settings.js`, `launch.js` | A browser page that assembled a launch command and handed it to a protocol handler. Superseded by the Electron app in `src/`. |
| `server/stats.php`, `server/schema.sql` | The community-stats endpoint the web version talked to. `src/main/stats.js` implements the same contract today. |
| `dist-web/` | Build output of that page (git-ignored). |
| `verify_mod_updates.js`, `verify_proxy.js` | One-off bug checks from the web era. `verify_launcher.js` in the repo root is the suite that runs now. |

## Why not delete it

The web pages are the only copy of the old protocol-handler flow and of the PHP stats
endpoint. If the project ever publishes a browser-based installer again, that is the starting
point. Nothing here should be edited to fix a bug — fix it in `src/`.
