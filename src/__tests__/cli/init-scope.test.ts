/**
 * TDD — `memory init` scope resolution (src/cli/init.ts → resolveScope).
 *
 * Regression: `memory init --project` SILENTLY ran user scope and skipped the
 * project `.mcp.json` registration, because scope resolution only honored
 * `--scope project` and ignored the (very natural) `--project` flag. This locks
 * `--project` as a true alias for `--scope project`.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveScope } from "../../cli/init.js";

describe("resolveScope", () => {
  it("--scope project → project", () => {
    expect(resolveScope(["node", "init", "--scope", "project"])).toBe("project");
  });

  it("--scope user → user", () => {
    expect(resolveScope(["node", "init", "--scope", "user"])).toBe("user");
  });

  it("no flag defaults to user", () => {
    expect(resolveScope(["node", "init"])).toBe("user");
  });

  it("--project is an alias for --scope project (the regression)", () => {
    expect(resolveScope(["node", "init", "--project"])).toBe("project");
  });

  it("--project wins over an explicit --scope user (explicit project intent)", () => {
    expect(resolveScope(["node", "init", "--project", "--scope", "user"])).toBe("project");
  });

  it("an unknown --scope value falls back to user (with a warning)", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(resolveScope(["node", "init", "--scope", "bogus"])).toBe("user");
    spy.mockRestore();
  });
});
