/**
 * TDD — `memory init --remote <url>` (team / self-hosted HTTP setup).
 *
 * The default `memory init` registers a LOCAL stdio MCP server + local-DB hooks.
 * A team that points at one shared self-hosted server instead needs an HTTP MCP
 * registration in `.mcp.json` (per the official Claude Code MCP schema: type
 * "http", url, headers). These lock the URL normalization, the secure-by-default
 * env-var token reference, and the flag parsing.
 */
import { describe, it, expect } from "vitest";
import { buildRemoteMcpConfig, parseRemote } from "../../cli/init.js";

describe("buildRemoteMcpConfig", () => {
  it("produces an official http MCP entry (type/url/headers)", () => {
    const cfg = buildRemoteMcpConfig("https://memory.acme.dev") as {
      mcpServers: Record<string, { type: string; url: string; headers: Record<string, string> }>;
    };
    const srv = cfg.mcpServers["memory-server"];
    expect(srv.type).toBe("http");
    expect(srv.url).toBe("https://memory.acme.dev/mcp");
    expect(srv.headers.Authorization).toBe("Bearer ${MEMORY_MCP_TOKEN}");
  });

  it("appends /mcp only when missing and strips trailing slashes", () => {
    const u = (raw: string) =>
      (buildRemoteMcpConfig(raw) as { mcpServers: Record<string, { url: string }> }).mcpServers[
        "memory-server"
      ].url;
    expect(u("https://x.dev/")).toBe("https://x.dev/mcp");
    expect(u("https://x.dev/mcp")).toBe("https://x.dev/mcp");
    expect(u("https://x.dev/mcp/")).toBe("https://x.dev/mcp");
    expect(u("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100/mcp");
  });

  it("references a custom token env var when given (secure: token not inlined)", () => {
    const cfg = buildRemoteMcpConfig("https://x.dev", { tokenEnv: "ACME_TOKEN" }) as {
      mcpServers: Record<string, { headers: Record<string, string> }>;
    };
    expect(cfg.mcpServers["memory-server"].headers.Authorization).toBe("Bearer ${ACME_TOKEN}");
  });

  it("inlines a literal token only when explicitly provided", () => {
    const cfg = buildRemoteMcpConfig("https://x.dev", { token: "sek-123" }) as {
      mcpServers: Record<string, { headers: Record<string, string> }>;
    };
    expect(cfg.mcpServers["memory-server"].headers.Authorization).toBe("Bearer sek-123");
  });

  it("omits the auth header when explicitly unauthenticated", () => {
    const cfg = buildRemoteMcpConfig("https://x.dev", { noAuth: true }) as {
      mcpServers: Record<string, { headers?: Record<string, string> }>;
    };
    expect(cfg.mcpServers["memory-server"].headers).toBeUndefined();
  });
});

describe("parseRemote", () => {
  it("returns null without --remote", () => {
    expect(parseRemote(["node", "init"])).toBeNull();
    expect(parseRemote(["node", "init", "--project"])).toBeNull();
  });

  it("extracts the url", () => {
    expect(parseRemote(["node", "init", "--remote", "https://x.dev"])).toMatchObject({
      url: "https://x.dev",
    });
  });

  it("extracts --token-env and --token", () => {
    expect(parseRemote(["node", "init", "--remote", "https://x.dev", "--token-env", "T"])).toMatchObject(
      { url: "https://x.dev", tokenEnv: "T" },
    );
    expect(parseRemote(["node", "init", "--remote", "https://x.dev", "--token", "abc"])).toMatchObject(
      { url: "https://x.dev", token: "abc" },
    );
  });

  it("flags --no-auth", () => {
    expect(parseRemote(["node", "init", "--remote", "https://x.dev", "--no-auth"])).toMatchObject({
      url: "https://x.dev",
      noAuth: true,
    });
  });
});
