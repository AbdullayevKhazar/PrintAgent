import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const appName = "NextCore Printer Agent";
const exePath = path.join(projectRoot, "release", appName, `${appName}.exe`);
const startupDir = path.join(
  process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Startup",
);
const shortcutPath = path.join(startupDir, `${appName}.lnk`);

const action = process.argv[2] || "install";

if (process.platform !== "win32") {
  throw new Error("Startup shortcut install is supported on Windows only.");
}

if (action === "install") {
  await installStartupShortcut();
} else if (action === "uninstall") {
  await uninstallStartupShortcut();
} else if (action === "status") {
  await printStartupStatus();
} else {
  throw new Error(`Unknown action: ${action}`);
}

async function installStartupShortcut() {
  await assertExists(exePath);
  await fs.mkdir(startupDir, { recursive: true });

  const ps = `
$ShortcutPath = ${toPowerShellString(shortcutPath)}
$TargetPath = ${toPowerShellString(exePath)}
$WorkingDirectory = ${toPowerShellString(path.dirname(exePath))}
$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $TargetPath
$Shortcut.Arguments = "-- --background"
$Shortcut.WorkingDirectory = $WorkingDirectory
$Shortcut.WindowStyle = 7
$Shortcut.Description = "Starts NextCore local thermal print agent"
$Shortcut.Save()
Write-Output $ShortcutPath
`;

  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
    {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    },
  );

  process.stdout.write(`Startup shortcut installed:\n${stdout.trim()}\n`);
}

async function uninstallStartupShortcut() {
  await fs.rm(shortcutPath, { force: true });
  process.stdout.write(`Startup shortcut removed:\n${shortcutPath}\n`);
}

async function printStartupStatus() {
  const exists = await pathExists(shortcutPath);
  process.stdout.write(
    JSON.stringify(
      {
        installed: exists,
        shortcutPath,
        targetPath: exePath,
      },
      null,
      2,
    ) + "\n",
  );
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Required file was not found: ${filePath}`);
  }
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPowerShellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}
