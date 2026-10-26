import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { checkUpload } from "@/modules/onboarding/files";
import { AppError, fromPostgrestError } from "@/server/errors";
import { logger } from "@/server/logger";
import { createSupabaseAdminClient } from "@/server/supabase/admin";
import { createSupabaseServerClient } from "@/server/supabase/server";

export const ASSET_BUCKET = "client-assets";
const SIGNED_URL_SECONDS = 60;

const registeredSchema = z.object({ asset_id: z.uuid(), storage_key: z.string() });
const targetSchema = z.object({ storage_key: z.string(), filename: z.string(), content_type: z.string() });

/**
 * Validate the bytes, register the asset as the signed-in client (the
 * database checks access and quota), then store it privately with the system
 * identity. The bucket has no storage policies, so objects are never public.
 */
export async function uploadClientAsset(file: File, correlationId: string): Promise<{ assetId: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const check = checkUpload(file.name, file.type, bytes);
  if (!check.ok) throw new AppError("VALIDATION_FAILED", { message: check.reason });

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("client_register_asset", {
    p_filename: file.name.slice(0, 200),
    p_content_type: check.contentType,
    p_size_bytes: bytes.byteLength,
    p_checksum: createHash("sha256").update(bytes).digest("hex"),
    p_correlation_id: correlationId,
  });
  if (error) throw fromPostgrestError(error);
  const registered = registeredSchema.parse(data);

  const admin = createSupabaseAdminClient();
  const { error: uploadError } = await admin.storage
    .from(ASSET_BUCKET)
    .upload(registered.storage_key, bytes, { contentType: check.contentType, upsert: false });
  await admin.rpc("mark_asset_stored", { p_asset_id: registered.asset_id, p_ok: !uploadError });
  if (uploadError) {
    logger.error("asset.upload_failed", { correlation_id: correlationId, message: uploadError.message });
    throw new AppError("PROVIDER_UNAVAILABLE", { detail: "storage upload failed" });
  }
  return { assetId: registered.asset_id };
}

/** Authorize (and audit) a download, then return a short-lived signed URL. */
export async function assetDownloadUrl(assetId: string, correlationId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("asset_download_target", { p_asset_id: assetId, p_correlation_id: correlationId });
  if (error) throw fromPostgrestError(error);
  const target = targetSchema.parse(data);
  const { data: signed, error: signError } = await createSupabaseAdminClient()
    .storage.from(ASSET_BUCKET)
    .createSignedUrl(target.storage_key, SIGNED_URL_SECONDS, { download: target.filename });
  if (signError || !signed) throw new AppError("PROVIDER_UNAVAILABLE", { detail: "could not sign download URL" });
  return signed.signedUrl;
}
