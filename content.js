// Decides whether an ad is playing and tells the service worker, which mutes
// the tab. All timing lives here because the service worker can be suspended.
(() => {
  if (globalThis.__adMuteLoaded) return;
  globalThis.__adMuteLoaded = true;

  const { DEFAULT_SETTINGS, resolveRule } = globalThis.AD_MUTE;

  const TICK_MS = 400;
  // Stay muted this long after the last ad signal, so back-to-back ads don't flap.
  const HOLD_MS = 800;

  // "Ad", "Ads", "Ad 1 of 2", "Ad · 0:15", "Advertisement 2/3" — but not "Ad Astra".
  const AD_LABEL = /^(ads?|advertisement)\b[\s\d:·•|/\-of]*$/i;
  const AD_PHRASE =
    /\b(skip ads?|ad (will end|ends) in|(video|content|show|movie|programme?|stream) will (resume|play|start|continue|begin)|resum(es?|ing) (in|after))\b/i;

  const SKIP_LABEL = /^skip(\s+(the\s+)?ads?)?$/i;
  // Pause between skip attempts; hammering the player makes it hang.
  const SKIP_COOLDOWN_MS = 1000;
  const SHORT_VIDEO_MAX_S = 120;

  let settings = { ...DEFAULT_SETTINGS };
  let beaconUntil = 0;
  let beaconName = '';
  let lastSeen = 0;
  let lastSignal = '';
  let reported = false;
  let nextSkipAt = 0;
  let skips = 0;

  const log = (...args) => settings.debug && console.log('[ad-mute]', ...args);

  const isVisible = (el) => el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });

  // First visible element sitting on top of a video whose own text passes `test`.
  function findOverVideo(test) {
    const videos = [...document.querySelectorAll('video')]
      .map((v) => v.getBoundingClientRect())
      .filter((r) => r.width > 200 && r.height > 100);
    if (!videos.length) return null;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node; (node = walker.nextNode()); ) {
      const text = node.nodeValue.trim();
      if (!text || text.length > 60 || !test(text)) continue;
      const el = node.parentElement;
      if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/.test(el.tagName) || !isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (videos.some((v) => x >= v.left && x <= v.right && y >= v.top && y <= v.bottom)) return el;
    }
    return null;
  }

  const findAdText = () => findOverVideo((t) => AD_LABEL.test(t) || AD_PHRASE.test(t))?.textContent.trim();

  // Returns a description of what gave the ad away, or null.
  function detect(rule) {
    if (Date.now() < beaconUntil) return `beacon "${beaconName}"`;
    for (const { css, text } of rule.selectors) {
      let els;
      try {
        els = document.querySelectorAll(css);
      } catch {
        continue; // invalid user-supplied selector
      }
      for (const el of els) {
        if (!el.getClientRects().length) continue;
        if (text && !el.textContent.trim()) continue;
        return `selector ${css}`;
      }
    }
    if (rule.heuristic) {
      const text = findAdText();
      if (text) return `text "${text}"`;
    }
    return null;
  }

  function clickSkipButton(skip) {
    let button = null;
    for (const css of skip.buttons || []) {
      button = [...document.querySelectorAll(css)].find(isVisible);
      if (button) break;
    }
    button ??= findOverVideo((t) => SKIP_LABEL.test(t));
    if (!button) return null;
    (button.closest('button, [role="button"], a') || button).click();
    return 'clicked skip button';
  }

  // The ad is part of the main video: jump ahead by what the countdown says is left.
  function skipByTimer(skip) {
    if (!skip.timer) return null;
    let left = 0;
    for (const el of document.querySelectorAll(skip.timer)) {
      const m = el.checkVisibility() && el.textContent.match(/(\d+):(\d{2})/);
      if (m) left = Math.max(left, Number(m[1]) * 60 + Number(m[2]));
    }
    const video = document.querySelector(skip.video) || document.querySelector('video');
    if (left < 2 || !video || video.paused || !(video.currentTime > 0)) return null;
    const jump = Math.min(left - 1, skip.maxJump);
    video.currentTime += jump;
    if (jump === skip.maxJump) nextSkipAt = Date.now() + 3 * SKIP_COOLDOWN_MS; // let a big seek settle
    return `seeked ${jump}s past ad`;
  }

  // The ad is its own short clip: jump to its end so the player moves on.
  function skipShortVideo(skip) {
    if (!skip.shortVideo) return null;
    for (const video of document.querySelectorAll('video')) {
      const d = video.duration;
      if (video.paused || !Number.isFinite(d) || d > SHORT_VIDEO_MAX_S || video.currentTime > d - 0.5) continue;
      video.currentTime = d;
      return `ended ${Math.round(d)}s ad clip`;
    }
    return null;
  }

  function trySkip(skip) {
    const now = Date.now();
    if (now < nextSkipAt) return;
    const did = clickSkipButton(skip) || skipByTimer(skip) || skipShortVideo(skip);
    if (!did) return;
    nextSkipAt = Math.max(nextSkipAt, now + SKIP_COOLDOWN_MS);
    skips++;
    log(did);
  }

  function report(active) {
    reported = active;
    log(active ? `ad started (${lastSignal}) -> mute` : 'ad ended -> unmute');
    try {
      chrome.runtime.sendMessage({ type: 'ad', active, signal: lastSignal }).catch(() => {});
    } catch {
      clearInterval(timer); // extension was reloaded; this script is orphaned
    }
  }

  function tick() {
    const rule = settings.enabled ? resolveRule(location.hostname, settings) : null;
    const signal = rule && detect(rule);
    const now = Date.now();
    if (signal) {
      lastSeen = now;
      lastSignal = signal;
      if (settings.skip) trySkip(rule.skip);
    }
    const active = !!rule && (!!signal || now - lastSeen < HOLD_MS);
    if (active !== reported) report(active);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'beacon') {
      // Impressions also fire for banners on browse pages; only count them near a player.
      if (!document.querySelector('video')) return;
      beaconName = msg.name;
      beaconUntil = Math.max(beaconUntil, Date.now() + msg.seconds * 1000);
      log(`beacon "${msg.name}" -> ${msg.seconds}s`);
      tick();
    } else if (msg.type === 'status') {
      sendResponse({
        running: settings.enabled && !!resolveRule(location.hostname, settings),
        active: reported,
        signal: lastSignal,
        skips,
      });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const key in changes) settings[key] = changes[key].newValue ?? DEFAULT_SETTINGS[key];
    tick();
  });

  // Never leave the tab muted behind us.
  addEventListener('pagehide', () => reported && report(false));

  let timer;
  chrome.storage.sync.get(DEFAULT_SETTINGS).then((stored) => {
    settings = stored;
    report(false); // clears a mute left over from before a reload
    timer = setInterval(tick, TICK_MS);
    tick();
  });
})();
