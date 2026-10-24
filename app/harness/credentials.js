'use strict';
// Electron safeStorage uses Windows DPAPI/macOS Keychain/Linux secret service.
// CLI receives env keys only; never decrypts or writes plaintext credentials.
// Electron 45: sync safeStorage APIs are deprecated in favor of async variants.
// Async surface here, with a sync adapter for existing synchronous callers.

const fs = require('fs');
const path = require('path');

function vault(safeStorage, dir) {
  const file = path.join(dir, 'credentials.enc');
  async function availableAsync() {
    // Newer API is async; older Electron may not have it — fall back cleanly.
    const ok = safeStorage.isAsyncEncryptionAvailable
      ? await safeStorage.isAsyncEncryptionAvailable()
      : safeStorage.isEncryptionAvailable();
    if (!ok) throw new Error('OS credential encryption unavailable. Configure provider key via environment; plaintext storage refused.');
  }
  function available() {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS credential encryption unavailable. Configure provider key via environment; plaintext storage refused.');
    }
  }
  return {
    async readAsync() {
      if (!fs.existsSync(file)) return {};
      await availableAsync();
      return JSON.parse(await safeStorage.decryptStringAsync(fs.readFileSync(file)));
    },
    async writeAsync(values) {
      await availableAsync();
      fs.mkdirSync(dir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, await safeStorage.encryptStringAsync(JSON.stringify(values)), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
    // Sync adapters: existing call sites (secureConfig, settings:save) stay sync.
    read() { if (!fs.existsSync(file)) return {}; available(); return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); },
    write(values) { available(); fs.mkdirSync(dir, { recursive: true }); const tmp = file + '.tmp'; fs.writeFileSync(tmp, safeStorage.encryptString(JSON.stringify(values)), { mode: 0o600 }); fs.renameSync(tmp, file); },
  };
}
module.exports = { vault };
