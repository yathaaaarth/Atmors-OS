import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Secret scanning over every tracked file (threat model T7). Runs in CI with
 * the unit tests, so a committed key fails the build before it is pushed.
 */
const PATTERNS: [string, RegExp][] = [
  ["Supabase secret key", /sb_secret_[A-Za-z0-9_-]{20,}/],
  ["Supabase publishable key", /sb_publishable_[A-Za-z0-9_-]{20,}/],
  ["Supabase JWT", /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJpc3MiOiJzdXBhYmFzZSI/],
  ["Anthropic API key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["Razorpay live key", /rzp_live_[A-Za-z0-9]{10,}/],
  ["Resend API key", /re_[A-Za-z0-9]{24,}/],
  ["Private key", /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/],
];

describe("repository secret scan", () => {
  it("finds no credentials in tracked files", () => {
    const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const findings: string[] = [];
    for (const file of files) {
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i.test(file) || file === "package-lock.json") continue;
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      for (const [name, pattern] of PATTERNS) if (pattern.test(text)) findings.push(`${file}: ${name}`);
    }
    expect(findings).toEqual([]);
  });

  it("keeps local environment files and the confidential PRD out of git", () => {
    const files = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n");
    expect(files.filter((file) => /^\.env(?!\.example$)/.test(file) || /\.pdf$/i.test(file))).toEqual([]);
  });
});
