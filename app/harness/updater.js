'use strict';
// updater.js - portable-exe update check. Notify-only by design:
// the portable exe is often file-locked by Windows, so in-place swap is
// unreliable. We check GitHub Releases for a newer tag, notify, and open
// the release page in the user's browser on click. No code download/execute.

const https = require('https');

function cmpSemver(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

// Fetch JSON from a https URL. Timeout-bounded, no redirects followed
// beyond GitHub's normal api endpoint.
function fetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'MuseAgent-Updater', Accept: 'application/vnd.github+json' },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} from update check`));
      }
      let body = '';
      res.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { reject(new Error('bad JSON from update check')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('update check timeout')); });
    req.on('error', reject);
  });
}

// Returns {update: bool, latest, url, notes} or {update:false}. Never throws.
async function checkUpdate(currentVersion, repo = 'CM71103/Muse-Agent') {
  try {
    const rel = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
    const latest = String(rel.tag_name || '').replace(/^v/, '');
    if (!latest) return { update: false };
    if (cmpSemver(latest, currentVersion) <= 0) return { update: false, latest };
    return { update: true, latest, url: rel.html_url || `https://github.com/${repo}/releases/latest`, notes: String(rel.body || '').slice(0, 500) };
  } catch (e) {
    return { update: false, error: String(e && e.message || e) };
  }
}

module.exports = { checkUpdate, cmpSemver };
