import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_AGY_MODEL,
  assertNoPermissionBypass,
  buildCursorAgentArgs,
  detectUnsupportedModelMessage,
  isCursorApiKeyPresent,
  requireCursorApiKey,
  resolveCursorAgentBin,
} from "./cursorAgent.mjs";
import { allowDangerouslySkipPermissions, resolveAgyBin } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("resolveCursorAgentBin", () => {
  test("defaults to agent (never agy)", () => {
    const prev = process.env.CURSOR_AGENT_BIN;
    delete process.env.CURSOR_AGENT_BIN;
    expect(resolveCursorAgentBin()).toBe("agent");
    expect(resolveCursorAgentBin()).not.toBe("agy");
    if (prev !== undefined) process.env.CURSOR_AGENT_BIN = prev;
  });
});

describe("resolveAgyBin retired", () => {
  test("throws and forbids fake agy wrapper", () => {
    expect(() => resolveAgyBin()).toThrow(/AGY executor retired|Cursor Agent|agy/);
  });
});

describe("permission bypass refused", () => {
  test("assertNoPermissionBypass rejects --force/--yolo/--dangerously-skip-permissions", () => {
    expect(() => assertNoPermissionBypass(["--force"])).toThrow(/force/);
    expect(() => assertNoPermissionBypass(["--yolo"])).toThrow(/yolo/);
    expect(() => assertNoPermissionBypass(["--dangerously-skip-permissions"])).toThrow(
      /dangerously-skip-permissions/,
    );
  });

  test("allowDangerouslySkipPermissions throws on forbidden flags", () => {
    expect(() =>
      allowDangerouslySkipPermissions(["node", "x", "--dangerously-skip-permissions"]),
    ).toThrow(/forbidden|Permission/);
    expect(() => allowDangerouslySkipPermissions(["node", "x", "--force"])).toThrow(/forbidden|Permission/);
  });

  test("allowDangerouslySkipPermissions returns false when clean", () => {
    const prev = process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS;
    delete process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS;
    expect(allowDangerouslySkipPermissions(["node", "script.mjs"])).toBe(false);
    if (prev !== undefined) process.env.AGY_DANGEROUSLY_SKIP_PERMISSIONS = prev;
  });
});

describe("buildCursorAgentArgs", () => {
  test("builds print-mode argv without bypass flags", () => {
    const args = buildCursorAgentArgs({
      model: LEGACY_AGY_MODEL,
      prompt: "run prospect-tool only",
      workspace: root,
    });
    expect(args[0]).toBe("--print");
    expect(args).toContain("--model");
    expect(args).toContain(LEGACY_AGY_MODEL);
    expect(args).toContain("--workspace");
    expect(args).toContain("--trust");
    expect(args.at(-1)).toBe("run prospect-tool only");
    expect(args).not.toContain("--force");
    expect(args).not.toContain("--yolo");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("agy");
  });
});

describe("detectUnsupportedModelMessage", () => {
  test("returns note when CLI rejects model id", () => {
    const note = detectUnsupportedModelMessage(
      `Error: Unknown model ${LEGACY_AGY_MODEL}`,
      LEGACY_AGY_MODEL,
    );
    expect(note).toMatch(/unsupported|Ivan|model/i);
  });

  test("null when no model error", () => {
    expect(detectUnsupportedModelMessage("ok done", LEGACY_AGY_MODEL)).toBeNull();
  });
});

describe("CURSOR_API_KEY presence gate", () => {
  test("requireCursorApiKey throws when absent", () => {
    const prev = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    expect(isCursorApiKeyPresent()).toBe(false);
    expect(() => requireCursorApiKey()).toThrow(/CURSOR_API_KEY/);
    if (prev !== undefined) process.env.CURSOR_API_KEY = prev;
  });
});

describe("run-outreach-wave fail-closed", () => {
  test("--help mentions Cursor Agent and refuses bypass wording", () => {
    const r = spawnSync(process.execPath, ["scripts/run-outreach-wave.mjs", "--help"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("draft_only");
    expect(r.stdout).toMatch(/Cursor Agent|CURSOR_API_KEY/);
    expect(r.stdout).not.toMatch(/Opt-in AGY permission bypass/);
  });

  test("refuses --dangerously-skip-permissions", () => {
    const env = {
      ...process.env,
      AGENTSDR_URL: "https://sdr.linktion.cn",
      AGENTSDR_API_KEY: "test-not-real",
      CURSOR_API_KEY: "test-not-real",
      EXA_API_KEY: "test-not-real",
    };
    const r = spawnSync(
      process.execPath,
      ["scripts/run-outreach-wave.mjs", "--target", "1", "--dangerously-skip-permissions"],
      { cwd: root, encoding: "utf8", env },
    );
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/forbidden|Permission|dangerously-skip-permissions|force/i);
  });

  test("exits 1 when CURSOR_API_KEY missing (after AgentSDR env ok)", () => {
    const env = {
      ...process.env,
      AGENTSDR_URL: "https://sdr.linktion.cn",
      AGENTSDR_API_KEY: "test-not-real",
      EXA_API_KEY: "test-not-real",
    };
    delete env.CURSOR_API_KEY;
    const r = spawnSync(process.execPath, ["scripts/run-outreach-wave.mjs", "--target", "1", "--delivery", "draft_only"], {
      cwd: root,
      encoding: "utf8",
      env,
    });
    expect(r.status).toBe(1);
    expect(r.stderr + r.stdout).toMatch(/CURSOR_API_KEY/);
  });
});
