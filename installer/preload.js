// The only bridge between the setup / uninstall UI and the main process. Sandboxed preload: no Node, just IPC.
const { contextBridge, ipcRenderer } = require('electron');

/**
 * @typedef {{ kind: 'setup'|'legacy', scope: 'user'|'machine', version: string, dir: string }} Existing
 * @typedef {{ mode: 'setup'|'uninstall', product: string, version: string, elevated: boolean, existing: Existing|null,
 *   defaults: { user: string, machine: string }, auto: object|null, reducedMotion?: boolean, uninstall?: object }} State
 * @typedef {{ action: 'install'|'upgrade'|'repair', dir: string, scope: 'user'|'machine', desktop: boolean, startMenu: boolean,
 *   startup: boolean, launch: boolean }} InstallOptions
 * @typedef {{ phase: string, percent: number|null, text: string, bytes?: number, total?: number, file?: string, cancellable?: boolean }} Progress
 */
contextBridge.exposeInMainWorld('setup', {
  /** @returns {Promise<State>} */ getState: () => ipcRenderer.invoke('setup:state'),
  /** @param {string} current @returns {Promise<string|null>} */ chooseFolder: (current) => ipcRenderer.invoke('setup:choose-folder', current),
  /** @param {InstallOptions} opts @returns {Promise<{ ok: boolean, error?: string, code?: string, cancelled?: boolean }>} */
  install: (opts) => ipcRenderer.invoke('setup:install', opts),
  /** Ask Windows for administrator rights and continue there. @param {InstallOptions} opts @returns {Promise<boolean>} false: declined */
  elevate: (opts) => ipcRenderer.invoke('setup:elevate', opts),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  launchApp: () => ipcRenderer.invoke('setup:launch'),
  /** Start the installed version's own uninstaller and close setup */ uninstallExisting: () => ipcRenderer.invoke('setup:uninstall-existing'),
  /** Uninstall mode. @param {{ removeData: boolean }} opts */ uninstall: (opts) => ipcRenderer.invoke('setup:uninstall', opts),
  openLog: () => ipcRenderer.invoke('setup:open-log'),
  minimize: () => ipcRenderer.invoke('setup:minimize'),
  close: () => ipcRenderer.invoke('setup:close'),
  /** @param {(p: Progress) => void} cb @returns {() => void} unsubscribe */
  onProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('setup:progress', h);
    return () => ipcRenderer.removeListener('setup:progress', h);
  },
});
