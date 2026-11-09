import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { releaseDirectory, toolOptions } from '../build-windows.mts';

test('user-facing releases go outside a Low-labelled workspace', () => {
  const userData = path.join(os.tmpdir(), 'fixture-user-data');
  const output = releaseDirectory({ LOCALAPPDATA: userData }, '0.1.7');
  assert.equal(output, path.join(userData,'MuseAgent','releases','0.1.7'));
  assert.throws(()=>releaseDirectory({},'0.1.7'),/LOCALAPPDATA/);
  assert.throws(()=>releaseDirectory({LOCALAPPDATA:userData},'../project'),/version/);
});

test('installer helper inherits temp/system variables and retains explicit overrides', () => {
  const env = {TEMP:'fixture-temp',TMP:'fixture-temp',SystemRoot:'fixture-system',PATH:'fixture-path'};
  const options = {timeout:120000,env:{__COMPAT_LAYER:'RunAsInvoker',TEMP:'override-temp'}};
  const result = toolOptions(options,env);
  assert.equal(result.env.TEMP,'override-temp');assert.equal(result.env.TMP,'fixture-temp');
  assert.equal(result.env.SystemRoot,'fixture-system');assert.equal(result.env.PATH,'fixture-path');
  assert.equal(result.env.__COMPAT_LAYER,'RunAsInvoker');assert.equal(result.timeout,120000);
  assert.deepEqual(options.env,{__COMPAT_LAYER:'RunAsInvoker',TEMP:'override-temp'});
});
