import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("fathom", {
  electron: process.versions.electron,
  platform: process.platform,
  storage: {
    chooseCacheDirectory: () => ipcRenderer.invoke("fathom:storage:choose-cache"),
    chooseDataDirectory: () => ipcRenderer.invoke("fathom:storage:choose-data"),
    getInfo: () => ipcRenderer.invoke("fathom:storage:get"),
    openCacheDirectory: () => ipcRenderer.invoke("fathom:storage:open-cache"),
    openDataDirectory: () => ipcRenderer.invoke("fathom:storage:open-data"),
    restart: () => ipcRenderer.invoke("fathom:storage:restart"),
  },
  workspace: {
    chooseDirectory: () => ipcRenderer.invoke("fathom:workspace:choose"),
    reveal: (path: string) => ipcRenderer.invoke("fathom:workspace:reveal", path),
  },
});
