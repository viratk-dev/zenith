#!/usr/bin/env node
/**
 * zenith — one-command launcher.
 * Handles: build (if needed) -> setup wizard (if no config) -> start agent.
 * Works via: npx zenith   |   npm install -g zenith   |   npx github:viratk-dev/zenith
 */
import { existsSync } from "node:fs";
import { spawnSync, execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist", "index.js");
const config = join(root, "config.yaml");

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", cwd: root, ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// 1. Build if dist is missing (fresh git clone via npx)
if (!existsSync(dist)) {
  console.log("Building Zenith… (first run only)");
  try {
    execSync("npm run build", { cwd: root, stdio: "inherit" });
  } catch {
    console.error("\nBuild failed. Make sure dependencies are installed:\n  npm install\n");
    process.exit(1);
  }
}

// 2. Setup wizard if no config
if (!existsSync(config)) {
  console.log("\nNo config found — starting setup wizard.\n");
  run("node", [join(root, "scripts", "setup.mjs")]);
  if (!existsSync(config)) {
    console.log("Setup cancelled.");
    process.exit(0);
  }
}

// 3. Start
run("node", [dist], { env: { ...process.env } });
