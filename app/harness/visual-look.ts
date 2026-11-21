'use strict';
// visual-look.ts - harness side of the visual check ("look at the page like a
// reader", before writing another page).
//
// The Electron host installs the capture service (main/visual-look-service.js,
// created from main/index.js exactly like windows-service installs the Windows
// desktop): a hidden window loads the rendered page, runs the in-page checks
// and returns visual problems plus contact-sheet screenshots. Headless runs
// have no capture host; the check is then skipped with a note and the render
// still stands.

let service = null;

function configureVisualLook(svc) { service = svc; }

const NONE = { skipped: '', problems: [], sheets: [], errors: [], widths: {} };

async function lookAt(file) {
  if (!service) {
    return { ...NONE, skipped: 'no capture host in this runtime (headless run): the page was rendered but not visually checked. Open it in a browser yourself.' };
  }
  try {
    return await service.lookAt(String(file));
  } catch (e) {
    // the page is already written; a capture failure is a skipped check, not a failed render
    return { ...NONE, skipped: `the visual check could not finish: ${String(e?.message || e).split('\n')[0]}` };
  }
}

module.exports = { configureVisualLook, lookAt };