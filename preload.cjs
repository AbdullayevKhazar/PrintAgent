const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nextcrossAgent", {
  getStatus: () => ipcRenderer.invoke("agent:get-status"),
  getUpdateStatus: () => ipcRenderer.invoke("agent:get-update-status"),
  checkForUpdates: () => ipcRenderer.invoke("agent:check-for-updates"),
  installUpdate: () => ipcRenderer.invoke("agent:install-update"),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("agent:update-status", listener);
    return () => ipcRenderer.removeListener("agent:update-status", listener);
  },
  openTestPage: () => ipcRenderer.invoke("agent:open-test-page"),
  openBridgeHealth: () => ipcRenderer.invoke("agent:open-bridge-health"),
  openPrintersJson: () => ipcRenderer.invoke("agent:open-printers-json"),
});
