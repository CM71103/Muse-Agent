'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.resolve(__dirname, '../release-verified/MuseAgent-0.1.7-portable.exe'), [], { env, stdio: 'ignore', detached: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('spawn', () => { console.log('Portable launcher PID:', child.pid); child.unref(); });
