/**
 * Minimal Zod → JSON Schema converter for MCP tool parameter schemas.
 */

import { z } from "zod";

export function toJsonSchema(schema: z.ZodTypeAny): object {
  function c(s: z.ZodTypeAny): object {
    if (s instanceof z.ZodObject) {
      const properties: Record<string, object> = {};
      const required: string[] = [];
      for (const [k, v] of Object.entries(s.shape as Record<string, z.ZodTypeAny>)) {
        properties[k] = c(v as z.ZodTypeAny);
        if (!(v instanceof z.ZodOptional) && !(v instanceof z.ZodDefault)) required.push(k);
      }
      return { type: "object", properties, ...(required.length ? { required } : {}) };
    }
    const desc = (t: z.ZodTypeAny) => t._def.description ? { description: t._def.description } : {};
    if (s instanceof z.ZodArray)   return { type: "array", items: c(s.element), ...desc(s) };
    if (s instanceof z.ZodOptional) return c(s.unwrap());
    if (s instanceof z.ZodDefault)  return c(s._def.innerType);
    if (s instanceof z.ZodEffects)  return c(s._def.schema);
    if (s instanceof z.ZodEnum)     return { type: "string", enum: s.options, ...desc(s) };
    if (s instanceof z.ZodString)   return { type: "string", ...desc(s) };
    if (s instanceof z.ZodNumber)   return { type: "number", ...desc(s) };
    if (s instanceof z.ZodBoolean)  return { type: "boolean", ...desc(s) };
    return {};
  }
  return c(schema);
}
