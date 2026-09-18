# Ad Mute

Chrome extension that skips ads on streaming sites where it can, and otherwise mutes the tab while the ad
plays and unmutes when it ends.
It mutes the *tab* (like right-click → "Mute site"), so the player's own volume is never touched, and
it never unmutes a tab you muted yourself.

Built in: Prime Video, JioHotstar, YouTube, Twitch. Any other site can be switched on from the popup.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. **Load unpacked** → pick this folder.
3. Reload any streaming tabs that were already open.

## How an ad is detected

| Signal | Used for | How |
| --- | --- | --- |
| Selectors | Prime Video, YouTube, Twitch | A known ad-only element (e.g. Prime's ad countdown) is on screen. |
| Beacons | JioHotstar live | The player reports each stitched-in ad to `bifrost-api.hotstar.com` with an `adName` that embeds its length (`…20sEng…`). The tab is muted for that long. |
| Text heuristic | Prime, Hotstar, custom sites | A short visible label such as "Ad 1 of 2", "Ad · 0:15" or "Skip Ad" sits on top of a video. |

Rules live in `sites.js`.

## How an ad is skipped

The tab is muted the moment an ad is detected; skipping then tries to end it early (toggle in the popup).

| Method | Used for | How |
| --- | --- | --- |
| Skip button | everywhere | A visible "Skip" / "Skip Ad" button over the video is clicked. |
| Countdown seek | Prime Video | Reads the ad countdown and seeks the video forward by what's left (max 90s per jump). |
| Short clip | JioHotstar on-demand, custom sites | If the ad is its own `<video>` of under 2 minutes, it's jumped to its end. |

Ads stitched into a **live** stream (Hotstar cricket, Twitch) can't be skipped — there is nothing to seek
to — so they stay muted.

## Other sites

Open the site, click the extension icon, flip the site toggle and accept the permission prompt. The text
heuristic is used by default. If it misses, find an element that only exists during ads (right-click the
"Ad" badge → Inspect) and paste a CSS selector for it into the popup.

## When it doesn't work

Sites change their markup. Turn on **Log detections** in the popup and watch the page console for
`[ad-mute]` lines; the popup also shows what triggered the last mute. Beacons are logged in the service
worker console (`chrome://extensions` → Ad Mute → *service worker*).

- Ad plays with sound, popup says "Watching": nothing matched — add a selector in the popup or in `sites.js`.
- Prime player hangs or lands mid-scene after a skip: turn off **Skip ads** in the popup to go back to mute-only.
- Hotstar unmutes too early/late: the ad's length wasn't parsed from its `adName`; extend `durations` in `sites.js`.
