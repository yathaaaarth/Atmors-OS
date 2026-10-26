"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ACCEPT_ATTRIBUTE, MAX_UPLOAD_BYTES } from "@/modules/onboarding/files";

/** Uploads one file at a time to /api/assets; the server validates and stores it privately. */
export function AssetUploader() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  async function upload(form: HTMLFormElement) {
    const file = (form.elements.namedItem("file") as HTMLInputElement).files?.[0];
    if (!file) return setMessage({ kind: "error", text: "Choose a file first." });
    if (file.size > MAX_UPLOAD_BYTES) return setMessage({ kind: "error", text: "Files must be 10 MB or smaller." });
    setBusy(true);
    setMessage(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const response = await fetch("/api/assets", { method: "POST", body });
      const json = (await response.json()) as { error?: { message: string } };
      if (!response.ok) setMessage({ kind: "error", text: json.error?.message ?? "Upload failed." });
      else {
        setMessage({ kind: "ok", text: `Uploaded ${file.name}.` });
        form.reset();
        router.refresh();
      }
    } catch {
      setMessage({ kind: "error", text: "Upload failed. Check your connection and try again." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void upload(event.currentTarget);
      }}
      className="flex flex-wrap items-end gap-3"
    >
      <div className="space-y-1">
        <Label htmlFor="asset-file">Add a file (PDF, image, Office document, text or CSV; up to 10 MB)</Label>
        <input id="asset-file" name="file" type="file" accept={ACCEPT_ATTRIBUTE} className="block text-sm" />
      </div>
      <Button type="submit" variant="outline" disabled={busy}>
        {busy ? "Uploading…" : "Upload"}
      </Button>
      {message ? (
        <p role={message.kind === "error" ? "alert" : "status"} className={message.kind === "error" ? "w-full text-sm text-destructive" : "w-full text-sm text-success"}>
          {message.text}
        </p>
      ) : null}
    </form>
  );
}
