// Built-in site rules, shared by the service worker, content script and popup.
//
// A site is "in an ad" when any of these is true:
//   selectors  a matching element is rendered (and has text, when `text: true`)
//   heuristic  a short visible label like "Ad 1 of 2" / "Skip Ad" sits on top of a video
//   beacons    the page fired an ad-impression request (detected in background.js)
//
// When adding a site here, also add its URL to content_scripts.matches in
// manifest.json (and to host_permissions if it uses beacons).
(() => {
  const SITES = [
    {
      id: 'prime',
      name: 'Prime Video',
      hosts: /(^|\.)(primevideo\.com|amazon\.(com|in|co\.uk|de|co\.jp|ca|com\.au))$/,
      selectors: [
        { css: '[class*="atvwebplayersdk-ad-timer"]', text: true },
        { css: '[class*="atvwebplayersdk-adtimeindicator"]', text: true },
      ],
      heuristic: true,
    },
    {
      id: 'hotstar',
      name: 'JioHotstar',
      hosts: /(^|\.)(hotstar\.com|jiohotstar\.com)$/,
      tabUrls: ['*://*.hotstar.com/*', '*://*.jiohotstar.com/*'],
      selectors: [],
      heuristic: true,
      // Live streams have ads stitched into the video, so nothing shows up in
      // the DOM. The player does report each ad though, with the ad's name
      // (which embeds its length, e.g. "..._ipl18HANGOUTEVR20sEng_...").
      beacons: [
        {
          url: '*://bifrost-api.hotstar.com/*',
          param: 'adName',
          durations: [
            /(\d{1,3})s(?:eng(?:lish)?|hin(?:di)?)/i,
            /(?:hindi|hin|english|eng)[^\d]*(\d{1,3})/i,
            /(?:_|^)(\d{2})s?(?=$|_)/,
          ],
          fallbackSeconds: 10,
        },
      ],
    },
    {
      id: 'youtube',
      name: 'YouTube',
      hosts: /(^|\.)youtube\.com$/,
      selectors: [{ css: '.html5-video-player.ad-showing' }, { css: '.html5-video-player.ad-interrupting' }],
      heuristic: false,
    },
    {
      id: 'twitch',
      name: 'Twitch',
      hosts: /(^|\.)twitch\.tv$/,
      selectors: [{ css: '[data-a-target="video-ad-label"]' }, { css: '[data-a-target="video-ad-countdown"]' }],
      heuristic: false,
    },
  ];

  const DEFAULT_SETTINGS = { enabled: true, debug: false, sites: {} };

  const findSite = (hostname) => SITES.find((s) => s.hosts.test(hostname));

  // Key into settings.sites: the built-in id, or the bare hostname for custom sites.
  const customKey = (hostname) => hostname.replace(/^www\./, '');
  const originPattern = (key) => `*://*.${key}/*`;

  // Returns the active rule for this hostname, or null if the extension
  // shouldn't run here. Built-ins default to on, custom sites to off.
  function resolveRule(hostname, settings) {
    const site = findSite(hostname);
    const key = site
      ? site.id
      : Object.keys(settings.sites).find((k) => hostname === k || hostname.endsWith('.' + k));
    const cfg = settings.sites[key] || {};
    if (site ? cfg.on === false : !cfg.on) return null;
    return {
      name: site ? site.name : key,
      selectors: [...(site ? site.selectors : []), ...(cfg.selectors || []).map((css) => ({ css }))],
      heuristic: site ? site.heuristic : true,
    };
  }

  function beaconSeconds(beacon, adName) {
    for (const re of beacon.durations) {
      const n = Number(adName.match(re)?.[1]);
      if (n >= 3 && n <= 180) return n;
    }
    return beacon.fallbackSeconds;
  }

  globalThis.AD_MUTE = { SITES, DEFAULT_SETTINGS, findSite, customKey, originPattern, resolveRule, beaconSeconds };
})();
