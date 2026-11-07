const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the renderer can reach. Every call is a named IPC channel —
 * no generic `invoke` passthrough, so the renderer can never call arbitrary
 * main-process functionality.
 */
contextBridge.exposeInMainWorld('clipwright', {
  // ---- Workspace ----
  ensureWorkspace: () => ipcRenderer.invoke('workspace:ensure'),
  listProjects: () => ipcRenderer.invoke('workspace:listProjects'),
  createProject: (settings) => ipcRenderer.invoke('workspace:createProject', settings),
  getProject: (projectId) => ipcRenderer.invoke('workspace:getProject', projectId),
  updateProject: (projectId, patch) => ipcRenderer.invoke('workspace:updateProject', projectId, patch),
  duplicateProject: (projectId) => ipcRenderer.invoke('workspace:duplicateProject', projectId),
  deleteProject: (projectId, opts) => ipcRenderer.invoke('workspace:deleteProject', projectId, opts),

  // ---- Compositions ----
  getCompositions: (projectId) => ipcRenderer.invoke('workspace:getCompositions', projectId),
  getComposition: (projectId, compId) => ipcRenderer.invoke('workspace:getComposition', projectId, compId),
  saveComposition: (projectId, comp) => ipcRenderer.invoke('workspace:saveComposition', projectId, comp),

  // ---- Journal, checkpoints, recovery ----
  appendJournal: (projectId, entry) => ipcRenderer.invoke('workspace:appendJournal', projectId, entry),
  checkpoint: (projectId, compositions, upToSeq) =>
    ipcRenderer.invoke('workspace:checkpoint', projectId, compositions, upToSeq),
  checkRecovery: (projectId) => ipcRenderer.invoke('workspace:checkRecovery', projectId),
  replayRecovery: (projectId) => ipcRenderer.invoke('workspace:replayRecovery', projectId),
  createRestorePoint: (projectId, label) => ipcRenderer.invoke('workspace:createRestorePoint', projectId, label),
  listRestorePoints: (projectId) => ipcRenderer.invoke('workspace:listRestorePoints', projectId),
  restoreFromPoint: (projectId, restorePointId) =>
    ipcRenderer.invoke('workspace:restoreFromPoint', projectId, restorePointId),

  // ---- Project locks ----
  acquireLock: (projectId) => ipcRenderer.invoke('workspace:acquireLock', projectId),
  releaseLock: (projectId) => ipcRenderer.invoke('workspace:releaseLock', projectId),

  // ---- Media, transcripts, moments, jobs ----
  saveMedia: (media) => ipcRenderer.invoke('workspace:saveMedia', media),
  listMedia: () => ipcRenderer.invoke('workspace:listMedia'),
  saveTranscript: (projectId, transcript) => ipcRenderer.invoke('workspace:saveTranscript', projectId, transcript),
  getTranscript: (projectId) => ipcRenderer.invoke('workspace:getTranscript', projectId),
  saveMoments: (projectId, moments) => ipcRenderer.invoke('workspace:saveMoments', projectId, moments),
  listMoments: (projectId) => ipcRenderer.invoke('workspace:listMoments', projectId),
  saveJob: (job) => ipcRenderer.invoke('workspace:saveJob', job),
  listJobs: () => ipcRenderer.invoke('workspace:listJobs'),

  // ---- Packages ----
  exportPackage: (projectId, destPath, opts) =>
    ipcRenderer.invoke('workspace:exportPackage', projectId, destPath, opts),
  importPackage: (packPath, opts) => ipcRenderer.invoke('workspace:importPackage', packPath, opts),
  relocateWorkspace: (targetDir, opts) => ipcRenderer.invoke('workspace:relocate', targetDir, opts),

  // ---- Settings ----
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),

  // ---- Secrets (main process only; never in the workspace) ----
  setSecret: (plainText, existingSecretId) => ipcRenderer.invoke('secret:set', plainText, existingSecretId),
  getSecret: (secretId) => ipcRenderer.invoke('secret:get', secretId),
  deleteSecret: (secretId) => ipcRenderer.invoke('secret:delete', secretId),

  // ---- Logging ----
  log: (level, message, meta) => ipcRenderer.invoke('log:write', level, message, meta),
  recentLogs: (limit) => ipcRenderer.invoke('log:recent', limit),

  // ---- Dialogs ----
  openVideoDialog: () => ipcRenderer.invoke('dialog:openVideo'),
  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  saveFileDialog: (defaultName, filters) => ipcRenderer.invoke('dialog:saveFile', defaultName, filters),

  // ---- Media operations ----
  probeMedia: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  probeUrl: (url) => ipcRenderer.invoke('media:probeUrl', url),
  isSupportedFile: (filePath) => ipcRenderer.invoke('media:isSupported', filePath),

  // ---- Transcript export ----
  exportTranscript: (transcript, format, aspect, defaultName) =>
    ipcRenderer.invoke('transcript:export', transcript, format, aspect, defaultName),

  // ---- Long-running jobs ----
  startIngest: (jobId, request) => ipcRenderer.invoke('job:startIngest', jobId, request),
  startTranscribe: (jobId, request) => ipcRenderer.invoke('job:startTranscribe', jobId, request),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),
  onJobProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },

  // ---- Transcription models ----
  listModels: () => ipcRenderer.invoke('models:list'),
  installModel: (modelName) => ipcRenderer.invoke('models:install', modelName),
  deleteModel: (modelName) => ipcRenderer.invoke('models:delete', modelName),
  onModelProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('models:progress', listener);
    return () => ipcRenderer.removeListener('models:progress', listener);
  },

  // ---- AI providers (SPEC 06) ----
  aiListProviders: () => ipcRenderer.invoke('ai:providers:list'),
  aiSaveProvider: (input) => ipcRenderer.invoke('ai:providers:save', input),
  aiRemoveProvider: (providerId) => ipcRenderer.invoke('ai:providers:remove', providerId),
  aiTestProvider: (providerId) => ipcRenderer.invoke('ai:providers:test', providerId),
  aiListProviderModels: (providerId) => ipcRenderer.invoke('ai:providers:models', providerId),
  aiSetDefaultProvider: (task, providerId) => ipcRenderer.invoke('ai:providers:setDefault', task, providerId),
  aiRoute: (task) => ipcRenderer.invoke('ai:route', task),
  aiConnectivity: (force) => ipcRenderer.invoke('ai:connectivity', force),

  // ---- Consent and privacy (SPEC 06 §8) ----
  aiGrantConsent: (decision) => ipcRenderer.invoke('ai:consent:grant', decision),
  aiRevokeConsent: (providerId, category) => ipcRenderer.invoke('ai:consent:revoke', providerId, category),
  aiPrivacyOverview: () => ipcRenderer.invoke('ai:privacy:overview'),
  aiClearDataSentLog: () => ipcRenderer.invoke('ai:privacy:clearLog'),
  aiExportDataSentLog: () => ipcRenderer.invoke('ai:privacy:exportCsv'),

  // ---- Local models (SPEC 06 §7) ----
  aiModelSnapshot: () => ipcRenderer.invoke('ai:models:snapshot'),
  aiDownloadModel: (modelId) => ipcRenderer.invoke('ai:models:download', modelId),
  aiCancelModelDownload: (modelId) => ipcRenderer.invoke('ai:models:cancel', modelId),
  aiDeleteModel: (modelId) => ipcRenderer.invoke('ai:models:delete', modelId),
  aiVerifyModel: (modelId) => ipcRenderer.invoke('ai:models:verify', modelId),
  aiSetDefaultModel: (modelId) => ipcRenderer.invoke('ai:models:setDefault', modelId),
  aiOpenModelsFolder: () => ipcRenderer.invoke('ai:models:openFolder'),
  aiRecordModelSpeed: (modelId, throughputFactor) => ipcRenderer.invoke('ai:models:recordSpeed', modelId, throughputFactor),
  onModelDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:modelProgress', listener);
    return () => ipcRenderer.removeListener('ai:modelProgress', listener);
  },

  // ---- Ollama (SPEC 06 §7.3) ----
  aiOllamaOverview: () => ipcRenderer.invoke('ai:ollama:overview'),
  aiPullOllamaModel: (modelName) => ipcRenderer.invoke('ai:ollama:pull', modelName),
  aiCancelOllamaPull: (modelName) => ipcRenderer.invoke('ai:ollama:cancel', modelName),
  aiDeleteOllamaModel: (modelName) => ipcRenderer.invoke('ai:ollama:delete', modelName),
  aiTestOllamaModel: (modelName) => ipcRenderer.invoke('ai:ollama:test', modelName),
  aiSetOllamaBaseUrl: (baseUrl) => ipcRenderer.invoke('ai:ollama:setBaseUrl', baseUrl),
  onOllamaPullProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:ollamaProgress', listener);
    return () => ipcRenderer.removeListener('ai:ollamaProgress', listener);
  },

  // ---- Moments (SPEC 07) ----
  listMoments: (projectId) => ipcRenderer.invoke('moments:list', projectId),
  analyzeMoments: (request) => ipcRenderer.invoke('moments:analyze', request),
  updateMoment: (projectId, patch) => ipcRenderer.invoke('moments:update', projectId, patch),
  addManualMoment: (projectId, range) => ipcRenderer.invoke('moments:addManual', projectId, range),
  rescoreMoment: (projectId, momentId) => ipcRenderer.invoke('moments:rescore', projectId, momentId),
  createClips: (projectId, momentIds, options) => ipcRenderer.invoke('moments:createClips', projectId, momentIds, options),
  onMomentsProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('ai:momentsProgress', listener);
    return () => ipcRenderer.removeListener('ai:momentsProgress', listener);
  },

  // ---- App info ----
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  openPath: (targetPath) => ipcRenderer.invoke('app:openPath', targetPath),
});
