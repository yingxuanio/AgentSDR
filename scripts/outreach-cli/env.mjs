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

export function resolveAgyBin() {
  return envTrim("AGY_BIN") || "agy";
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

/** AGY --dangerously-skip-permissions: default OFF. Opt-in via flag or env=1. */
export function allowDangerouslySkipPermissions(argv = process.argv) {
  if (argv.includes("--dangerously-skip-permissions")) return true;
  const v = envTrim("AGY_DANGEROUSLY_SKIP_PERMISSIONS").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function assertFileExists(p, label) {
  if (!fs.existsSync(p)) {
    throw new Error(`${label} not found: ${p}`);
  }
}
