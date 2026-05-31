import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const setupInstallerPattern = /^Printer Agent-Setup-.*\.exe$/;

await cleanDist();

async function cleanDist() {
  const resolvedProjectRoot = await fs.realpath(projectRoot);

  let entries;
  try {
    entries = await fs.readdir(distDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }

    throw error;
  }

  for (const entry of entries) {
    if (entry.isFile() && setupInstallerPattern.test(entry.name)) {
      continue;
    }

    const entryPath = path.join(distDir, entry.name);
    const resolvedEntryPath = await resolveExistingPath(entryPath);

    if (!isInside(resolvedEntryPath, resolvedProjectRoot)) {
      throw new Error(`Refusing to remove outside project: ${resolvedEntryPath}`);
    }

    await fs.rm(resolvedEntryPath, { recursive: true, force: true });
  }
}

async function resolveExistingPath(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return filePath;
    }

    throw error;
  }
}

function isInside(childPath, parentPath) {
  const relative = path.relative(parentPath, childPath);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
