import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const electronDist = path.join(projectRoot, "node_modules", "electron", "dist");
const releaseRoot = path.join(projectRoot, "release");
const appName = "NextCross Test Agent";
const outputDir = path.join(releaseRoot, appName);
const resourcesAppDir = path.join(outputDir, "resources", "app");
const exePath = path.join(outputDir, `${appName}.exe`);

await assertExists(path.join(electronDist, "electron.exe"));
await recreateOutputDir();
await fs.cp(electronDist, outputDir, { recursive: true });
await fs.rename(path.join(outputDir, "electron.exe"), exePath);
await fs.rm(path.join(outputDir, "resources", "default_app.asar"), {
  force: true,
});
await fs.mkdir(resourcesAppDir, { recursive: true });

await copyProjectFile("main.js");
await copyProjectFile("print-queue-worker.js");
await copyProjectFile("preload.cjs");
await copyProjectFile("dashboard.html");
await copyProjectFile("package.json");
await copyProjectDirectory("docs");
await copyProjectDirectory("local-print-agent");
await writePackagedReadme();

console.log(`Packaged: ${exePath}`);

async function recreateOutputDir() {
  const resolvedProjectRoot = await fs.realpath(projectRoot);
  await fs.mkdir(releaseRoot, { recursive: true });

  try {
    const resolvedOutputDir = await fs.realpath(outputDir);

    if (!isInside(resolvedOutputDir, resolvedProjectRoot)) {
      throw new Error(`Refusing to remove outside project: ${resolvedOutputDir}`);
    }

    await fs.rm(resolvedOutputDir, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(outputDir, { recursive: true });
}

async function copyProjectFile(relativePath) {
  await fs.copyFile(
    path.join(projectRoot, relativePath),
    path.join(resourcesAppDir, relativePath),
  );
}

async function copyProjectDirectory(relativePath) {
  await fs.cp(path.join(projectRoot, relativePath), path.join(resourcesAppDir, relativePath), {
    recursive: true,
  });
}

async function writePackagedReadme() {
  await fs.writeFile(
    path.join(outputDir, "README.txt"),
    [
      `${appName}`,
      "",
      "Run this file:",
      `${appName}.exe`,
      "",
      "The app starts the embedded local print agent automatically.",
      "The first window is a status dashboard for health, printers, and queue state.",
      "By default it also starts NextCross-Admin from:",
      "C:\\Users\\abdul\\Desktop\\NextCross-Admin",
      "",
      "Printer settings are read from:",
      "resources\\app\\local-print-agent\\.env",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

async function assertExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Required file was not found: ${filePath}`);
  }
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
