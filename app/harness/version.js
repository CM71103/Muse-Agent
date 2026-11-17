'use strict';
// Single source of truth for the app version outside the Electron main process
// (MCP clientInfo, bridge health, Box client). Both the dev checkout and the
// packaged asar keep package.json two levels up from this file
// (app/harness/ -> repo root / asar root). Inside Electron, prefer
// app.getVersion() — this module is the fallback and the non-Electron path.
module.exports = require('../../package.json').version;
