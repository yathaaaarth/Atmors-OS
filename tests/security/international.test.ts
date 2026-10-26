/**
 * International billing and the built-in signer against the hosted dev
 * Supabase project: who can read and change seller/bank details, that signing
 * codes are unreadable, and that the client-facing RPCs refuse anonymous
 * callers and other people's records. The full flows run on PGlite in
 * tests/db/international-signing.test.ts.
 */
import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import {
  adminClient,
  anonClient,
  ensureMembership,
  ensureOrganization,
  ensureProspect,
  ensureUser,
  hasSupabaseTestEnv,
  signedInClient,
  type TypedClient,
} from "../support/supabase-fixture";

const EMAIL = {
  ceo: "intl-ceo+clientos@example.com",
  sales: "intl-sales+clientos@example.com",
  delivery: "intl-delivery+clientos@example.com",
  client: "intl-client+clientos@example.com",
};
type Who = keyof typeof EMAIL;
const corr = () => randomUUID();
const HASH = "a".repeat(64);

describe.skipIf(!hasSupabaseTestEnv)("International billing and built-in signing (hosted)", () => {
  const admin = hasSupabaseTestEnv ? adminClient() : (undefined as unknown as TypedClient);
  let c: Record<Who, TypedClient>;
  let orgId: string;

  beforeAll(async () => {
    const users = {} as Record<Who, string>;
    for (const who of Object.keys(EMAIL) as Who[]) users[who] = await ensureUser(admin, EMAIL[who], `Intl ${who}`);
    orgId = await ensureOrganization(admin, "intl-fixture", "International Fixture Org");
    await ensureMembership(admin, orgId, users.ceo, "ceo");
    await ensureMembership(admin, orgId, users.sales, "sales");
    await ensureMembership(admin, orgId, users.delivery, "delivery");
    await ensureProspect(admin, orgId, users.sales, EMAIL.client, "Intl Client");
    c = {} as Record<Who, TypedClient>;
    for (const who of Object.keys(EMAIL) as Who[]) c[who] = await signedInClient(EMAIL[who]);
  });

  it("lets billing managers save invoice details and nobody else", async () => {
    const fields = { legal_name: "Atmors Private Limited", gstin: "29ABCDE1234F1Z5", bank_instructions: "SWIFT HDFCINBB" };
    const saved = await c.ceo.rpc("save_billing_settings", { p_organization_id: orgId, p_fields: fields, p_correlation_id: corr() });
    expect(saved.error).toBeNull();
    for (const who of ["sales", "delivery", "client"] as const) {
      const denied = await c[who].rpc("save_billing_settings", { p_organization_id: orgId, p_fields: fields, p_correlation_id: corr() });
      expect(denied.error?.message, who).toBe("FORBIDDEN");
    }
    const anon = await anonClient().rpc("save_billing_settings", { p_organization_id: orgId, p_fields: fields, p_correlation_id: corr() });
    expect(anon.error).not.toBeNull();
    // Direct writes are never allowed, even for the CEO.
    const direct = await c.ceo.from("billing_settings").update({ bank_instructions: "changed" }).eq("organization_id", orgId).select();
    expect(direct.error !== null || (direct.data ?? []).length === 0).toBe(true);
  });

  it("shows invoice details only to finance readers", async () => {
    const own = await c.ceo.from("billing_settings").select("legal_name").eq("organization_id", orgId);
    expect(own.data).toHaveLength(1);
    for (const who of ["delivery", "client"] as const) {
      const hidden = await c[who].from("billing_settings").select("legal_name").eq("organization_id", orgId);
      expect(hidden.data ?? [], who).toHaveLength(0);
    }
    const anon = await anonClient().from("billing_settings").select("legal_name");
    expect(anon.data ?? []).toHaveLength(0);
  });

  it("never exposes signing codes, even to the CEO", async () => {
    for (const client of [c.ceo, c.client, anonClient()]) {
      const result = await client.from("signature_challenges").select("code_hash");
      expect(result.error !== null || (result.data ?? []).length === 0).toBe(true);
    }
  });

  it("answers unknown or foreign records with NOT_FOUND and refuses anonymous callers", async () => {
    const transfer = await c.client.rpc("client_report_transfer", {
      p_invoice_id: randomUUID(), p_reference: "WIRE-1", p_note: null as unknown as string, p_correlation_id: corr(),
    });
    expect(transfer.error?.message).toBe("NOT_FOUND");
    const begin = await c.client.rpc("begin_internal_signature", {
      p_contract_id: randomUUID(), p_checksum: HASH, p_code_hash: HASH, p_correlation_id: corr(),
    });
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(begin.error?.message);
    const complete = await c.client.rpc("complete_internal_signature", {
      p_contract_id: randomUUID(), p_checksum: HASH, p_code_hash: HASH, p_typed_name: "Intl Client", p_evidence: {}, p_correlation_id: corr(),
    });
    expect(["NOT_FOUND", "FORBIDDEN"]).toContain(complete.error?.message);

    for (const [fn, args] of [
      ["client_report_transfer", { p_invoice_id: randomUUID(), p_reference: "WIRE-1", p_correlation_id: corr() }],
      ["begin_internal_signature", { p_contract_id: randomUUID(), p_checksum: HASH, p_code_hash: HASH, p_correlation_id: corr() }],
    ] as const) {
      const result = await anonClient().rpc(fn as "client_report_transfer", args as never);
      expect(result.error, fn).not.toBeNull();
    }
  });
});
