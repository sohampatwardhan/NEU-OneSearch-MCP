#!/usr/bin/env node
// Registers this MCP server with whichever of Claude Code, Claude Desktop,
// and Codex CLI are installed locally. Safe to re-run — each target is
// updated in place rather than duplicated. Antigravity has no CLI or
// documented config path, so it isn't handled here; see README.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SERVER_NAME = "neu-onesearch";
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const serverEntry = join(repoRoot, "dist", "index.js");

if (!existsSync(serverEntry)) {
  console.error(`${serverEntry} not found — run "npm run build" first.`);
  process.exit(1);
}

function commandExists(cmd) {
  const checker = platform() === "win32" ? "where" : "which";
  return spawnSync(checker, [cmd], { stdio: "ignore" }).status === 0;
}

function run(cmd, args) {
  return spawnSync(cmd, args, { stdio: "inherit" });
}

function installClaudeCode() {
  if (!commandExists("claude")) {
    console.log("Claude Code (`claude`) not found on PATH — skipping.");
    return;
  }
  run("claude", ["mcp", "remove", "--scope", "user", SERVER_NAME]);
  const result = run("claude", [
    "mcp", "add", "--scope", "user", SERVER_NAME, "--", "node", serverEntry,
  ]);
  console.log(
    result.status === 0
      ? "Claude Code: registered."
      : "Claude Code: registration failed (see output above).",
  );
}

function installCodex() {
  if (!commandExists("codex")) {
    console.log("Codex CLI (`codex`) not found on PATH — skipping.");
    return;
  }
  run("codex", ["mcp", "remove", SERVER_NAME]);
  const result = run("codex", ["mcp", "add", SERVER_NAME, "--", "node", serverEntry]);
  console.log(
    result.status === 0
      ? "Codex CLI: registered."
      : "Codex CLI: registration failed (see output above).",
  );
}

function claudeDesktopConfigPath() {
  const plat = platform();
  if (plat === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (plat === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return null; // Claude Desktop has no official Linux build.
}

function installClaudeDesktop() {
  const configPath = claudeDesktopConfigPath();
  if (!configPath) {
    console.log("Claude Desktop: no official Linux build — skipping.");
    return;
  }

  let config = { mcpServers: {} };
  if (existsSync(configPath)) {
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      console.error(`Claude Desktop: could not parse ${configPath} — leaving it untouched.`);
      return;
    }
    copyFileSync(configPath, `${configPath}.bak`);
  } else {
    mkdirSync(dirname(configPath), { recursive: true });
  }

  config.mcpServers ??= {};
  config.mcpServers[SERVER_NAME] = { command: "node", args: [serverEntry] };
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Claude Desktop: registered (${configPath}). Restart Claude Desktop to pick it up.`);
}

console.log(`Installing "${SERVER_NAME}" (${serverEntry})\n`);
installClaudeCode();
installCodex();
installClaudeDesktop();
