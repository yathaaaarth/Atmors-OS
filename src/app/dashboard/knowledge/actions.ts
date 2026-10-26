"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { assertCan } from "@/server/authorization/permissions";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

const docSchema = z.object({
  id: z.uuid().optional(),
  title: z.string().trim().min(1, "Add a title.").max(200),
  body: z.string().trim().min(1, "Write the content.").max(20000),
  audience: z.enum(["client", "internal"]),
});

export async function saveKnowledge(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("knowledge.save", async (correlationId) => {
    const context = await requireMemberContext();
    assertCan(context, "knowledge.manage");
    const values = parseInput(docSchema, formObject(formData, ["id", "title", "body", "audience"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_knowledge_document", {
      p_organization_id: context.organizationId,
      p_id: (values.id ?? null) as string,
      p_title: values.title,
      p_body: values.body,
      p_audience: values.audience,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/knowledge");
    return null;
  });
}

const statusSchema = z.object({ id: z.uuid(), status: z.enum(["approved", "retired", "draft"]) });

export async function setKnowledgeStatus(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("knowledge.status", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(statusSchema, formObject(formData, ["id", "status"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_knowledge_status", { p_id: values.id, p_status: values.status, p_correlation_id: correlationId });
    if (error) throw fromPostgrestError(error);
    revalidatePath("/dashboard/knowledge");
    return null;
  });
}
