/**
 * TDD — JSON-Schema → form model (web/src/lib/schema-form.ts).
 *
 * The Tools console renders a dynamic form for whatever tool the user picks, off
 * the JSON-Schema `inputSchema` the server returns in tools/list. These lock the
 * schema→fields mapping and the value coercion that builds the tool arguments.
 */
import { describe, it, expect } from "vitest"
import { toFormFields, coerceArgs } from "@/lib/schema-form"
import type { JsonSchema } from "@/api/mcp"

const schema: JsonSchema = {
  type: "object",
  properties: {
    content: { type: "string", description: "the fact" },
    importance: { type: "number", minimum: 0, maximum: 1 },
    dry_run: { type: "boolean", default: true },
    scope: { type: "string", enum: ["global", "project", "user"] },
    tags: { type: "array", items: { type: "string" } },
    metadata: { type: "object" },
  },
  required: ["content"],
}

describe("toFormFields", () => {
  it("maps each property to a typed field, preserving order", () => {
    const fields = toFormFields(schema)
    expect(fields.map((f) => f.name)).toEqual([
      "content", "importance", "dry_run", "scope", "tags", "metadata",
    ])
    expect(fields.map((f) => f.kind)).toEqual([
      "string", "number", "boolean", "enum", "array", "object",
    ])
  })

  it("marks required fields and carries enum values + description + default", () => {
    const fields = toFormFields(schema)
    const by = Object.fromEntries(fields.map((f) => [f.name, f]))
    expect(by.content.required).toBe(true)
    expect(by.importance.required).toBe(false)
    expect(by.content.description).toBe("the fact")
    expect(by.scope.enumValues).toEqual(["global", "project", "user"])
    expect(by.dry_run.default).toBe(true)
  })

  it("treats integer as a number field and an empty/!object schema as no fields", () => {
    expect(toFormFields({ type: "object", properties: { n: { type: "integer" } } })[0].kind).toBe("number")
    expect(toFormFields({ type: "object" })).toEqual([])
    expect(toFormFields({})).toEqual([])
  })
})

describe("coerceArgs", () => {
  const fields = toFormFields(schema)

  it("omits empty optional fields and coerces types", () => {
    const args = coerceArgs(fields, {
      content: "a durable fact",
      importance: "0.8",
      dry_run: false,
      scope: "project",
      tags: "infra, api\nsecurity",
      metadata: "",
    })
    expect(args).toEqual({
      content: "a durable fact",
      importance: 0.8,
      dry_run: false,
      scope: "project",
      tags: ["infra", "api", "security"],
    })
  })

  it("parses a JSON object field and throws a clear error on invalid JSON", () => {
    expect(coerceArgs(fields, { content: "x", metadata: '{"k":1}' }).metadata).toEqual({ k: 1 })
    expect(() => coerceArgs(fields, { content: "x", metadata: "{not json" })).toThrow(/metadata/)
  })

  it("drops a number field that is blank rather than sending NaN", () => {
    const args = coerceArgs(fields, { content: "x", importance: "" })
    expect("importance" in args).toBe(false)
  })

  it("omits a blank required field (the server's schema reports the violation)", () => {
    const args = coerceArgs(fields, { content: "" })
    expect("content" in args).toBe(false)
  })
})
