'use strict';
// preview-tools.ts - agent-facing managed preview.
//
// The point of these tools: "run it in preview" must NOT mean the model forks a
// dev server into the shell tool and leaves it running in a terminal card.
// Muse already manages the project website (main/web-preview-service.js) and
// the Design Studio canvas shows and refreshes it — these tools are the
// agent's door onto that lifecycle: one managed process, visible status, one
// Stop, and the canvas updates itself when files change.
//
// The Electron host installs the service (configurePreviewService from
// main/index.js, the windows-tools pattern); headless runs get no tools.

let service = null;

function configurePreviewService(svc) { service = svc; }

function mkPreviewTools() {
  // The schemas always register (like the design tools): the policy test pins
  // the central tool set, and the runtime service is what the Electron host
  // installs. Without a host the tools answer honestly instead of vanishing.
  const previewRun = {
    name: 'preview_run',
    description: 'Run the selected project website in Muse\'s managed preview (its dev, start, preview, or serve script; Flutter web works too) — or stop it. This replaces running dev servers through shell: nothing is left running in a terminal, the Design Studio canvas shows the preview and refreshes it within about a second of any file change, and action=stop ends it. Use this whenever the user asks to run, preview, serve, or show the project, app, or site. preview_status lists runnable apps; relative_dir picks one in a monorepo.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'stop'], description: 'start (default) or stop the preview' },
        relative_dir: { type: 'string', description: 'App folder relative to the project root ("." is the root); from preview_status' },
        open: { type: 'boolean', description: 'Also open the preview in the default browser when the Design Studio canvas is not open. Default true.' },
      },
      additionalProperties: false,
    },
    scope: 'project', sideEffect: true,
    async run(args) {
      if (!service) return { ok: false, error: 'preview tools need the Muse app host (unavailable in this runtime).' };
      const action = String(args?.action || 'start');
      if (action === 'stop') {
        const stopped = await service.stop();
        return { ok: true, ...stopped, note: 'Managed preview stopped. Nothing of it is left running.' };
      }
      return await service.start({ relativeDir: typeof args?.relative_dir === 'string' ? args.relative_dir : '', open: args?.open !== false });
    },
  };
  const previewStatus = {
    name: 'preview_status',
    description: 'Show the Muse managed preview: what is running and where (URL, script, recent logs, errors) and which runnable apps were detected in the project (their relative dirs for preview_run). Read-only.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    scope: 'project', sideEffect: false,
    async run() {
      if (!service) return { ok: false, error: 'preview tools need the Muse app host (unavailable in this runtime).' };
      return { ok: true, ...service.status() };
    },
  };
  return [previewRun, previewStatus];
}

const PREVIEW_TOOL_NAMES = ['preview_run', 'preview_status'];
const PREVIEW_READ_NAMES = ['preview_status'];
const PREVIEW_WRITE_NAMES = ['preview_run'];

module.exports = { configurePreviewService, mkPreviewTools, PREVIEW_TOOL_NAMES, PREVIEW_READ_NAMES, PREVIEW_WRITE_NAMES };