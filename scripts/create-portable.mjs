import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const packageJsonPath = path.join(projectRoot, "package.json");
const tauriConfigPath = path.join(projectRoot, "src-tauri", "tauri.conf.json");

const [packageJson, tauriConfig] = await Promise.all([
  readJson(packageJsonPath),
  readJson(tauriConfigPath),
]);

const packageName = packageJson.name ?? "x-markdown-editor";
const productName = tauriConfig.productName ?? packageName;
const version = tauriConfig.version ?? packageJson.version ?? "0.0.0";
const arch = normalizeArch(process.arch);
const portableName = `${toReleaseName(productName)}-${version}-${arch}-portable.exe`;

const sourcePath = path.join(projectRoot, "src-tauri", "target", "release", `${packageName}.exe`);
const outputDir = path.join(projectRoot, "src-tauri", "target", "release", "bundle", "nsis");
const outputPath = path.join(outputDir, portableName);

try {
  await stat(sourcePath);
} catch {
  throw new Error(`Portable source executable was not found: ${sourcePath}`);
}

await mkdir(outputDir, { recursive: true });
await copyFile(sourcePath, outputPath);

const outputStats = await stat(outputPath);
console.log(`Portable executable created: ${outputPath} (${formatBytes(outputStats.size)})`);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizeArch(archName) {
  if (archName === "x64") return "x64";
  if (archName === "arm64") return "arm64";
  if (archName === "ia32") return "x86";
  return archName;
}

function toReleaseName(name) {
  return name
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function formatBytes(bytes) {
  const megabytes = bytes / 1024 / 1024;
  return `${megabytes.toFixed(2)} MB`;
}
