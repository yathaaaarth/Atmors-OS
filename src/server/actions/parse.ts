import type { z } from "zod";

import { fromZodError } from "@/server/errors";

/** Validate action input; server validation is authoritative. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success) throw fromZodError(result.error);
  return result.data;
}
