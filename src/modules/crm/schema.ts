import { z } from "zod";

export const CONTACT_CHANNELS = ["email", "phone", "linkedin", "whatsapp", "other"] as const;
export const OUTREACH_CHANNELS = ["email", "phone", "linkedin", "whatsapp", "meeting", "other"] as const;
export const OUTREACH_DIRECTIONS = ["outbound", "inbound", "internal"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

/** `datetime-local` value interpreted in IST, the Atmors operating timezone. */
export const istDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use a valid date and time.")
  .transform((value) => new Date(`${value}:00+05:30`).toISOString());

export const prospectFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(200),
  company: optionalText(200),
  email: z
    .union([z.literal(""), z.email("Enter a valid email address.").max(320)])
    .optional()
    .transform((value) => (value ? value.toLowerCase() : undefined)),
  contact_channel: z.enum(CONTACT_CHANNELS),
  contact_handle: optionalText(320),
  source: optionalText(120),
  target_service: optionalText(120),
  notes: optionalText(10000),
  next_action_at: z.union([z.literal(""), istDateTime]).optional(),
  owner_user_id: z.uuid().optional(),
});

export type ProspectFormInput = z.input<typeof prospectFormSchema>;
export type ProspectFormValues = z.output<typeof prospectFormSchema>;

/** ISO timestamp -> `datetime-local` value in IST. */
export function toIstDateTimeLocal(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(new Date(iso).getTime() + 330 * 60_000);
  return date.toISOString().slice(0, 16);
}
