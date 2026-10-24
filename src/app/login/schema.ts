import { z } from "zod";

export const signInSchema = z.object({
  email: z.email("Enter a valid email address.").max(320),
  next: z.string().max(2048).optional(),
});

export type SignInValues = z.infer<typeof signInSchema>;
