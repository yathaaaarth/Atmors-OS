"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { formObject } from "@/server/actions/form-data";
import { parseInput } from "@/server/actions/parse";
import { runAction, type ActionResult } from "@/server/actions/result";
import { requireMemberContext } from "@/server/authorization/member-context";
import { fromPostgrestError } from "@/server/errors";
import { createSupabaseServerClient } from "@/server/supabase/server";

function revalidateWorkspace(workspaceId: string) {
  revalidatePath(`/dashboard/workspaces/${workspaceId}`);
  revalidatePath("/dashboard/workspaces");
  revalidatePath("/dashboard");
}

/** "2026-11-01" from a date input becomes end of that day in India time. */
function dueFrom(value: string | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T18:00:00+05:30`).toISOString() : value;
}

const workspaceIdSchema = z.object({ workspaceId: z.uuid() });

const memberSchema = workspaceIdSchema.extend({ userId: z.uuid(), role: z.enum(["lead", "member", "remove"]) });

export async function setWorkspaceMember(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.member", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(memberSchema, formObject(formData, ["workspaceId", "userId", "role"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_workspace_member", {
      p_workspace_id: values.workspaceId,
      p_user_id: values.userId,
      p_role: values.role,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

const reasonSchema = workspaceIdSchema.extend({ reason: z.string().trim().min(3, "Give a reason (audited).").max(2000) });

/** AT-026: manual activation, with permission and reason; visibly marked afterwards. */
export async function overrideActivation(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.override", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(reasonSchema, formObject(formData, ["workspaceId", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("override_workspace_activation", {
      p_workspace_id: values.workspaceId,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

const transitionSchema = reasonSchema.extend({ to: z.enum(["suspended", "closed", "blocked"]) });

export async function transitionWorkspace(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.transition", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(transitionSchema, formObject(formData, ["workspaceId", "reason", "to"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("transition_workspace", {
      p_workspace_id: values.workspaceId,
      p_to: values.to,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

const deliverySchema = workspaceIdSchema.extend({
  to: z.enum(["in_progress", "paused", "completed"]),
  reason: z.string().trim().max(2000).optional(),
});

export async function setDeliveryStatus(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.delivery_status", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(deliverySchema, formObject(formData, ["workspaceId", "to", "reason"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_delivery_status", {
      p_workspace_id: values.workspaceId,
      p_to: values.to,
      p_reason: values.reason,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

export async function evaluateWorkspace(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.evaluate", async (correlationId) => {
    await requireMemberContext();
    const { workspaceId } = parseInput(workspaceIdSchema, formObject(formData, ["workspaceId"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("evaluate_workspace", { p_workspace_id: workspaceId, p_correlation_id: correlationId });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(workspaceId);
    return null;
  });
}

const milestoneSchema = workspaceIdSchema.extend({
  milestoneId: z.uuid().optional(),
  title: z.string().trim().min(1, "Add a title.").max(200),
  description: z.string().trim().max(4000).optional(),
  dueDate: z.string().optional(),
  status: z.enum(["planned", "in_progress", "done", "cancelled"]).default("planned"),
});

export async function saveMilestone(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("milestone.save", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(milestoneSchema, formObject(formData, ["workspaceId", "milestoneId", "title", "description", "dueDate", "status"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_milestone", {
      p_workspace_id: values.workspaceId,
      p_milestone_id: (values.milestoneId ?? null) as string,
      p_fields: {
        title: values.title,
        description: values.description ?? "",
        due_at: dueFrom(values.dueDate) ?? "",
        status: values.status,
        client_visible: formData.get("clientVisible") === "on",
      },
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

const taskSchema = workspaceIdSchema.extend({
  taskId: z.uuid().optional(),
  title: z.string().trim().min(1, "Add a title.").max(200),
  description: z.string().trim().max(4000).optional(),
  internalNotes: z.string().trim().max(4000).optional(),
  ownerId: z.uuid().optional(),
  milestoneId: z.uuid().optional(),
  dependencyId: z.uuid().optional(),
  dueDate: z.string().optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
});

export async function saveTask(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("task.save", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(
      taskSchema,
      formObject(formData, ["workspaceId", "taskId", "title", "description", "internalNotes", "ownerId", "milestoneId", "dependencyId", "dueDate", "priority"]),
    );
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_task", {
      p_workspace_id: values.workspaceId,
      p_task_id: (values.taskId ?? null) as string,
      p_fields: {
        title: values.title,
        description: values.description ?? "",
        internal_notes: values.internalNotes ?? "",
        owner_user_id: values.ownerId ?? "",
        milestone_id: values.milestoneId ?? "",
        dependency_id: values.dependencyId ?? "",
        due_at: dueFrom(values.dueDate) ?? "",
        priority: values.priority,
        client_visible: formData.get("clientVisible") === "on",
      },
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}

const taskStatusSchema = workspaceIdSchema.extend({
  taskId: z.uuid(),
  status: z.enum(["todo", "in_progress", "blocked", "done", "cancelled"]),
  evidence: z.string().trim().max(2000).optional(),
});

export async function updateTaskStatus(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("task.status", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(taskStatusSchema, formObject(formData, ["workspaceId", "taskId", "status", "evidence"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_task_status", {
      p_task_id: values.taskId,
      p_status: values.status,
      p_evidence: values.evidence,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    revalidatePath("/dashboard");
    return null;
  });
}

const updateSchema = workspaceIdSchema.extend({
  visibility: z.enum(["client", "internal"]),
  body: z.string().trim().min(1, "Write an update.").max(4000),
});

export async function postWorkspaceUpdate(_: unknown, formData: FormData): Promise<ActionResult<null>> {
  return runAction("workspace.update", async (correlationId) => {
    await requireMemberContext();
    const values = parseInput(updateSchema, formObject(formData, ["workspaceId", "visibility", "body"]));
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("post_workspace_update", {
      p_workspace_id: values.workspaceId,
      p_visibility: values.visibility,
      p_body: values.body,
      p_correlation_id: correlationId,
    });
    if (error) throw fromPostgrestError(error);
    revalidateWorkspace(values.workspaceId);
    return null;
  });
}
