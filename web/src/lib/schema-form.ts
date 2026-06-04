/**
 * Turn a tool's JSON-Schema `inputSchema` (from MCP tools/list) into a flat list
 * of form fields, and coerce the form's raw values back into a typed arguments
 * object for tools/call. Deliberately shallow — one level of object properties,
 * which is what the memory tools' schemas use; nested objects are entered as raw
 * JSON via an "object" field.
 */
import type { JsonSchema } from "@/api/mcp"

export type FieldKind = "string" | "number" | "boolean" | "enum" | "array" | "object"

export interface FormField {
  name: string
  kind: FieldKind
  required: boolean
  description?: string
  enumValues?: string[]
  default?: unknown
}

function kindOf(schema: JsonSchema): FieldKind {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return "enum"
  switch (schema.type) {
    case "number":
    case "integer":
      return "number"
    case "boolean":
      return "boolean"
    case "array":
      return "array"
    case "object":
      return "object"
    default:
      return "string"
  }
}

export function toFormFields(schema: JsonSchema): FormField[] {
  const props = schema.properties
  if (!props || typeof props !== "object") return []
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.entries(props).map(([name, prop]) => {
    const field: FormField = {
      name,
      kind: kindOf(prop),
      required: required.has(name),
    }
    if (typeof prop.description === "string") field.description = prop.description
    if (Array.isArray(prop.enum)) field.enumValues = prop.enum.map(String)
    if (prop.default !== undefined) field.default = prop.default
    return field
  })
}

export type RawValue = string | boolean | undefined

/**
 * Build the tool arguments object from the form's raw values. Empty optional (and
 * empty required) string/number/array/object fields are omitted so the server's
 * Zod schema sees a clean object (and reports any genuinely-missing required arg
 * with its own precise message). Booleans are always included. Throws a
 * field-named error when an "object" field holds invalid JSON.
 */
export function coerceArgs(
  fields: FormField[],
  raw: Record<string, RawValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    const v = raw[field.name]
    switch (field.kind) {
      case "boolean":
        out[field.name] = Boolean(v)
        break
      case "number": {
        if (v === undefined || v === "") break
        const n = Number(v)
        if (!Number.isNaN(n)) out[field.name] = n
        break
      }
      case "array": {
        if (typeof v !== "string" || v.trim() === "") break
        const items = v
          .split(/[\n,]/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
        if (items.length > 0) out[field.name] = items
        break
      }
      case "object": {
        if (typeof v !== "string" || v.trim() === "") break
        try {
          out[field.name] = JSON.parse(v)
        } catch {
          throw new Error(`Field "${field.name}" must be valid JSON`)
        }
        break
      }
      default: {
        // string / enum
        if (typeof v === "string" && v !== "") out[field.name] = v
        break
      }
    }
  }
  return out
}
