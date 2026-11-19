/**
 * Cursor Agent CLI executor helpers for outreach waves.
 * Official binary is `agent` (https://cursor.com/docs/cli). Never alias/wrap as `agy`.
 *
 * Auth: CURSOR_API_KEY (Dashboard → API Keys). Never hardcode or read .env files.
 * Permissions: no --force / --yolo / --dangerously-skip-permissions. Prefer project
 * `.cursor/cli.json` allowlist (Shell(node) for prospect-tool) under approvalMode allowlist.
 */
import fs from "node:fs";
import path from "node:path";
import { envTrim } from "./env.mjs";

/** Historical AGY default model string — may not be a Cursor-supported id. */
export const LEGACY_AGY_MODEL = "gemini-3.8-flash-medium";

const FORBIDDEN_SKIP_FLAGS = [
  "--dangerously-skip-permissions",
  "--skip-permissions",
  "--force",
  "--yolo",
];

/**
 * Resolve official Cursor Agent binary. Default: `agent` on PATH.
 * Override with CURSOR_AGENT_BIN (absolute path or command name).
 * AGY_BIN is intentionally ignored so we never silently fall back to AGY.
 */
export function resolveCursorAgentBin() {
  return envTrim("CURSOR_AGENT_BIN") || "agent";
}

/** Boolean presence only — never return the key value. */
export function isCursorApiKeyPresent() {
  return Boolean(envTrim("CURSOR_API_KEY"));
}

export function requireCursorApiKey() {
  if (!isCursorApiKeyPresent()) {
    throw new Error(
      "Missing CURSOR_API_KEY. Configure as a Cursor environment secret (Dashboard → API Keys). Do not put the value in source or .env files.",
    );
  }
}

/**
 * Fail closed if argv requests permission bypass.
 * Cursor's --force/--yolo is the headless equivalent of AGY --dangerously-skip-permissions.
 */
export function assertNoPermissionBypass(argv = []) {
  for (const a of argv) {
    if (FORBIDDEN_SKIP_FLAGS.includes(a)) {
      throw new Error(
        `Refusing permission-bypass flag "${a}". Use .cursor/cli.json permissions.allow (Shell(node) for prospect-tool) instead of --force/--yolo/--dangerously-skip-permissions.`,
      );
    }
  }
  return false;
}

/**
 * Build argv for: agent -p --output-format text --model <id> --workspace <dir> [--trust] <prompt>
 * Prompt is the last positional argument (may contain newlines).
 */
export function buildCursorAgentArgs({
  model,
  prompt,
  workspace,
  trustWorkspace = true,
  outputFormat = "text",
} = {}) {
  if (!model || !String(model).trim()) {
    throw new Error("buildCursorAgentArgs: model is required");
  }
  if (!prompt || !String(prompt).trim()) {
    throw new Error("buildCursorAgentArgs: prompt is required");
  }
  if (!workspace || !String(workspace).trim()) {
    throw new Error("buildCursorAgentArgs: workspace is required");
  }

  const args = [
    "--print",
    "--output-format",
    outputFormat,
    "--model",
    String(model).trim(),
    "--workspace",
    path.resolve(workspace),
  ];
  if (trustWorkspace) args.push("--trust");
  args.push(String(prompt));
  assertNoPermissionBypass(args);
  return args;
}

/** Preflight: binary must exist on PATH or as absolute/relative executable. */
export function assertCursorAgentAvailable(bin = resolveCursorAgentBin()) {
  if (bin.includes("/") || bin.startsWith(".")) {
    const abs = path.resolve(bin);
    if (!fs.existsSync(abs)) {
      throw new Error(
        `Cursor Agent binary not found at CURSOR_AGENT_BIN=${abs}. Install via: curl https://cursor.com/install -fsS | bash`,
      );
    }
    return abs;
  }
  // PATH lookup — spawn will ENOENT if missing; give a clearer message early when possible.
  const pathEnv = process.env.PATH || "";
  const found = pathEnv.split(path.delimiter).some((dir) => {
    if (!dir) return false;
    try {
      const candidate = path.join(dir, bin);
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error(
      `Cursor Agent \`${bin}\` not found on PATH. Install via: curl https://cursor.com/install -fsS | bash  (or set CURSOR_AGENT_BIN). Do not create a fake binary named agy.`,
    );
  }
  return bin;
}

/**
 * Detect model-id rejection in CLI stderr/stdout (for Ivan compatibility report).
 * Does not pick a replacement model.
 */
export function detectUnsupportedModelMessage(text, model) {
  const blob = String(text || "");
  const m = String(model || "");
  if (!m) return null;
  const patterns = [
    /unknown model/i,
    /unsupported model/i,
    /invalid model/i,
    /model .* not (found|available|supported)/i,
    /no such model/i,
  ];
  if (patterns.some((re) => re.test(blob)) && blob.includes(m)) {
    return `Model string "${m}" appears unsupported by Cursor Agent CLI. Do not auto-select a paid/new model; ask Ivan which Cursor model id to use.`;
  }
  if (patterns.some((re) => re.test(blob))) {
    return `Cursor Agent rejected --model (requested "${m}"). Run \`agent models\` and ask Ivan which id to use; do not auto-pick.`;
  }
  return null;
}
