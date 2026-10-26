/**
 * Phase 5 against the hosted dev project: AI logs and proposed actions are
 * not readable or writable by clients, staff see only their own copilot
 * conversations unless they hold ai.monitor, and the logging RPCs are
 * service-role only (AT-028, AT-029).
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  ensureMembership,
  ensureOrganization,
  ensureUser,
  hasSupabaseTestEnv,
  signedInClient,
  type TypedClient,
} from "../support/supabase-fixture";

const EMAIL = {
  ceo: "p5-ceo+clientos@example.com",
  sales: "p5-sales+clientos@example.com",
  delivery: "p5-delivery+clientos@example.com",
  client: "p5-client+clientos@example.com",
};
type Who = keyof typeof EMAIL;

describe.skipIf(!hasSupabaseTestEnv)("Phase 5: AI data boundaries", () => {
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);
  let c: Record<Who, TypedClient>;
  let users: Record<Who, string>;
  let orgId: string;
  let salesConversation: string;

  beforeAll(async () => {
    users = {} as Record<Who, string>;
    for (const who of Object.keys(EMAIL) as Who[]) users[who] = await ensureUser(admin, EMAIL[who], `P5 ${who}`);
    orgId = await ensureOrganization(admin, "p5-fixture", "Phase 5 Fixture Org");
    await ensureMembership(admin, orgId, users.ceo, "ceo");
    await ensureMembership(admin, orgId, users.sales, "sales");
    await ensureMembership(admin, orgId, users.delivery, "delivery");
    c = {} as Record<Who, TypedClient>;
    for (const who of Object.keys(EMAIL) as Who[]) c[who] = await signedInClient(EMAIL[who]);
    const { data, error } = await admin.rpc("ai_record_exchange", {
      p_payload: {
        organization_id: orgId,
        assistant: "copilot",
        actor_type: "user",
        actor_user_id: users.sales,
        actor_key: `user:${users.sales}`,
        question: "Summarize",
        answer: "SECRET-COPILOT-ANSWER",
        validation_status: "ok",
        correlation_id: randomUUID(),
        actions: [{ tool_name: "propose_task", arguments: { title: "Call" } }],
      },
    });
    if (error) throw error;
    salesConversation = (data as { conversation_id: string }).conversation_id;
  });

  it("keeps copilot conversations to their owner and ai.monitor", async () => {
    const own = await c.sales.from("ai_messages").select("content").eq("conversation_id", salesConversation);
    expect(own.data?.map((row) => row.content)).toContain("SECRET-COPILOT-ANSWER");
    expect((await c.delivery.from("ai_messages").select("content").eq("conversation_id", salesConversation)).data ?? []).toHaveLength(0);
    expect((await c.ceo.from("ai_messages").select("content").eq("conversation_id", salesConversation)).data?.length).toBeGreaterThan(0);
    for (const table of ["ai_messages", "ai_conversations", "ai_tool_events", "onboarding_ai_notes", "knowledge_documents"] as const) {
      expect((await c.client.from(table).select("*").limit(1)).data ?? [], table).toHaveLength(0);
      expect((await anonClient().from(table).select("*").limit(1)).data ?? [], table).toHaveLength(0);
    }
  });

  it("allows only the system worker to log exchanges or decide actions", async () => {
    const payload = { organization_id: orgId, assistant: "sales", actor_type: "client", actor_key: "x", question: "q", answer: "forged", correlation_id: "c" };
    for (const client of [anonClient(), c.client, c.ceo]) {
      expect((await client.rpc("ai_record_exchange", { p_payload: payload })).error).not.toBeNull();
      expect((await client.rpc("ai_usage_today", { p_organization_id: orgId, p_actor_key: "x" })).error).not.toBeNull();
      expect(
        (await client.rpc("ai_resolve_action", { p_event_id: randomUUID(), p_actor_key: "x", p_decision: "confirmed", p_result: {}, p_confirmed_by: users.ceo })).error,
      ).not.toBeNull();
    }
    const insert = await c.sales.from("ai_tool_events").insert({ organization_id: orgId, conversation_id: salesConversation, tool_name: "propose_task", correlation_id: "c" });
    expect(insert.error).not.toBeNull();
  });

  it("serves no knowledge to unknown tokens or other organizations", async () => {
    expect((await anonClient().rpc("client_knowledge", { p_token_hash: "0".repeat(64) })).data).toEqual([]);
    expect((await c.client.rpc("client_knowledge", {})).data).toEqual([]);
  });
});
