const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload bridge.
 *
 * Exposes exactly two calls and nothing else. The renderer has no filesystem,
 * no shell and no node access; anything it needs from the host goes through
 * these two functions, which keeps the attack surface of a page that renders
 * broker-supplied text as small as possible.
 */

contextBridge.exposeInMainWorld('truckdesk', {
  version: () => ipcRenderer.invoke('truckdesk:version'),
  openExternal: (url: string) => ipcRenderer.invoke('truckdesk:open-external', url),
});