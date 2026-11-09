import path from 'node:path';
import { build } from 'bun';

const root = path.resolve(import.meta.dirname, '..');
const result = await build({
  entrypoints: ['dot-orbit.ts', 'subagent-cards.ts', 'settings-panel.ts', 'activity-cards.ts', 'model-picker.ts'].map(file => path.join(root, 'scripts/renderer', file)),
  outdir: path.join(root, 'app/renderer/lib'),
  naming: '[name].js', target: 'browser', format: 'iife', minify: true,
  banner: '/* Paper Shaders 0.0.82 | Apache-2.0 | Copyright Lost Coast Labs, Inc. | See node_modules/@paper-design/shaders/LICENSE and NOTICE. */',
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exitCode = 1;
} else console.log('Built local renderer bundles.');
