'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const handsClient = require('../hands_client');

test('sidecar HTTP errors never spawn duplicate processes', async () => {
  const original = global.fetch;
  const before = handsClient.supervisor.proc;
  try {
    for (const status of [400, 401, 413, 500]) {
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return { status, ok: false, text: async () => 'body rejected' };
      };
      await assert.rejects(handsClient({}).request({ action: 'ocr' }),
        status === 401 ? /rejected token/ : new RegExp(`HTTP ${status}: body rejected`));
      assert.equal(calls, 1);
      assert.equal(handsClient.supervisor.proc, before);
    }
  } finally { global.fetch = original; }
});
