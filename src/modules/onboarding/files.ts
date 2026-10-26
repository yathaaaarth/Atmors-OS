/**
 * Upload validation (PRD §5.7, §11, AT-022): size, allowed type, matching
 * extension and a content signature check. SVG and HTML are refused because
 * they can carry script.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

type Rule = { extensions: string[]; check: (bytes: Uint8Array) => boolean };

const startsWith = (bytes: Uint8Array, signature: number[], offset = 0) =>
  signature.every((value, index) => bytes[offset + index] === value);

const ZIP = (bytes: Uint8Array) => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);

/** Plain text: valid UTF-8 with no NUL bytes. */
function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export const ALLOWED_TYPES: Record<string, Rule> = {
  "image/png": { extensions: ["png"], check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  "image/jpeg": { extensions: ["jpg", "jpeg"], check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  "image/gif": { extensions: ["gif"], check: (b) => startsWith(b, [0x47, 0x49, 0x46, 0x38]) },
  "image/webp": { extensions: ["webp"], check: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8) },
  "application/pdf": { extensions: ["pdf"], check: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) },
  "text/plain": { extensions: ["txt", "md"], check: isText },
  "text/csv": { extensions: ["csv"], check: isText },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": { extensions: ["docx"], check: ZIP },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": { extensions: ["pptx"], check: ZIP },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": { extensions: ["xlsx"], check: ZIP },
};

export const ACCEPT_ATTRIBUTE = Object.entries(ALLOWED_TYPES)
  .flatMap(([type, rule]) => [type, ...rule.extensions.map((ext) => `.${ext}`)])
  .join(",");

export type FileCheck = { ok: true; contentType: string } | { ok: false; reason: string };

export function checkUpload(filename: string, declaredType: string, bytes: Uint8Array): FileCheck {
  if (bytes.byteLength === 0) return { ok: false, reason: "The file is empty." };
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return { ok: false, reason: "Files must be 10 MB or smaller." };
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  // Browsers report CSV and text inconsistently; trust the extension's rule, then verify content.
  const type =
    Object.entries(ALLOWED_TYPES).find(([candidate, rule]) => candidate === declaredType && rule.extensions.includes(extension))?.[0] ??
    Object.entries(ALLOWED_TYPES).find(([, rule]) => rule.extensions.includes(extension))?.[0];
  if (!type) return { ok: false, reason: "That file type isn't accepted. Use PDF, images, Office documents, text or CSV." };
  if (!ALLOWED_TYPES[type].check(bytes)) return { ok: false, reason: "The file's contents don't match its type." };
  return { ok: true, contentType: type };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
