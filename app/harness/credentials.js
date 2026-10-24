'use strict';
// Electron safeStorage uses Windows DPAPI/macOS Keychain/Linux secret service.
// CLI receives env keys only; never decrypts or writes plaintext credentials.
const fs = require('fs');
const path = require('path');
function vault(safeStorage, dir) {
  const file=path.join(dir,'credentials.enc');
  function available() {
    if (!safeStorage.isEncryptionAvailable() || (safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend()==='basic_text')) {
      throw new Error('OS credential encryption unavailable. Configure provider key via environment; plaintext storage refused.');
    }
  }
  return {
    read() { if(!fs.existsSync(file))return {};available();return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); },
    write(values) { available();fs.mkdirSync(dir,{recursive:true});const tmp=file+'.tmp';fs.writeFileSync(tmp,safeStorage.encryptString(JSON.stringify(values)),{mode:0o600});fs.renameSync(tmp,file); },
  };
}
module.exports={vault};
