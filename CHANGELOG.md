# Changelog

## v1.1.0 — Reliability & safety fix release (Chrome extension + Android app)

### Auto-unfollow & safety
- **Stop / Pause / emergency stop are delivered to every open Instagram tab.** They used to reach only the "best" tab, so a run started in another tab kept going.
- An unfollow confirmed just before Stop/Pause landed is still recorded and counted toward the 1h/24h caps.
- The Gaussian delay and micro-break cadence survive Pause→Resume and Stop→Start (toggling no longer allowed back-to-back unfollows).
- A stale loop waking up after a fast Pause→Resume can no longer silently kill the new run.
- The runner pauses with a reason instead of freezing on "running" when the page reloads/navigates (including the Migrate stepper re-using the tab) or state can't be read; back/forward-cache restores re-boot the content script.
- Private-account unfollows wait for the button to flip / the late second "Unfollow?" dialog before being counted; an already-open confirmation dialog pauses the run instead of being confirmed for the wrong account.
- While the emergency breaker is latched, late "stopped" patches can't hide it (extension + Android).
- Restriction detection ignores DMs and Instagram's generic Persian "Retry" label (false emergency stops); SVG nodes are skipped correctly.
- The scan pauses itself if no new accounts load for ~45 cycles (a stuck spinner used to keep it scanning forever).

### Rate limiter
- Cooldown is computed from the correct timestamp when usage is **over** the cap (lowered limit / manual unfollows).
- Timestamps from a clock that moved backwards are clamped instead of dropped (Android) or kept forever (extension).
- Timestamp merges use a multiset union: re-importing the same backup doesn't double-count, and distinct actions in the same millisecond aren't collapsed.

### Backup import / export
- **Replace** import asks for confirmation, keeps the device's rolling 1h/24h history and any latched emergency stop; imports are refused while a scan/run is active.
- Merge keeps your newer local Migrate/Drop decisions on ties and no longer re-queues accounts you un-queued.
- Imported backups can't point profile links at non-Instagram URLs (profile fallback navigated the logged-in tab to them).
- Usernames such as `constructor` / `__proto__` (valid on Instagram) are stored correctly.
- CSV export has a UTF-8 BOM (Persian names in Excel) and neutralizes formula-looking cells.
- Unreadable stored state is kept aside instead of being silently overwritten with defaults.

### Side panel
- Safety-limit edits are no longer reverted every second while the runner is active; toggles no longer save unsaved slider edits; number fields accept typed values (no more "25" → "105").
- "Reset All Data" ignores the second click of a habitual double-click.
- The account list no longer renders blank after passing through an empty filter, and no longer jumps back to the last stepped profile on every update.
- Space-to-step ignores key-repeat, double presses and focused buttons/links; clicking a row updates the stepper position; undoing "Done" gives the warm-up slot back.
- Persian search matches Arabic/Persian letter variants; long Persian display names truncate at the correct end; status pills/tints that Tailwind never generated are fixed.

### Android app
- Recovers instead of crashing when the WebView renderer is killed or crashes.
- "Switch IG Account" really stops a running scan/unfollow before clearing the session; Back no longer returns to the signed-out page.
- Live progress patches are written to disk at most every ~2 s (was a full-state fsync every second on the UI thread); responses are no longer re-parsed several times; storage errors return an error instead of crashing.
- The bridge is dropped and automation paused when the Instagram page leaves Instagram or fails to load.
- One process-wide state store (activity recreation no longer creates a second writer); more config changes handled in place.
- Exports survive process death while the save picker is open and are written off the UI thread.
- Plain-`http` external links open in the browser instead of doing nothing; double-tap reset of the split ratio sticks.
- Data excluded from Android 12+ device-to-device transfer; a Gradle build without the synced web bundle now fails with a clear message instead of producing a crashing APK.
- `versionCode 2` / `1.1.0`, signed with the same key so it installs over v1.0.0.

## v1.0.0
- Initial public release.
