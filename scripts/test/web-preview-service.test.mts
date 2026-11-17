import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createWebPreviewService, mergePreviewStatus } = require('../../app/main/web-preview-service.js');

test('Flutter Web project is detected and starts its server directly for the canvas', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-flutter-preview-'));
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: sample_flutter_app\nflutter:\n  uses-material-design: true\n');
  fs.writeFileSync(path.join(root, 'web', 'index.html'), '<!doctype html>');
  let launched: any;
  const service = createWebPreviewService({
    freePort: async () => 43127,
    probe: async () => true,
    spawn: (executable: string, args: string[], options: any) => {
      launched = { executable, args, options };
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.exitCode = null;
      child.pid = 42;
      return child;
    },
  });
  try {
    const detected = service.inspect(root);
    assert.equal(detected.available, true);
    assert.equal(detected.apps[0].name, 'sample_flutter_app');
    assert.equal(detected.apps[0].script, 'Flutter Web');
    assert.match(detected.apps[0].command, /flutter run -d web-server/);
    const idle = mergePreviewStatus(detected, { running: false, status: 'stopped', script: null, packageManager: null, relativeDir: null, projectDir: null });
    assert.equal(idle.script, 'Flutter Web');
    assert.equal(idle.packageManager, 'flutter');

    const started = await service.start(root, '.');
    assert.equal(started.ok, true);
    assert.equal(started.url, 'http://127.0.0.1:43127/');
    assert.equal(launched.executable, process.platform === 'win32' ? 'flutter.bat' : 'flutter');
    assert.deepEqual(launched.args, ['run', '-d', 'web-server', '--web-hostname', '127.0.0.1', '--web-port', '43127']);
    assert.equal(launched.options.cwd, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Flutter projects without a web target are not offered as previewable apps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'muse-flutter-no-web-'));
  fs.writeFileSync(path.join(root, 'pubspec.yaml'), 'name: native_only\n');
  try {
    const detected = createWebPreviewService().inspect(root);
    assert.equal(detected.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
