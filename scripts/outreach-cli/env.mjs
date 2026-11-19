/**
 * Shared env / path / mailbox resolution for outreach CLIs.
 * Credentials: process.env only — never read .env files from disk.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VALID_DELIVERY } from "./policy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

export function envTrim(name) {
  const v = process.env[name];
  return v ? String(v).trim() : "";
}

/**
 * AGENTSDR_URL must be set explicitly. Silent loopback default is forbidden
 * (cloud 127.0.0.1 ≠ mini). For local mini only, set AGENTSDR_URL=http://127.0.0.1:13031 yourself.
 */
export function requireAgentsdrUrl() {
  const url = envTrim("AGENTSDR_URL");
  if (!url) {
    throw new Error(
      "Missing AGENTSDR_URL. Set explicitly (e.g. https://sdr.linktion.cn). No silent loopback default.",
    );
  }
  return url.replace(/\/$/, "");
}

export function requireAgentsdrApiKey() {
  const key = envTrim("AGENTSDR_API_KEY");
  if (!key) {
    throw new Error("Missing AGENTSDR_API_KEY. Inject via formal secrets; no hardcoded fallback.");
  }
  return key;
}

/**
 * Sending mailboxes used to filter "own" addresses and choose fromEmail.
 * Required for any command that would call a real API with mailbox routing.
 * Format: comma-separated emails in AGENTSDR_OWN_MAILBOXES
 * Optional: AGENTSDR_FROM_EMAIL_ZH / AGENTSDR_FROM_EMAIL_EN
 *
 * example.com placeholders are NEVER accepted as runtime config.
 */
export function loadOwnMailboxes({ requireForLive = true } = {}) {
  const raw = envTrim("AGENTSDR_OWN_MAILBOXES");
  const list = raw
    ? raw.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];
  const fromZh = envTrim("AGENTSDR_FROM_EMAIL_ZH").toLowerCase();
  const fromEn = envTrim("AGENTSDR_FROM_EMAIL_EN").toLowerCase();
  for (const e of [...list, fromZh, fromEn]) {
    if (e && /@example\.com$/i.test(e)) {
      throw new Error(
        `Refusing example.com mailbox "${e}". Set AGENTSDR_OWN_MAILBOXES / AGENTSDR_FROM_EMAIL_* to real configured addresses.`,
      );
    }
  }
  if (requireForLive && list.length === 0) {
    throw new Error(
      "Missing AGENTSDR_OWN_MAILBOXES (comma-separated). Required for live wave-review API commands; no example.com default.",
    );
  }
  return {
    set: new Set(list),
    fromZh: fromZh || null,
    fromEn: fromEn || null,
  };
}

export function resolvePath(envName, fallbackRelative) {
  const fromEnv = envTrim(envName);
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(REPO_ROOT, fallbackRelative);
}

export function resolveWorkdir() {
  return envTrim("OUTREACH_WORKDIR") || path.join("/tmp", "agy-outreach-workdir");
}

/**
 * @deprecated AGY executor retired (t291u). Use resolveCursorAgentBin from cursorAgent.mjs.
 * Kept only so old imports fail loudly instead of spawning a fake `agy`.
 */
export function resolveAgyBin() {
  throw new Error(
    "AGY executor retired. Use Cursor Agent CLI (`agent` / CURSOR_AGENT_BIN) via scripts/outreach-cli/cursorAgent.mjs. Do not wrap Cursor Agent as a binary named agy.",
  );
}

export function resolveProspectTool(cliOverride) {
  if (cliOverride) return path.resolve(cliOverride);
  const fromEnv = envTrim("PROSPECT_TOOL");
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(REPO_ROOT, "scripts", "prospect-tool.mjs");
}

export function resolveDeliveryMode(raw, { defaultMode = "draft_only" } = {}) {
  const mode = (raw || defaultMode).trim();
  if (!VALID_DELIVERY.has(mode)) {
    throw new Error(
      `Invalid delivery "${mode}". Expected: draft_only | queue_working_hours | send_now | send_paced`,
    );
  }
  return mode;
}

/**
 * Permission bypass is forbidden for the Cursor Agent executor (t291u).
 * Always returns false; callers must not enable --force/--yolo/--dangerously-skip-permissions.
 */
export function allowDangerouslySkipPermissions(argv = process.argv) {
  const forbidden = [
    "--dangerously-skip-permissions",
    "--skip-permissions",
    "--force",
    "--yolo",
  ];
  if (forbidden.some((f) => argv.includes(f))) {
    throw new Error(
      `Permission-bypass flag is forbidden. Configure .cursor/cli.json permissions.allow instead of ${forbidden.join(" / ")}.`,
    );
  }
  const v = envTrim("AGY_DANGEROUSLY_SKIP_PERMISSIONS").toLowerCase();
  if (v === "1" || v === "true" || v === "yes") {
    throw new Error(
      "AGY_DANGEROUSLY_SKIP_PERMISSIONS is forbidden after AGY retirement. Use Cursor Agent allowlist permissions only.",
    );
  }
  return false;
}

export function assertFileExists(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}
