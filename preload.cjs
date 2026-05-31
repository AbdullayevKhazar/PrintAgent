const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("nextcrossAgent", {
  getStatus: () => ipcRenderer.invoke("agent:get-status"),
  openTestPage: () => ipcRenderer.invoke("agent:open-test-page"),
  openBridgeHealth: () => ipcRenderer.invoke("agent:open-bridge-health"),
  openPrintersJson: () => ipcRenderer.invoke("agent:open-printers-json"),
});
