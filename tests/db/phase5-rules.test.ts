/**
 * Phase 5 SQL rules on PGlite: conversation logging cannot be hijacked,
 * proposed actions are decided once by their own actor (AT-029), logs are
 * append-only, and approved knowledge never crosses organizations (AT-028).
 */
import { createHash } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { migratedDatabase } from "../support/pglite-db";

type Db = Awaited<ReturnType<typeof migratedDatabase>>;

describe("Phase 5 SQL rules (PGlite)", () => {
  let d: Db;
  const u: Record<string, string> = {};
  let orgA: string;
  let orgB: string;
  let prospect: string;

  async function one<T extends Record<string, unknown>>(user: string | null, sql: string, params: unknown[] = []): Promise<T> {
    const [row] = await d.as<T>(user, sql, params);
    return row;
  }

  const record = (payload: Record<string, unknown>) =>
    one<{ r: { conversation_id: string; action_ids: string[] } }>(null, `select ai_record_exchange($1::jsonb) as r`, [
      JSON.stringify({ assistant: "sales", actor_type: "client", question: "q", answer: "a", validation_status: "ok", correlation_id: "c", ...payload }),
    ]);

  beforeAll(async () => {
    d = await migratedDatabase();
    for (const name of ["ceo", "sales", "delivery", "ceoB"]) {
      ({ id: u[name] } = await one<{ id: string }>(null, `insert into auth.users (email) values ($1) returning id`, [`${name}@atmors.test`]));
    }
    ({ id: orgA } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('A', 'org-a') returning id`));
    ({ id: orgB } = await one<{ id: string }>(null, `insert into organizations (name, slug) values ('B', 'org-b') returning id`));
    await d.as(null, `insert into organization_memberships (organization_id, user_id, role) values ($1, $2, 'ceo'), ($1, $3, 'sales'), ($1, $4, 'delivery'), ($5, $6, 'ceo')`, [
      orgA, u.ceo, u.sales, u.delivery, orgB, u.ceoB,
    ]);
    ({ id: prospect } = await one<{ id: string }>(u.sales, `select id from create_prospect($1, $2, 'P', null, 'p@x.test', 'email', null, null, null, null, null, 'c')`, [
      orgA, u.sales,
    ]));
  });

  it("never continues another actor's conversation", async () => {
    const first = await record({ organization_id: orgA, actor_key: "tok:aaa" });
    const again = await record({ organization_id: orgA, actor_key: "tok:aaa", conversation_id: first.r.conversation_id });
    expect(again.r.conversation_id).toBe(first.r.conversation_id);
    const hijack = await record({ organization_id: orgA, actor_key: "tok:bbb", conversation_id: first.r.conversation_id });
    expect(hijack.r.conversation_id).not.toBe(first.r.conversation_id);
    expect(await d.errorOf(null, `update ai_messages set content = 'edited'`)).toBe("APPEND_ONLY");
  });

  it("AT-029: a proposed action is decided once, only by its own actor", async () => {
    const { r } = await record({
      organization_id: orgA,
      actor_key: "user:sales",
      actions: [{ tool_name: "propose_task", arguments: { title: "Call back" } }, { tool_name: "draft_follow_up", arguments: { draft: "Hi" } }],
    });
    const [taskAction, draftAction] = r.action_ids;
    const { human_confirmation } = await one<{ human_confirmation: string }>(null, `select human_confirmation from ai_tool_events where id = $1`, [draftAction]);
    expect(human_confirmation).toBe("not_required"); // drafts are never sent by the system
    expect(await d.errorOf(null, `select ai_resolve_action($1, 'user:someone-else', 'confirmed', '{}'::jsonb, null)`, [taskAction])).toBe("NOT_FOUND");
    expect(await d.errorOf(null, `select ai_resolve_action($1, 'user:sales', 'confirmed', '{}'::jsonb, null)`, [taskAction])).toBeNull();
    expect(await d.errorOf(null, `select ai_resolve_action($1, 'user:sales', 'rejected', '{}'::jsonb, null)`, [taskAction])).toBe("INVALID_STATE_TRANSITION");
    expect(await d.errorOf(null, `update ai_tool_events set proposed_arguments = '{"title": "x"}' where id = $1`, [taskAction])).toBe("APPEND_ONLY");
    expect(await d.errorOf(null, `select ai_record_exchange($1::jsonb)`, [
      JSON.stringify({ organization_id: orgA, assistant: "sales", actor_type: "client", actor_key: "k", correlation_id: "c", actions: [{ tool_name: "change_price" }] }),
    ])).not.toBeNull();
  });

  it("AT-028: approved client knowledge stays within its organization", async () => {
    const doc = await one<{ id: string }>(u.ceo, `select * from save_knowledge_document($1, null, 'Payments', 'Pay by UPI', 'client', 'c')`, [orgA]);
    await one(u.ceoB, `select * from save_knowledge_document($1, null, 'B secret FAQ', 'Org B only', 'client', 'c')`, [orgB]);
    const token = createHash("sha256").update("kb-token").digest("hex");
    await d.as(u.sales, `select create_invitation($1, null, $2, 14, 'c')`, [prospect, token]);
    expect((await one<{ k: unknown[] }>(null, `select client_knowledge($1) as k`, [token])).k).toEqual([]); // drafts are not served
    await d.as(u.ceo, `select set_knowledge_status($1, 'approved', 'c')`, [doc.id]);
    const { k } = await one<{ k: { title: string }[] }>(null, `select client_knowledge($1) as k`, [token]);
    expect(k.map((item) => item.title)).toEqual(["Payments"]);
    expect((await one<{ k: unknown[] }>(null, `select client_knowledge($1) as k`, ["0".repeat(64)])).k).toEqual([]);
    expect(await d.errorOf(u.sales, `select save_knowledge_document($1, null, 'x', 'y', 'client', 'c')`, [orgA])).toBe("FORBIDDEN");
    expect(await d.errorOf(u.ceoB, `select set_knowledge_status($1, 'retired', 'c')`, [doc.id])).toBe("FORBIDDEN");
  });

  it("copilot-confirmed tasks re-check that the member can read the prospect", async () => {
    expect(await d.errorOf(u.delivery, `select create_ops_task_for_prospect($1, 'Call the client', 'from copilot', 'c')`, [prospect])).toBe("FORBIDDEN");
    expect(await d.errorOf(u.ceoB, `select create_ops_task_for_prospect($1, 'Call the client', 'from copilot', 'c')`, [prospect])).toBe("FORBIDDEN");
    expect(await d.errorOf(u.sales, `select create_ops_task_for_prospect($1, 'Call the client', 'from copilot', 'c')`, [prospect])).toBeNull();
    expect(await d.errorOf(u.sales, `select save_onboarding_ai_note(gen_random_uuid(), gen_random_uuid(), '{}'::jsonb, 'local', 'x', 'c')`)).toBe("FORBIDDEN");
  });
});
