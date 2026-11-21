/**
 * Update check against the GitHub releases of this extension.
 * Unpacked extensions can't update themselves, so this only tells the user that a newer version exists:
 * a "↑" badge on the toolbar icon and a banner in the side panel with a link to the release.
 * Checks at most every 12 hours; the result is cached in chrome.storage.local.
 * Classic script: loaded with importScripts / <script>, or imported for its side effect from a module.
 */
(function () {
  const REPO = 'thatBiologyStudent/flow-sidecar-orchestrator';
  const INTERVAL_MS = 12 * 60 * 60 * 1000;
  const KEY = 'updateCheck';

  /** true when version a is higher than b ("1.2.10" > "1.2.9") */
  function isNewer(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
  }

  /** Returns { current, latest, url, dismissed } when a newer release exists, otherwise null. */
  async function check(force) {
    const current = chrome.runtime.getManifest().version;
    let info = (await chrome.storage.local.get(KEY))[KEY];
    if (force || !info || Date.now() - (info.checkedAt || 0) > INTERVAL_MS) {
      try {
        const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
          headers: { Accept: 'application/vnd.github+json' },
          cache: 'no-store',
        });
        if (res.ok) {
          const j = await res.json();
          info = {
            ...info,
            checkedAt: Date.now(),
            latest: String(j.tag_name || '').replace(/^v/i, ''),
            url: j.html_url || `https://github.com/${REPO}/releases/latest`,
          };
          await chrome.storage.local.set({ [KEY]: info });
        }
      } catch {
        // offline or GitHub unreachable: keep the last known result
      }
    }
    if (!info || !info.latest || !isNewer(info.latest, current)) return null;
    return { current, latest: info.latest, url: info.url, dismissed: info.dismissed === info.latest };
  }

  /** Background: set or clear the toolbar badge. */
  async function updateBadge(force) {
    try {
      const u = await check(force);
      await chrome.action.setBadgeText({ text: u ? '↑' : '' });
      if (u) {
        await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
        await chrome.action.setTitle({ title: `${chrome.runtime.getManifest().name}: version ${u.latest} is available` });
      }
    } catch {
      // badge is a nicety only
    }
  }

  /** Side panel: show a banner under the header when an update is available. */
  async function showBanner() {
    const u = await check(false);
    if (!u || u.dismissed || document.getElementById('update-banner')) return;
    const box = document.createElement('div');
    box.id = 'update-banner';
    box.setAttribute('role', 'status');
    box.style.cssText =
      'margin:8px 12px;padding:8px 10px;border:1px solid #d97706;background:#451a03;color:#fde68a;' +
      'border-radius:6px;font-size:12px;line-height:1.45;display:flex;gap:8px;align-items:flex-start;';
    const text = document.createElement('div');
    text.style.flex = '1';
    text.innerHTML =
      `<strong>Version ${u.latest} is available</strong> (you have ${u.current}).<br>` +
      'Download the zip from the release, replace the files in your extension folder, then press <em>Reload</em> on chrome://extensions. ';
    const link = document.createElement('a');
    link.href = u.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = 'Open release →';
    link.style.cssText = 'color:#fbbf24;font-weight:600;';
    text.appendChild(link);
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Hide until the next version';
    close.style.cssText = 'background:none;border:0;color:#fde68a;font-size:16px;line-height:1;cursor:pointer;padding:0 2px;';
    close.addEventListener('click', async () => {
      const info = (await chrome.storage.local.get(KEY))[KEY] || {};
      await chrome.storage.local.set({ [KEY]: { ...info, dismissed: u.latest } });
      box.remove();
    });
    box.append(text, close);
    const header = document.querySelector('.app-header');
    if (header && header.parentNode) header.parentNode.insertBefore(box, header.nextSibling);
    else document.body.prepend(box);
  }

  globalThis.ExtensionUpdate = { check, updateBadge, showBanner, isNewer };
})();
