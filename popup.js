const { DEFAULT_SETTINGS, findSite, customKey, originPattern } = globalThis.AD_MUTE;
const $ = (id) => document.getElementById(id);

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await chrome.storage.sync.get(DEFAULT_SETTINGS);
  const save = () => chrome.storage.sync.set(settings);

  $('enabled').checked = settings.enabled;
  $('enabled').onchange = (e) => {
    settings.enabled = e.target.checked;
    save();
  };
  $('skip').checked = settings.skip;
  $('skip').onchange = (e) => {
    settings.skip = e.target.checked;
    save();
  };
  $('debug').checked = settings.debug;
  $('debug').onchange = (e) => {
    settings.debug = e.target.checked;
    save();
  };

  const url = URL.canParse(tab?.url) ? new URL(tab.url) : null; // tab.url is hidden on chrome:// pages
  if (!url || !/^https?:$/.test(url.protocol)) {
    $('host').textContent = 'This page';
    $('kind').textContent = 'Not a website — nothing to mute here.';
    $('siteOn').hidden = true;
    return;
  }

  const site = findSite(url.hostname);
  const key = site ? site.id : customKey(url.hostname);
  const isOn = () => (site ? settings.sites[key]?.on !== false : !!settings.sites[key]?.on);
  const patch = (fields) => {
    settings.sites[key] = { ...settings.sites[key], ...fields };
    save();
    render();
  };

  function render() {
    $('host').textContent = site ? site.name : key;
    $('kind').textContent = site ? 'Built-in support' : isOn() ? 'Custom site' : 'Not enabled on this site';
    $('siteOn').checked = isOn();
    $('selectorsBox').hidden = !isOn();
  }

  $('selectors').value = (settings.sites[key]?.selectors || []).join('\n');
  $('selectors').onchange = (e) => {
    const selectors = e.target.value.split('\n').map((s) => s.trim()).filter(Boolean);
    patch({ selectors });
  };

  // No awaits before permissions.request: it must run inside the click gesture.
  $('siteOn').onchange = (e) => {
    const on = e.target.checked;
    patch({ on });
    if (site) return;
    const origins = [originPattern(key)];
    if (on) chrome.permissions.request({ origins }).then((granted) => granted || patch({ on: false }));
    else chrome.permissions.remove({ origins });
  };

  async function refreshStatus() {
    const el = $('status');
    let status = null;
    try {
      status = await chrome.tabs.sendMessage(tab.id, { type: 'status' });
    } catch {}
    el.className = '';
    if (!settings.enabled || !isOn()) el.textContent = 'Off';
    else if (!status) el.textContent = 'Not running yet — reload this tab.';
    else if (status.active) {
      el.className = 'ad';
      el.textContent = `Ad playing — muted (${status.signal})`;
    } else {
      el.className = 'ok';
      const skipped = status.skips ? ` Skipped ${status.skips}×.` : '';
      el.textContent = (status.signal ? `Watching. Last ad: ${status.signal}.` : 'Watching — no ad seen yet.') + skipped;
    }
  }

  render();
  refreshStatus();
  setInterval(refreshStatus, 1000);
}

main();
