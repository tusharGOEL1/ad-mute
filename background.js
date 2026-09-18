importScripts('sites.js');

const { SITES, DEFAULT_SETTINGS, originPattern, beaconSeconds } = globalThis.AD_MUTE;
const CUSTOM_SCRIPT_ID = 'custom-sites';
const CONTENT_FILES = ['sites.js', 'content.js'];

// Serialize async work so a quick mute/unmute pair can't interleave.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.warn('[ad-mute]', e)));

// We only ever unmute tabs that we muted. The flag lives in session storage
// because this worker can be suspended in the middle of an ad.
const mutedKey = (tabId) => `muted:${tabId}`;

async function setAd(tabId, active) {
  const key = mutedKey(tabId);
  if (active) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.mutedInfo?.muted) {
      await chrome.tabs.update(tabId, { muted: true });
      await chrome.storage.session.set({ [key]: true });
    }
  } else if ((await chrome.storage.session.get(key))[key]) {
    await chrome.storage.session.remove(key);
    await chrome.tabs.update(tabId, { muted: false });
  }
  await chrome.action.setBadgeText({ tabId, text: active ? 'AD' : '' });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'ad' && sender.tab) enqueue(() => setAd(sender.tab.id, msg.active));
});

// If the user toggles mute themselves mid-ad, the tab is theirs again.
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.mutedInfo?.reason === 'user') enqueue(() => chrome.storage.session.remove(mutedKey(tabId)));
});
chrome.tabs.onRemoved.addListener((tabId) => enqueue(() => chrome.storage.session.remove(mutedKey(tabId))));

// --- Ad beacons (server-stitched ads that leave no trace in the DOM) ---

const beaconSites = SITES.filter((s) => s.beacons);

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    const url = new URL(details.url);
    for (const site of beaconSites) {
      for (const beacon of site.beacons) {
        const name = url.searchParams.get(beacon.param);
        if (!name) continue;
        const msg = { type: 'beacon', name, seconds: beaconSeconds(beacon, name) };
        console.log('[ad-mute] beacon', msg);
        notifyTabs(details.tabId, site, msg);
        return;
      }
    }
  },
  { urls: beaconSites.flatMap((s) => s.beacons.map((b) => b.url)) },
);

async function notifyTabs(tabId, site, msg) {
  // Requests made from a worker have no tab; fall back to every tab of that site.
  const tabIds = tabId >= 0 ? [tabId] : (await chrome.tabs.query({ url: site.tabUrls })).map((t) => t.id);
  for (const id of tabIds) chrome.tabs.sendMessage(id, msg).catch(() => {});
}

// --- Custom sites enabled from the popup ---

async function grantedCustomPatterns() {
  const { sites } = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const patterns = [];
  for (const [key, cfg] of Object.entries(sites)) {
    if (!cfg.on || SITES.some((s) => s.id === key)) continue;
    const pattern = originPattern(key);
    if (await chrome.permissions.contains({ origins: [pattern] })) patterns.push(pattern);
  }
  return patterns;
}

async function syncCustomScripts() {
  const matches = await grantedCustomPatterns();
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
  if (!matches.length) {
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_SCRIPT_ID] });
    return;
  }
  const script = { id: CUSTOM_SCRIPT_ID, matches, js: CONTENT_FILES, runAt: 'document_idle' };
  if (existing.length) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

chrome.runtime.onInstalled.addListener(() => enqueue(syncCustomScripts));
chrome.runtime.onStartup.addListener(() => enqueue(syncCustomScripts));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.sites) enqueue(syncCustomScripts);
});

// The popup may close while the permission prompt is up, so finish the job
// here: register the site and start on tabs that are already open.
chrome.permissions.onAdded.addListener(({ origins = [] }) =>
  enqueue(async () => {
    await syncCustomScripts();
    const active = new Set(await grantedCustomPatterns());
    const patterns = origins.filter((o) => active.has(o));
    if (!patterns.length) return;
    for (const tab of await chrome.tabs.query({ url: patterns })) {
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES }).catch(() => {});
    }
  }),
);
