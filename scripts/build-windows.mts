import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Windows gives executables the integrity label inherited from their output
// directory. REA can be Low-labelled; its EXEs then cannot create normal TEMP
// files. Build user-facing releases in a normal per-user directory instead.
export function releaseDirectory(env: NodeJS.ProcessEnv, version: string) {
  if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw Error('LOCALAPPDATA must identify an absolute Windows user directory');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw Error('Invalid Windows release version');
  return path.join(env.LOCALAPPDATA, 'MuseAgent', 'releases', version);
}

export function toolOptions(options: Record<string, any> = {}, env = process.env) {
  // The NSIS uninstaller generator supplies __COMPAT_LAYER as a partial env.
  // Preserve TEMP/SystemRoot/PATH as a normal child process would inherit.
  return options.env ? { ...options, env: { ...env, ...options.env } } : options;
}

export function main(args: string[]) {
  if (process.platform !== 'win32') throw Error('Run Windows release packaging on Windows');
  const require = createRequire(import.meta.url);
  const root = path.resolve(import.meta.dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const output = releaseDirectory(process.env, pkg.version);
  fs.mkdirSync(output, { recursive: true });
  const { WineVmManager } = require('app-builder-lib/out/vm/WineVm');
  const original = WineVmManager.prototype.execWine;
  WineVmManager.prototype.execWine = function(request: any) {
    return original.call(this, { ...request, options: toolOptions(request.options) });
  };
  console.log(`Windows release output: ${output}`);
  const electronDist = path.dirname(require('electron'));
  process.chdir(root);
  process.argv = [process.execPath, require.resolve('electron-builder/cli.js'), ...args, `--config.directories.output=${output}`, `--config.electronDist=${electronDist}`];
  require('electron-builder/cli.js');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
