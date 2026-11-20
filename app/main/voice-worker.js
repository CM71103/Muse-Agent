'use strict';
// voice-worker.js — runs the vibe-calibration scan off the main thread.
//
// Reading every local AI conversation on the machine takes a second or two
// (cold disks: longer). Doing that inside the main process would freeze the
// window, so the scan happens in a worker thread and the result comes back
// as one message. The worker inherits the environment, so it writes the
// profile to exactly the same ~/.muse-agent folder.

const { parentPort, workerData } = require('worker_threads');

function run() {
  try {
    const voice = require('../harness/voice');
    const result = voice.calibrate((workerData && workerData.options) || {});
    parentPort.postMessage({ ok: true, result });
  } catch (error) {
    parentPort.postMessage({ ok: false, error: String((error && error.message) || error) });
  }
}

run();
