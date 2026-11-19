import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  allowDangerouslySkipPermissions,
  loadOwnMailboxes,
  requireAgentsdrUrl,
  resolveDeliveryMode,
} from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("requireAgentsdrUrl", () => {
  test("throws when unset (no silent loopback)", () => {
    const prev = process.env.AGENTSDR_URL;
    delete process.env.AGENTSDR_URL;
    expect(() => requireAgentsdrUrl()).toThrow(/Missing AGENTSDR_URL/);
    if (prev !== undefined) process.env.AGENTSDR_URL = prev;
  });
});

describe("loadOwnMailboxes", () => {
  test("rejects example.com", () => {
    const prev = process.env.AGENTSDR_OWN_MAILBOXES;
    process.env.AGENTSDR_OWN_MAILBOXES = "sender-zh@example.com,sender-en@example.com";
    expect(() => loadOwnMailboxes({ requireForLive: true })).toThrow(/example\.com/);
    if (prev !== undefined) process.env.AGENTSDR_OWN_MAILBOXES = prev;
    else delete process.env.AGENTSDR_OWN_MAILBOXES;
  });

  test("accepts configured non-example mailboxes", () => {
    const prev = process.env.AGENTSDR_OWN_MAILBOXES;
    process.env.AGENTSDR_OWN_MAILBOXES = "a@yingxuan.io,b@linktion.cn";
    const mb = loadOwnMailboxes({ requireForLive: true });
    expect(mb.set.has("a@yingxuan.io")).toBe(true);
    if (prev !== undefined) process.env.AGENTSDR_OWN_MAILBOXES = prev;
    else delete process.env.AGENTSDR_OWN_MAILBOXES;
  });
});

describe("allowDangerouslySkipPermissions", () => {
  test("default off", () => {
    const prev = process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS;
    delete process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS;
    expect(allowDangerouslySkipPermissions(["node", "script.mjs"])).toBe(false);
    if (prev !== undefined) process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS = prev;
  });

  test("opt-in via flag", () => {
    expect(allowDangerouslySkipPermissions(["node", "x", "--dangerously-skip-permissions"])).toBe(true);
  });
});

describe("resolveDeliveryMode", () => {
  test("defaults path via explicit draft_only", () => {
    expect(resolveDeliveryMode("draft_only")).toBe("draft_only");
  });
});

describe("CLI help / fail-closed (no network send)", () => {
  test("run-outreach-wave --help exits 0", () => {
    const r = spawnSync(process.execPath, ["scripts/run-outreach-wave.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("draft_only");
    expect(r.stdout).toContain("DEFAULT OFF");
  });

  test("run-outreach-wave without AGENTSDR_URL exits 1", () => {
    const env = { ...process.env };
    delete env.AGENTSDR_URL;
    delete env.AGENTSDR_API_KEY;
    const r = spawnSync(process.execPath, ["scripts/run-outreach-wave.mjs", "--target", "1"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/AGENTSDR_URL/);
  });

  test("prospect-tool --help exits 0", () => {
    const r = spawnSync(process.execPath, ["scripts/prospect-tool.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("draft_only");
  });

  test("prospect-tool check without env exits 1", () => {
    const env = { ...process.env };
    delete env.AGENTSDR_URL;
    delete env.AGENTSDR_API_KEY;
    const r = spawnSync(process.execPath, ["scripts/prospect-tool.mjs", "check", "example.com"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(1);
  });

  test("wave-review-tool --help exits 0 without requiring secrets", () => {
    const env = { ...process.env };
    delete env.AGENTSDR_URL;
    delete env.AGENTSDR_API_KEY;
    delete env.AGENTSDR_OWN_MAILBOXES;
    const r = spawnSync(process.execPath, ["scripts/wave-review-tool.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(0);
  });

  test("wave-review-tool retrospective without mailboxes exits 1", () => {
    const env = {
      ...process.env,
      AGENTSDR_URL: "https://sdr.linktion.cn",
      AGENTSDR_API_KEY: "test-not-real",
    };
    delete env.AGENTSDR_OWN_MAILBOXES;
    const r = spawnSync(process.execPath, ["scripts/wave-review-tool.mjs", "retrospective", "--days", "1"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/OWN_MAILBOXES|example/);
  });
});
