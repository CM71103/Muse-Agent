'use strict';
// preload.js - contextBridge surface. Renderer gets: send to agent, respond approvals,
// read config summary, switch permission mode.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('muse', {
  learningStatus:()=>ipcRenderer.invoke('learning:status'),
  learningSave:patch=>ipcRenderer.invoke('learning:save',patch),
  learningRun:kind=>ipcRenderer.invoke('learning:run',kind),
  learningPause:()=>ipcRenderer.invoke('learning:pause'),
  learningStop:()=>ipcRenderer.invoke('learning:stop'),
  learningResume:()=>ipcRenderer.invoke('learning:resume'),
  learningDeleteLesson:id=>ipcRenderer.invoke('learning:delete',id),
  learningActivity:()=>ipcRenderer.send('learning:activity'),
  onLearningStatus:cb=>{const listener=(_e,status)=>cb(status);ipcRenderer.on('learning-status',listener);return ()=>ipcRenderer.removeListener('learning-status',listener);},
  sandboxStatus:()=>ipcRenderer.invoke('sandbox:status'),
  sandboxChooseISO:()=>ipcRenderer.invoke('sandbox:choose-iso'),
  sandboxCreate:()=>ipcRenderer.invoke('sandbox:create'),
  sandboxStart:()=>ipcRenderer.invoke('sandbox:start'),
  sandboxStop:()=>ipcRenderer.invoke('sandbox:stop'),
  sandboxReset:()=>ipcRenderer.invoke('sandbox:reset'),
  sandboxCheckpoint:()=>ipcRenderer.invoke('sandbox:checkpoint'),
  sandboxUseHost:()=>ipcRenderer.invoke('sandbox:host'),
  sandboxFrame:()=>ipcRenderer.invoke('sandbox:frame'),
  sandboxInput:args=>ipcRenderer.invoke('sandbox:input',args),
  windowsList:()=>ipcRenderer.invoke('windows:list'),
  windowsStatus:()=>ipcRenderer.invoke('windows:status'),
  windowsSelect:id=>ipcRenderer.invoke('windows:select',id),
  windowsRelease:()=>ipcRenderer.invoke('windows:release'),
  visualOpen:p=>ipcRenderer.invoke('visual:open',p),
  visualReveal:p=>ipcRenderer.invoke('visual:reveal',p),
  visPages:()=>ipcRenderer.invoke('visual:pages'),
  visPageThumb:id=>ipcRenderer.invoke('visual:page-thumb',id),
  visPageForget:id=>ipcRenderer.invoke('visual:page-forget',id),
  boxStatus:()=>ipcRenderer.invoke('box:status'),
  boxConnect:()=>ipcRenderer.invoke('box:connect'),
  boxDisconnect:()=>ipcRenderer.invoke('box:disconnect'),
  boxCancel:()=>ipcRenderer.invoke('box:cancel'),
  boxOpenDesktop:()=>ipcRenderer.invoke('box:desktop'),
  onBoxStatus:cb=>{const handler=(_event,status)=>cb(status);ipcRenderer.on('box-status',handler);return ()=>ipcRenderer.removeListener('box-status',handler);},
  send: (text, commandId) => ipcRenderer.invoke('agent:send', text, commandId),
  queueCancel: (commandId) => ipcRenderer.invoke('queue:cancel', commandId),
  queueMove: (commandId, dir) => ipcRenderer.invoke('queue:move', commandId, dir),
  queueSteer: (commandId) => ipcRenderer.invoke('queue:steer', commandId),
  checkpointUndo: (runId) => ipcRenderer.invoke('checkpoint:undo', runId),
  datasourcesList: () => ipcRenderer.invoke('datasources:list'),
  datasourcesSave: (rec) => ipcRenderer.invoke('datasources:save', rec),
  datasourcesRemove: (id) => ipcRenderer.invoke('datasources:remove', id),
  datasourcesTest: (id) => ipcRenderer.invoke('datasources:test', id),
  datasourcesAddSqlite: () => ipcRenderer.invoke('datasources:add-sqlite'),
  dashList: () => ipcRenderer.invoke('dashboards:list'),
  dashGet: (id) => ipcRenderer.invoke('dashboards:get', id),
  dashData: (id) => ipcRenderer.invoke('dashboards:data', id),
  dashDelete: (id) => ipcRenderer.invoke('dashboards:delete', id),
  researchStatus: () => ipcRenderer.invoke('research:status'),
  antislopSkills: () => ipcRenderer.invoke('antislop:skills'),
  antislopApply: (groups) => ipcRenderer.invoke('antislop:apply', groups),
  researchSave: (patch) => ipcRenderer.invoke('research:save', patch),
  researchBrief: (payload) => ipcRenderer.invoke('research:brief', payload),
  memoryReindex: () => ipcRenderer.invoke('memory:reindex'),
  onResearchStage: (cb) => { const h = (_event, payload) => cb(payload); ipcRenderer.on('research-stage', h); return () => ipcRenderer.removeListener('research-stage', h); },
  revealPath: (target) => ipcRenderer.invoke('path:reveal', target),
  attachPick: () => ipcRenderer.invoke('attachments:pick'),
  attachAdd: (paths) => ipcRenderer.invoke('attachments:add', paths),
  attachList: () => ipcRenderer.invoke('attachments:list'),
  attachRemove: (id) => ipcRenderer.invoke('attachments:remove', id),
  attachClear: () => ipcRenderer.invoke('attachments:clear'),
  attachStage: (commandId, ids) => ipcRenderer.invoke('attachments:stage', commandId, ids),
  // Resolve a dropped/pasted File to its path on disk (Electron's webUtils
  // is the supported way — File.path was removed in Electron 32).
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  attachCapabilities: () => ipcRenderer.invoke('attachments:capabilities'),
  attachModelCaps: (models) => ipcRenderer.invoke('attachments:modelCaps', models),
  feedbackGrade: (rating) => ipcRenderer.invoke('feedback:grade', rating),
  feedbackSummary: () => ipcRenderer.invoke('feedback:summary'),
  feedbackReset: () => ipcRenderer.invoke('feedback:reset'),
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  voiceCalibrate: () => ipcRenderer.invoke('voice:calibrate'),
  voiceReset: () => ipcRenderer.invoke('voice:reset'),
  reset: () => ipcRenderer.invoke('agent:reset'),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  setProjectScope: (dir) => ipcRenderer.invoke('project:set', dir),
  getProjectScope: () => ipcRenderer.invoke('project:get'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  updateProject: (id,patch) => ipcRenderer.invoke('projects:update',id,patch),
  createProject: name => ipcRenderer.invoke('projects:create',name),
  selectProject: id => ipcRenderer.invoke('projects:select',id),
  browseProject: () => ipcRenderer.invoke('project:browse'),
  answerQuestion: (id, answer, cancelled) => ipcRenderer.invoke('question:respond', { id, answer, cancelled: !!cancelled }),
  respondApproval: (id, approved) => ipcRenderer.invoke('approval:respond', { id, approved }),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setMode: (mode) => ipcRenderer.invoke('sentinel:setMode', mode),
  selectModel: (model) => ipcRenderer.invoke('model:select', model),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  fetchModels: (opts) => ipcRenderer.invoke('settings:fetchModels', opts),
  mcpList: () => ipcRenderer.invoke('mcp:list'),
  mcpSave: (srv) => ipcRenderer.invoke('mcp:save', srv),
  mcpRemove: (name) => ipcRenderer.invoke('mcp:remove', { name }),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  memoryScope: (scope) => ipcRenderer.invoke('memory:scope',scope),
  memoryStatus: () => ipcRenderer.invoke('memory:status'),
  memoryList: () => ipcRenderer.invoke('memory:list'),
  memoryDelete: (id) => ipcRenderer.invoke('memory:delete', id),
  memoryQuarantineReview: (value) => ipcRenderer.invoke('memory:quarantine-review', value),
  memoryFlags: (patch) => ipcRenderer.invoke('memory:flags', patch),
  memoryDeleted: () => ipcRenderer.invoke('memory:deleted'),
  memoryExport: () => ipcRenderer.invoke('memory:export'),
  memoryExtractNow: () => ipcRenderer.invoke('memory:extract-now'),
  designStatus: () => ipcRenderer.invoke('design:status'),
  designListFiles: () => ipcRenderer.invoke('design:files:list'),
  designReadFile: (relativePath) => ipcRenderer.invoke('design:files:read', relativePath),
  designRegistryList: (kind) => ipcRenderer.invoke('design:registry:list', kind),
  designRegistryRead: (kind, id, file) => ipcRenderer.invoke('design:registry:read', { kind, id, file }),
  designApplyTemplate: (id, force) => ipcRenderer.invoke('design:template:apply', { id, force }),
  designUserRegistryDir: () => ipcRenderer.invoke('design:registry:user-dir'),
  onDesignArtifact: (cb) => {
    const h = (_e, payload) => cb(payload || {});
    ipcRenderer.on('design-artifact', h);
    return () => ipcRenderer.removeListener('design-artifact', h);
  },
  onProjectChange: (cb) => {
    const h = () => cb();
    ipcRenderer.on('project-changed', h);
    return () => ipcRenderer.removeListener('project-changed', h);
  },
  designWorkspaceMode: open => ipcRenderer.invoke('design:workspace-mode', !!open),
  designSave: (patch) => ipcRenderer.invoke('design:save', patch),
  designCreateProject: (name, dir) => ipcRenderer.invoke('design:create-project', { name, dir }),
  designChooseProject: () => ipcRenderer.invoke('design:choose-project'),
  designOpenPreview: () => ipcRenderer.invoke('design:open-preview'),
  designWebPreviewStart: (relativeDir) => ipcRenderer.invoke('design:web-preview:start', relativeDir),
  designWebPreviewStop: () => ipcRenderer.invoke('design:web-preview:stop'),
  designSiteOpenUrl: (url) => ipcRenderer.invoke('design:site:open-url', url),
  designSiteChooseFolder: () => ipcRenderer.invoke('design:site:choose-folder'),
  designSiteChooseHtml: () => ipcRenderer.invoke('design:site:choose-html'),
  designSiteBounds: (rect) => ipcRenderer.invoke('design:site:bounds', rect),
  designCapture: (rect) => ipcRenderer.invoke('design:capture', rect),
  getAppearance: () => ipcRenderer.invoke('appearance:get'),
  getWho: () => ipcRenderer.invoke('app:who'),
  windowReload: () => ipcRenderer.invoke('window:reload'),
  windowDevTools: () => ipcRenderer.invoke('window:devtools'),
  windowZoom: (dir) => ipcRenderer.invoke('window:zoom', dir),
  setAppearance: (theme) => ipcRenderer.invoke('appearance:set', theme),
  designSiteClose: () => ipcRenderer.invoke('design:site:close'),
  designSitePackage: (request) => ipcRenderer.invoke('design:site:package', request),
  onAgentEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('agent-event', h);
    return () => ipcRenderer.removeListener('agent-event', h);
  },
  onQueueUpdate: (cb) => {
    const h = (_e, state) => cb(state);
    ipcRenderer.on('queue-update', h);
    return () => ipcRenderer.removeListener('queue-update', h);
  },
  onApprovalRequest: (cb) => {
    const h = (_e, req) => cb(req);
    ipcRenderer.on('approval-request', h);
    return () => ipcRenderer.removeListener('approval-request', h);
  },
  onApprovalResolved: (cb) => {
    const h = (_e, result) => cb(result);
    ipcRenderer.on('approval-resolved', h);
    return () => ipcRenderer.removeListener('approval-resolved', h);
  },
  onQuestion: (cb) => {
    const h = (_e, q) => cb(q);
    ipcRenderer.on('agent-question', h);
    return () => ipcRenderer.removeListener('agent-question', h);
  },
  onApprovalExpired: (cb) => {
    const h = () => cb();
    ipcRenderer.on('approval-expired', h);
    return () => ipcRenderer.removeListener('approval-expired', h);
  },
  onSessionReset: (cb) => {
    const h = () => cb();
    ipcRenderer.on('session-reset', h);
    return () => ipcRenderer.removeListener('session-reset', h);
  },
});
