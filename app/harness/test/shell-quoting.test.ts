const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { buildTools } = require('../tools.js');
const shell = buildTools({}, { disableSubagent: true }).map.get('shell');
const windows = process.platform === 'win32';
const run = (command: string) => shell.run({ command, timeout_s: 10 }, { cwd: process.cwd() });

test('quoted PowerShell script executes instead of being echoed as successful output', { skip: !windows }, async () => {
  const result = await run('powershell.exe -NoProfile -NonInteractive -Command "Write-Output \'quote boundary fixture\'"');
  assert.equal(result.ok, true);
  assert.equal(result.output.trim(), 'quote boundary fixture');
});

test('PowerShell pipelines and spaced strings survive the cmd boundary', { skip: !windows }, async () => {
  const result = await run('powershell.exe -NoProfile -NonInteractive -Command "\'first spaced value\',\'second spaced value\' | ForEach-Object { Write-Output ($_.ToUpper()) }"');
  assert.equal(result.ok, true);
  assert.equal(result.output.trim().replace(/\r\n/g, '\n'), 'FIRST SPACED VALUE\nSECOND SPACED VALUE');
});

test('quoted executable path retains its script and argument quotes', { skip: !windows }, async () => {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = await run(`"${executable}" -NoProfile -NonInteractive -Command "Write-Output 'quoted executable fixture'"`);
  assert.equal(result.ok, true);
  assert.equal(result.output.trim(), 'quoted executable fixture');
});

test('cmd shell pipelines and command chaining keep their native behavior', { skip: !windows }, async () => {
  const result = await run('echo command fixture|findstr /C:"command fixture" && echo chain fixture');
  assert.equal(result.ok, true);
  assert.equal(result.output.trim().replace(/\r\n/g, '\n'), 'command fixture\nchain fixture');
});

test('quoted PowerShell failures report stderr and a failed tool result', { skip: !windows }, async () => {
  const result = await run('powershell.exe -NoProfile -NonInteractive -Command "Write-Error \'fixture failure\'; exit 7"');
  assert.equal(result.ok, false);
  assert.match(result.output, /\[stderr\]/);
  assert.match(result.output, /fixture failure/);
});

test('quoted commands execute correctly in the actual Electron Node runtime', { skip: !windows, timeout: 40000 }, () => {
  const script = `
    const assert=require('node:assert/strict');
    const {buildTools}=require(${JSON.stringify(require.resolve('../tools.js'))});
    const tool=buildTools({},{disableSubagent:true}).map.get('shell');
    (async()=>{
      for(const [command,expected] of ${JSON.stringify([
        ['powershell.exe -NoProfile -NonInteractive -Command "Write-Output \'electron quoted fixture\'"', 'electron quoted fixture'],
        ['powershell.exe -NoProfile -NonInteractive -Command "1..3 | ForEach-Object { $_ * 2 }"', '2\n4\n6'],
        ['echo native cmd fixture|findstr /C:"native cmd fixture"', 'native cmd fixture'],
      ])}) {
        const result=await tool.run({command,timeout_s:10},{cwd:process.cwd()});
        assert.equal(result.ok,true);assert.equal(result.output.trim().replace(/\\r\\n/g,'\\n'),expected);
      }
    })().catch(error=>{console.error(error.message);process.exitCode=1});
  `;
  const result = spawnSync(require('electron'), ['-e', script], {
    cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true, encoding: 'utf8', timeout: 35000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('non-Windows shell still interprets normal shell quoting', { skip: windows }, async () => {
  const result = await run('printf "%s\\n" "space fixture" | cat');
  assert.equal(result.ok, true);
  assert.equal(result.output.trim(), 'space fixture');
});
