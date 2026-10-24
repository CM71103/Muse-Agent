'use strict';
// preload.js - contextBridge surface. Renderer gets: send to agent, respond approvals,
// read config summary, toggle hands.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('muse', {
  send: (text) => ipcRenderer.invoke('agent:send', text),
  reset: () => ipcRenderer.invoke('agent:reset'),
  cancel: () => ipcRenderer.invoke('agent:cancel'),
  setProjectScope: (dir) => ipcRenderer.invoke('project:set', dir),
  getProjectScope: () => ipcRenderer.invoke('project:get'),
  answerQuestion: (id, answer, cancelled) => ipcRenderer.invoke('question:respond', { id, answer, cancelled: !!cancelled }),
  respondApproval: (id, approved) => ipcRenderer.invoke('approval:respond', { id, approved }),
  getConfig: () => ipcRenderer.invoke('config:get'),
  toggleHands: (enabled) => ipcRenderer.invoke('config:toggleHands', enabled),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:save', patch),
  fetchModels: (opts) => ipcRenderer.invoke('settings:fetchModels', opts),
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
  onAgentEvent: (cb) => {
    const h = (_e, ev) => cb(ev);
    ipcRenderer.on('agent-event', h);
    return () => ipcRenderer.removeListener('agent-event', h);
  },
  onApprovalRequest: (cb) => {
    const h = (_e, req) => cb(req);
    ipcRenderer.on('approval-request', h);
    return () => ipcRenderer.removeListener('approval-request', h);
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
