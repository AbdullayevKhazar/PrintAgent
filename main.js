import electron from "electron";
import electronUpdater from "electron-updater";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path, { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  getPrintQueueConfig,
  startPrintQueueWorker,
} from "./print-queue-worker.js";

const { app, BrowserWindow, dialog, shell, Menu, Tray, nativeImage } = electron;
const { ipcMain } = electron;
const { autoUpdater } = electronUpdater;

loadEnvFile(new URL("./local-print-agent/.env", import.meta.url));

const ADMIN_DIR =
  process.env.NEXTCROSS_ADMIN_DIR ||
  "C:\\Users\\abdul\\Desktop\\NextCross-Admin";
const TEST_URL = process.env.NEXTCROSS_TEST_URL || "http://localhost:5173/test";
const PRINT_AGENT_PORT = readNumberEnv(
  "PRINT_AGENT_PORT",
  readNumberEnv("PORT", 9191),
);
const PRINT_AGENT_HOST = readOptionalEnv("PRINT_AGENT_HOST") || "localhost";
const PRINT_AGENT_URL = stripTrailingSlash(
  process.env.NEXTCROSS_PRINT_AGENT_URL ||
    `http://${formatAgentUrlHost(PRINT_AGENT_HOST)}:${PRINT_AGENT_PORT}`,
);
const PRINT_AGENT_ENTRY = new URL(
  "./local-print-agent/server.js",
  import.meta.url,
);
const DASHBOARD_ENTRY = new URL("./dashboard.html", import.meta.url);
const PRELOAD_ENTRY = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const VITE_ENTRY = path.join(
  ADMIN_DIR,
  "node_modules",
  "vite",
  "bin",
  "vite.js",
);
const VITE_ARGS = ["--host", "127.0.0.1", "--port", "5173", "--strictPort"];
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

let frontendProcess = null;
let printAgentStartPromise = null;
let mainWindow = null;
let printQueueWorker = null;
let tray = null;
let trayStatus = {
  state: "starting",
  message: "Starting",
};
let isQuitting = false;
let autoStartStatus = {
  enabled: false,
  supported: process.platform === "win32",
  error: "",
};
let updateStatus = {
  state: app.isPackaged ? "idle" : "disabled",
  message: app.isPackaged
    ? "Update check has not started yet"
    : "Auto update works only in the installed app",
  version: app.getVersion(),
  availableVersion: "",
  percent: 0,
};
let updateReadyToInstall = false;
let updateInstallPromptShown = false;

async function startFrontendDevServer() {
  if (await isUrlReady(TEST_URL)) {
    console.log(`[frontend] already running at ${TEST_URL}`);
    return;
  }

  console.log(`[frontend] starting Vite dev server: ${VITE_ENTRY}`);
  frontendProcess = spawnFrontendProcess();

  frontendProcess.stdout?.on("data", (chunk) => {
    console.log(`[frontend] ${chunk.toString().trim()}`);
  });

  frontendProcess.stderr?.on("data", (chunk) => {
    console.error(`[frontend] ${chunk.toString().trim()}`);
  });

  frontendProcess.on("exit", (code, signal) => {
    console.log(`[frontend] exited code=${code ?? ""} signal=${signal ?? ""}`);
    frontendProcess = null;
  });

  await waitForUrl(TEST_URL, "frontend");
}

