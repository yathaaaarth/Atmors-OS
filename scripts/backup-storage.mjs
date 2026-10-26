// Download every object in the client-assets bucket into a local folder, for
// the encrypted backup workflow (.github/workflows/backup.yml). Uses the
// secret key, so it only runs in CI with repository secrets; the output is
// encrypted before it leaves the runner.
//
// Usage: node scripts/backup-storage.mjs <output-dir>
// Env: BACKUP_SUPABASE_URL, BACKUP_SUPABASE_SECRET_KEY

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";

const BUCKET = "client-assets";
const PAGE = 1000;

const baseUrl = process.env.BACKUP_SUPABASE_URL?.replace(/\/$/, "");
const key = process.env.BACKUP_SUPABASE_SECRET_KEY;
const outDir = process.argv[2];
if (!baseUrl || !key || !outDir) {
  console.error("BACKUP_SUPABASE_URL, BACKUP_SUPABASE_SECRET_KEY and an output directory are required.");
  process.exit(2);
}
const headers = { authorization: `Bearer ${key}`, apikey: key };

async function list(prefix) {
  const entries = [];
  for (let offset = 0; ; offset += PAGE) {
    const response = await fetch(`${baseUrl}/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ prefix, limit: PAGE, offset, sortBy: { column: "name", order: "asc" } }),
    });
    if (!response.ok) throw new Error(`list ${prefix || "/"}: HTTP ${response.status}`);
    const page = await response.json();
    entries.push(...page);
    if (page.length < PAGE) return entries;
  }
}

async function walk(prefix, files) {
  for (const entry of await list(prefix)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    // Folders have no id in the listing.
    if (entry.id === null) await walk(path, files);
    else files.push(path);
  }
  return files;
}

const files = await walk("", []);
let bytes = 0;
for (const path of files) {
  const target = normalize(join(outDir, path));
  if (!target.startsWith(normalize(outDir))) throw new Error(`refusing path outside the output folder: ${path}`);
  const response = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${path.split("/").map(encodeURIComponent).join("/")}`, { headers });
  if (!response.ok) throw new Error(`download ${path}: HTTP ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, body);
  bytes += body.length;
}
console.log(`Backed up ${files.length} files (${(bytes / 1024 / 1024).toFixed(1)} MiB) from ${BUCKET}.`);
