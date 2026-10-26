import { z } from "zod";

// Keywords structured outputs may not accept; validation still happens with Zod.
const UNSUPPORTED = new Set(["$schema", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "pattern", "format", "minItems", "maxItems", "default"]);

function clean(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(clean);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!UNSUPPORTED.has(key)) out[key] = clean(value);
  }
  if (out.type === "object") out.additionalProperties = false;
  return out;
}

/** A conservative JSON schema for a provider's structured-output mode. */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return clean(z.toJSONSchema(schema)) as Record<string, unknown>;
}