function spawnFrontendProcess() {
  return spawn("node", [VITE_ENTRY, ...VITE_ARGS], {
    cwd: ADMIN_DIR,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function startEmbeddedPrintAgent() {
  if (printAgentStartPromise) {
    return printAgentStartPromise;
  }

  printAgentStartPromise = (async () => {
    if (await isPrintAgentHealthy()) {
      console.log(`[print-agent] already running at ${PRINT_AGENT_URL}`);
      return;
    }

    console.log("[print-agent] starting embedded local-print-agent/server.js");
    await import(PRINT_AGENT_ENTRY.href);
    await waitForUrl(`${PRINT_AGENT_URL}/health`, "print-agent");
  })();

  return printAgentStartPromise;
}

async function isPrintAgentHealthy() {
  return isUrlReady(`${PRINT_AGENT_URL}/health`);
}

async function isUrlReady(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, label) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (await isUrlReady(url)) {
      console.log(`[${label}] ready at ${url}`);
      return;
    }

    await delay(500);
  }

  throw new Error(`${label} did not become ready: ${url}`);
}

function createWindow(options = {}) {
  const shouldShow = options.show !== false;

  if (mainWindow && !mainWindow.isDestroyed()) {
    if (shouldShow) {
      mainWindow.show();
      mainWindow.focus();
    }
    return mainWindow;
  }

  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: shouldShow,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    icon: path.join(process.cwd(), "icon", "image.ico"),
    webPreferences: {
      preload: PRELOAD_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(fileURLToPath(DASHBOARD_ENTRY));
  mainWindow = window;

  window.on("close", (event) => {
    if (isQuitting) {
      return;
    }

    event.preventDefault();
    window.hide();
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  return window;
}

function stopSpawnedProcess(childProcess) {
  if (!childProcess?.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(childProcess.pid), "/t", "/f"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  childProcess.kill();
}

function loadEnvFile(fileUrl) {
  try {
    const content = readFileSync(fileUrl, "utf8");

    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");

      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      const value = unquoteEnvValue(trimmed.slice(separatorIndex + 1).trim());

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.warn("[electron] env file load warning", error);
    }
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readOptionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || "";
}

function readNumberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBooleanEnv(name, fallback) {
  const value = readOptionalEnv(name).toLowerCase();

  if (!value) {
    return fallback;
  }

  return !["0", "false", "off", "no"].includes(value);
}

function formatAgentUrlHost(host) {
  if (!host || host === "0.0.0.0" || host === "::") {
    return "localhost";
  }

  if (host.includes(":") && !host.startsWith("[")) {
    return `[${host}]`;
  }

  return host;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function createTray() {
  if (tray) {
    return;
  }

  tray = new Tray(createTrayIcon());
  tray.setToolTip("NextCross Print App");
  tray.on("double-click", () => {
    createWindow();
  });

  updateTrayMenu();
}

function createTrayIcon() {
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">',
    '<rect width="16" height="16" rx="3" fill="#111827"/>',
    '<path d="M4 3h8v4H4zM3 7h10v5H3z" fill="#fff"/>',
    '<path d="M5 9h6M5 11h4" stroke="#111827" stroke-width="1"/>',
    "</svg>",
  ].join("");

  return nativeImage.createFromDataURL(
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  );
}

function setTrayStatus(status) {
  trayStatus = {
    ...trayStatus,
    ...status,
  };
  updateTrayMenu();
}

function setUpdateStatus(status) {
  updateStatus = {
    ...updateStatus,
    ...status,
    version: app.getVersion(),
  };

  updateTrayMenu();

  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("agent:update-status", updateStatus);
    }
  }
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }

  const queueConfig = getPrintQueueConfig();
  const statusLabel = trayStatus.message || trayStatus.state || "Unknown";

  tray.setToolTip(`NextCross Print App - ${statusLabel}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "NextCross Print App",
        enabled: false,
      },
      {
        label: `Queue: ${statusLabel}`,
        enabled: false,
      },
      {
        label: `Branch: ${queueConfig.branchId || "-"}`,
        enabled: false,
      },
      {
        label: `Device: ${queueConfig.deviceId || "-"}`,
        enabled: false,
      },
      {
        label: `Auto start: ${autoStartStatus.enabled ? "On" : "Off"}`,
        enabled: false,
      },
      {
        label: `Update: ${updateStatus.message}`,
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Open Dashboard",
        click: () => openDashboard(),
      },
      {
        label: "Check for Updates",
        enabled: app.isPackaged,
        click: () => checkForUpdates(),
      },
      {
        label: "Install Downloaded Update",
        enabled: updateReadyToInstall,
        click: () => installDownloadedUpdate(),
      },
      {
        label: "Open Print Bridge Health",
        click: () => shell.openExternal(`${PRINT_AGENT_URL}/health`),
      },
      { type: "separator" },
      {
        label: "Stop Agent",
        click: () => requestQuit(),
      },
    ]),
  );
}

function requestQuit() {
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = dialog.showMessageBoxSync(focusedWindow ?? undefined, {
    type: "warning",
    buttons: ["Cancel", "Stop Agent"],
    defaultId: 0,
    cancelId: 0,
    title: "Stop NextCross Print Agent?",
    message: "Stop NextCross Print Agent?",
    detail:
      "Agent dayanarsa, browserden gelen cek caplari komputer yeniden baslayana ve ya agent tekrar acilana qeder islenmeyecek.",
  });

  if (result === 1) {
    isQuitting = true;
    app.quit();
  }
}

function configureAutoStart() {
  if (process.platform !== "win32") {
    autoStartStatus = {
      enabled: false,
      supported: false,
      error: "Only Windows auto start is configured",
    };
    return;
  }

  if (!app.isPackaged) {
    autoStartStatus = {
      enabled: false,
      supported: true,
      error: "Packaged exe acilanda auto start aktiv olacaq",
    };
    return;
  }

  if (!readBooleanEnv("PRINT_AGENT_AUTO_START", true)) {
    app.setLoginItemSettings({
      openAtLogin: false,
      path: process.execPath,
    });
    autoStartStatus = {
      enabled: false,
      supported: true,
      error: "",
    };
    return;
  }

  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath,
      args: ["--", "--background"],
    });

    const settings = app.getLoginItemSettings({
      path: process.execPath,
      args: ["--", "--background"],
    });

    autoStartStatus = {
      enabled: Boolean(settings.openAtLogin),
      supported: true,
      error: "",
    };
  } catch (error) {
    autoStartStatus = {
      enabled: false,
      supported: true,
      error: error instanceof Error ? error.message : String(error),
    };
    console.warn("[electron] auto start setup failed", error);
  }
}

function configureAutoUpdater() {
  if (!app.isPackaged) {
    setUpdateStatus({
      state: "disabled",
      message: "Auto update works only in the installed app",
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    setUpdateStatus({
      state: "checking",
      message: "Checking for updates",
      percent: 0,
    });
  });

  autoUpdater.on("update-available", (info) => {
    setUpdateStatus({
      state: "available",
      message: `Downloading version ${info.version}`,
      availableVersion: info.version,
      percent: 0,
    });
  });

  autoUpdater.on("update-not-available", () => {
    setUpdateStatus({
      state: "current",
      message: "App is up to date",
      availableVersion: "",
      percent: 0,
    });
  });

  autoUpdater.on("download-progress", (progress) => {
    const percent = Math.round(progress.percent || 0);
    setUpdateStatus({
      state: "downloading",
      message: `Downloading update ${percent}%`,
      percent,
    });
  });

  autoUpdater.on("update-downloaded", (info) => {
    updateReadyToInstall = true;
    setUpdateStatus({
      state: "ready",
      message: `Version ${info.version} is ready to install`,
      availableVersion: info.version,
      percent: 100,
    });
    promptInstallDownloadedUpdate(info.version);
  });

  autoUpdater.on("error", (error) => {
    setUpdateStatus({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      percent: 0,
    });
  });
}

async function checkForUpdates() {
  if (!app.isPackaged) {
    setUpdateStatus({
      state: "disabled",
      message: "Auto update works only in the installed app",
    });
    return updateStatus;
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    setUpdateStatus({
      state: "error",
      message: error instanceof Error ? error.message : String(error),
      percent: 0,
    });
  }

  return updateStatus;
}

function promptInstallDownloadedUpdate(version) {
  if (updateInstallPromptShown) {
    return;
  }

  updateInstallPromptShown = true;
  const focusedWindow = BrowserWindow.getFocusedWindow();
  const result = dialog.showMessageBoxSync(focusedWindow ?? undefined, {
    type: "info",
    buttons: ["Restart and Install", "Later"],
    defaultId: 0,
    cancelId: 1,
    title: "Printer Agent update ready",
    message: `Printer Agent ${version} is ready to install.`,
    detail:
      "Restart secilende proqram baglanacaq, update qurulacaq ve yeniden acilacaq.",
  });

  if (result === 0) {
    installDownloadedUpdate();
  }
}

function installDownloadedUpdate() {
  if (!updateReadyToInstall) {
    return false;
  }

  isQuitting = true;
  autoUpdater.quitAndInstall(false, true);
  return true;
}

function getPrinterNameLabel() {
  return (
    readOptionalEnv("PRINT_AGENT_PRINTER_NAME") ||
    readOptionalEnv("PRINTER_NAME") ||
    "Windows default printer"
  );
}

async function getBridgeHealthStatus() {
  try {
    const response = await fetch(`${PRINT_AGENT_URL}/health`);
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: parseJson(text) ?? text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getDashboardStatus() {
  const queueConfig = getPrintQueueConfig();
  const workerStatus = printQueueWorker?.getStatus?.() ?? {};

  return {
    appName: "NextCross Print Agent",
    printAgentUrl: PRINT_AGENT_URL,
    testUrl: TEST_URL,
    adminDir: ADMIN_DIR,
    printerName: getPrinterNameLabel(),
    platform: process.platform,
    bridge: await getBridgeHealthStatus(),
    autoStart: autoStartStatus,
    update: updateStatus,
    frontend: {
      enabled: readBooleanEnv("NEXTCROSS_START_FRONTEND", false),
      testUrl: TEST_URL,
    },
    queue: {
      ...queueConfig,
      ...workerStatus,
    },
  };
}

function openTestPage() {
  const window = createWindow();
  window.loadURL(TEST_URL);
}

function openDashboard() {
  const window = createWindow();
  window.loadFile(fileURLToPath(DASHBOARD_ENTRY));
}

function shouldStartInBackground() {
  return (
    process.argv.includes("--background") ||
    process.argv.includes("--hidden") ||
    process.argv.includes("background") ||
    process.argv.includes("hidden")
  );
}

function parseJson(text) {
  const value = String(text || "").trim();

  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

ipcMain.handle("agent:get-status", () => getDashboardStatus());
ipcMain.handle("agent:get-update-status", () => updateStatus);
ipcMain.handle("agent:check-for-updates", () => checkForUpdates());
ipcMain.handle("agent:install-update", () => installDownloadedUpdate());
ipcMain.handle("agent:open-test-page", () => {
  openTestPage();
});
ipcMain.handle("agent:open-bridge-health", () => {
  shell.openExternal(`${PRINT_AGENT_URL}/health`);
});
ipcMain.handle("agent:open-printers-json", () => {
  shell.openExternal(`${PRINT_AGENT_URL}/printers`);
});

app.whenReady().then(async () => {
  try {
    configureAutoStart();
    configureAutoUpdater();
    createTray();
    setTrayStatus({ state: "starting", message: "Starting services" });
    await startEmbeddedPrintAgent();

    if (readBooleanEnv("NEXTCROSS_START_FRONTEND", false)) {
      await startFrontendDevServer();
    }

    printQueueWorker = startPrintQueueWorker({
      bridgeUrl: PRINT_AGENT_URL,
      onStatusChange: setTrayStatus,
    });

    if (!shouldStartInBackground()) {
      openDashboard();
    } else {
      createWindow({ show: false });
    }

    await checkForUpdates();
    setInterval(() => {
      checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dialog.showErrorBox("Electron start failed", message);
    console.error("[electron] start failed", error);
    app.quit();
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      openDashboard();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  printQueueWorker?.stop();
  stopSpawnedProcess(frontendProcess);
});

app.on("window-all-closed", () => {
  if (process.platform === "darwin") {
    return;
  }

  if (tray) {
    console.log("[electron] all windows closed; print app stays in tray");
    return;
  }

  app.quit();
});
