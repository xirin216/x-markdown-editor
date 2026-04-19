import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const sourceDir = path.join(projectRoot, "node_modules", "vditor", "dist");
const targetRoot = path.join(projectRoot, "public", "vditor");
const targetDir = path.join(targetRoot, "dist");

if (!existsSync(sourceDir)) {
  console.error(`Vditor assets not found: ${sourceDir}`);
  process.exit(1);
}

mkdirSync(targetRoot, { recursive: true });
rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });

console.log(`Synced Vditor assets to ${targetDir}`);
