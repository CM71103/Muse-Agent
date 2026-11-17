const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomInt } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Context = { signal?: AbortSignal; checkpoint: () => any; chat: (messages: any[], tokens: number) => Promise<any> };
type Options = { directory?: string; executable?: string; run?: (args: string[], signal?: AbortSignal) => Promise<string> };
const value = (text: string, key: string) => new RegExp(`^${key}="([^"]*)"`, 'm').exec(text)?.[1] || '';

function createPractice(options: Options = {}) {
  const directory = path.resolve(options.directory || path.join(require('../harness/config.js').configDir(), 'sandbox'));
  const practiceDirectory = path.join(directory, 'practice');
  const executable = options.executable || path.join(process.env.ProgramFiles || '', 'Oracle', 'VirtualBox', 'VBoxManage.exe');
  const execute = promisify(execFile);
  const run = options.run || (async (args: string[], signal?: AbortSignal) => {
    const result = await execute(executable, args, { signal, windowsHide: true, timeout: 90000, maxBuffer: 256 * 1024 });
    return String(result.stdout);
  });
  let busy = false;
  async function check(ctx: Context) { ctx.signal?.throwIfAborted(); await ctx.checkpoint(); ctx.signal?.throwIfAborted(); }
  function configuration() {
    let config: any;
    try { config = JSON.parse(fs.readFileSync(path.join(directory, 'sandbox.json'), 'utf8')); }
    catch { throw Error('Set up the Ubuntu sandbox and save a clean checkpoint before enabling practice.'); }
    if (!config.ready || ![config.id, config.owner, config.checkpoint].every(item => UUID.test(item || ''))) throw Error('Save a clean checkpoint in the configured Ubuntu sandbox first.');
    return config;
  }
  async function source(config: any, signal?: AbortSignal) {
    const owner = String(await run(['getextradata', config.id, 'MuseSandboxOwner'], signal)).trim();
    if (owner !== `Value: ${config.owner}`) throw Error('Ubuntu sandbox ownership could not be verified.');
    const snapshots = String(await run(['snapshot', config.id, 'list', '--machinereadable'], signal));
    if (!snapshots.split(/\r?\n/).some(line => /^SnapshotUUID(?:-\d+)*=/.test(line) && line.split('=')[1] === `"${config.checkpoint}"`)) throw Error('The saved Ubuntu clean checkpoint no longer exists.');
    const info = String(await run(['showvminfo', config.id, '--machinereadable'], signal));
    if (!['saved', 'poweroff'].includes(value(info, 'VMState'))) throw Error('Save or stop the Ubuntu sandbox before starting background practice.');
  }
  async function ready() {
    try {
      if (!options.run && !fs.existsSync(executable)) throw Error('Install Oracle VirtualBox to enable isolated Ubuntu practice.');
      await source(configuration());
      return { ready: true, detail: 'A clean checkpoint is available. Guest execution is checked in a disposable offline clone before any model request.' };
    } catch (error: any) { return { ready: false, detail: String(error.message || error) }; }
  }
  function journal(id: string) { return path.join(practiceDirectory, `${id}.json`); }
  async function owned(record: any) {
    if (!UUID.test(record.id || '') || !UUID.test(record.owner || '') || record.id === configuration().id) throw Error('Refusing cleanup of an unverified practice VM.');
    const owner = String(await run(['getextradata', record.id, 'MusePracticeOwner'])).trim();
    if (owner !== `Value: ${record.owner}`) throw Error('Practice VM ownership changed; automatic cleanup was stopped.');
    const info = String(await run(['showvminfo', record.id, '--machinereadable']));
    const cfg = value(info, 'CfgFile');
    const expected = path.resolve(practiceDirectory, `MusePractice-${record.id}`);
    const canonical = (file: string) => fs.existsSync(file) ? fs.realpathSync.native(file) : path.resolve(file);
    // Both configuration path and real directory must stay within this exact clone subtree.
    if (!cfg || path.dirname(path.resolve(cfg)).toLowerCase() !== expected.toLowerCase()
      || path.dirname(canonical(cfg)).toLowerCase() !== canonical(expected).toLowerCase()
      || path.dirname(canonical(expected)).toLowerCase() !== canonical(practiceDirectory).toLowerCase()) throw Error('Practice VM configuration is outside its owned directory; cleanup was stopped.');
    return info;
  }
  async function cleanup(record: any) {
    const info = await owned(record), state = value(info, 'VMState');
    if (['running', 'paused'].includes(state)) await run(['controlvm', record.id, 'poweroff']);
    else if (state === 'saved') await run(['discardstate', record.id]);
    // Check again immediately before the irreversible unregister operation.
    await owned(record);
    await run(['unregistervm', record.id, '--delete']);
    fs.rmSync(journal(record.id), { force: true });
  }
  async function recover() {
    if (!fs.existsSync(practiceDirectory)) return;
    for (const file of fs.readdirSync(practiceDirectory)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
      let record: any;
      try { record = JSON.parse(fs.readFileSync(path.join(practiceDirectory, file), 'utf8')); } catch { throw Error('A practice cleanup record is invalid; inspect the practice directory before retrying.'); }
      if (`${record.id}.json` !== file || record.owner !== configuration().owner) throw Error('A practice cleanup record has unexpected ownership.');
      await cleanup(record);
    }
  }
  async function isolate(id: string, signal?: AbortSignal) {
    const info = String(await run(['showvminfo', id, '--machinereadable'], signal));
    // VirtualBox permits disconnecting saved VM NIC cables. Preserve the clean live
    // desktop's memory only when every other integration was already disabled.
    const safeSaved = value(info, 'VMState') === 'saved' && value(info, 'clipboard') === 'disabled'
      && value(info, 'clipboard_file_transfers') === 'off' && value(info, 'draganddrop') === 'disabled'
      && value(info, 'vrde') === 'off' && !/^SharedFolderName|^USBFilter/m.test(info)
      && !/^(?:uart|parport)\d+="(?!off"|none")/m.test(info);
    if (safeSaved) {
      const cables = ['modifyvm', id];
      for (let i = 1; i <= 8; i++) cables.push(`--cable-connected${i}`, 'off');
      await run(cables, signal);
      const isolated = String(await run(['showvminfo', id, '--machinereadable'], signal));
      for (let i = 1; i <= 8; i++) {
        const nic = value(isolated, `nic${i}`);
        if (nic && nic !== 'none' && value(isolated, `cableconnected${i}`) !== 'off') throw Error('Practice networking could not be disconnected.');
      }
      return;
    }
    if (value(info, 'VMState') === 'saved') await run(['discardstate', id], signal);
    const folders = [...info.matchAll(/^SharedFolderNameMachineMapping\d+="([^"]*)"/gm)].map(match => match[1]);
    for (const folder of folders) await run(['sharedfolder', 'remove', id, '--name', folder], signal);
    const settings = ['modifyvm', id, '--clipboard-mode', 'disabled', '--clipboard-file-transfers', 'disabled', '--drag-and-drop', 'disabled', '--vrde', 'off', '--usb-ohci', 'off', '--usb-ehci', 'off', '--usb-xhci', 'off'];
    for (let i = 1; i <= 8; i++) settings.push(`--nic${i}`, 'none');
    for (let i = 1; i <= 4; i++) settings.push(`--uart${i}`, 'off');
    await run(settings, signal);
  }
  async function guest(id: string, program: string, input: string, signal?: AbortSignal) {
    try {
      const result = await run(['guestcontrol', id, 'run', '--exe', '/usr/bin/awk', '--username', 'xubuntu', '--password', '', '--timeout', '12000', '--wait-stdout', '--wait-stderr', '--', 'awk', '-v', `input=${input}`, program, '/dev/null'], signal);
      if (result.length > 4096) throw Error('Guest output exceeded the practice limit.');
      return result.replace(/\r\n/g, '\n').trim();
    } catch (error: any) {
      signal?.throwIfAborted();
      throw Error('Ubuntu practice guest execution failed. Install and start VirtualBox Guest Additions and enable guestcontrol for the live xubuntu account before saving a new clean checkpoint. ' + String(error.stderr || error.message || error).slice(0, 240));
    }
  }
  function parseProgram(response: any) {
    if (response?.finish_reason === 'length' || response?.message?.tool_calls?.length) throw Error('Practice solution was incomplete or requested tools.');
    const text = response?.message?.content;
    if (typeof text !== 'string' || text.length > 6000) throw Error('Invalid practice solution.');
    let parsed: any;
    try { parsed = JSON.parse(text); } catch { throw Error('Practice solution must be strict JSON.'); }
    if (!parsed || Object.keys(parsed).length !== 1 || typeof parsed.program !== 'string' || !parsed.program.trim() || parsed.program.length > 4000 || /[^\x09\x0a\x0d\x20-\x7e]/.test(parsed.program)) throw Error('Invalid bounded AWK practice solution.');
    return parsed.program;
  }
  async function solve(ctx: Context) {
    if (busy) throw Error('An isolated practice job is already running.');
    busy = true;
    let record: any = null, tagged = false, result: any, failure: any;
    try {
      await check(ctx); const config = configuration(); await source(config, ctx.signal); await check(ctx);
      await recover(); await check(ctx);
      record = { id: randomUUID(), owner: config.owner };
      fs.mkdirSync(practiceDirectory, { recursive: true });
      fs.writeFileSync(journal(record.id), JSON.stringify(record), { flag: 'wx' });
      await run(['clonevm', config.id, '--snapshot', config.checkpoint, '--options', 'link', '--name', `MusePractice-${record.id}`, '--uuid', record.id, '--basefolder', practiceDirectory, '--register'], ctx.signal);
      // Tag without the caller's cancelled signal so a completed clone can still be reclaimed.
      await run(['setextradata', record.id, 'MusePracticeOwner', record.owner]); tagged = true;
      await owned(record); await check(ctx); await isolate(record.id, ctx.signal); await check(ctx);
      await run(['startvm', record.id, '--type', 'headless'], ctx.signal); await check(ctx);
      // Readiness is actual guest execution, never a model verdict or a host fallback.
      let guestReady = false, guestError: any;
      const deadline = Date.now() + 300000;
      let bootstrap = false;
      while (!guestReady && Date.now() < deadline) {
        await check(ctx);
        try { guestReady = await guest(record.id, 'BEGIN { print "MUSE_PRACTICE_READY" }', '', ctx.signal) === 'MUSE_PRACTICE_READY'; }
        catch (error) { guestError = error; }
        if (!guestReady && !bootstrap) {
          bootstrap = true; await check(ctx);
          // Fixed service startup inside this clone only; never routed through host input.
          await run(['controlvm', record.id, 'keyboardputscancode', '1d', '38', '14', '94', 'b8', '9d'], ctx.signal);
          await new Promise(resolve => setTimeout(resolve, 1000)); await check(ctx);
          await run(['controlvm', record.id, 'keyboardputstring', 'sudo /usr/sbin/VBoxService --daemonize'], ctx.signal);
          await run(['controlvm', record.id, 'keyboardputscancode', '1c', '9c'], ctx.signal);
        }
        if (!guestReady) await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!guestReady) throw guestError || Error('Ubuntu guest execution did not return the readiness marker.');
      // Do not spend the user's model budget unless the offline guest proved it
      // can execute commands and return results first.
      const response = await ctx.chat([
        { role: 'system', content: 'Solve a bounded AWK exercise. Return only strict JSON {"program":"AWK source"}. No tools. Your program runs against /dev/null; input is a space-separated integer string in the AWK variable input. Use a BEGIN block. Output one integer and newline: the sum of squares of even input integers. Empty input produces 0. Integers lie between -100 and 100. Do not use system(), external commands, files, networking, or getline. Example input "-2 3 4" produces 20. Your solution will be checked against independent unseen tests.' },
        { role: 'user', content: 'Write the portable POSIX AWK program.' },
      ], 1400);
      await check(ctx); const program = parseProgram(response);
      const inputs = ['', '0', '1 3 5', '-2 3 4', '-8 -6 -4 -2', '2 2 2 2', '100 -100 99 -99'];
      for (let index = 0; index < 5; index++) inputs.push(Array.from({ length: 18 }, () => randomInt(-100, 101)).join(' '));
      for (const input of inputs) {
        await check(ctx);
        const expected = String(input.split(/\s+/).filter(Boolean).map(Number).filter(n => n % 2 === 0).reduce((sum, n) => sum + n * n, 0));
        const actual = await guest(record.id, program, input, ctx.signal); await check(ctx);
        if (actual !== expected) throw Error('Practice solution failed an independent Ubuntu test; no verified lesson was recorded.');
      }
      result = { verified: true, summary: 'Completed an AWK exercise in a separate disposable Ubuntu clone.', lessons: [{ kind: 'practice', verification: 'verified', text: 'An AWK implementation of the sum of squares of even integers passed the tested empty, negative, duplicate, boundary and randomized inputs. This evidence covers the tested cases only.', evidence: 'Independent host arithmetic agreed with exact guest stdout for 12 cases, including five freshly randomized inputs; guest execution used an offline disposable Ubuntu clone.' }] };
    } catch (error) { failure = error; }
    finally {
      try { if (record && tagged) await cleanup(record); }
      catch (error: any) { failure = Error(`Practice cleanup failed; the owned clone was retained for a safe retry. ${String(error.message || error)}`); }
      busy = false;
    }
    if (failure) throw failure;
    return result;
  }
  return { ready, solve };
}
module.exports = { createPractice };
