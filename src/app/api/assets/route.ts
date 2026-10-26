import { AppError } from "@/server/errors";
import { requireSessionUser } from "@/server/auth/session";
import { assertSameOrigin, handleRoute } from "@/server/http/route";
import { uploadClientAsset } from "@/server/assets";
import { MAX_UPLOAD_BYTES } from "@/modules/onboarding/files";

/** Client asset upload (multipart, one file). Validated and stored privately (AT-022). */
export const POST = handleRoute(async ({ request, correlationId }) => {
  assertSameOrigin(request);
  await requireSessionUser();
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) throw new AppError("VALIDATION_FAILED", { message: "Files must be 10 MB or smaller." });

  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new AppError("VALIDATION_FAILED", { message: "Choose a file to upload." });
  const { assetId } = await uploadClientAsset(file, correlationId);
  return { asset_id: assetId };
});
