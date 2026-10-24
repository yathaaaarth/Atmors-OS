import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(new URL("./tests/support/server-only-stub.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": src,
      "server-only": serverOnlyStub,
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: { name: "unit", include: ["tests/unit/**/*.test.ts"] },
      },
      {
        extends: true,
        // SQL rules on in-process Postgres (PGlite); no secrets needed.
        test: { name: "db", include: ["tests/db/**/*.test.ts"], testTimeout: 30_000, hookTimeout: 60_000 },
      },
      {
        extends: true,
        test: {
          name: "security",
          include: ["tests/security/**/*.test.ts"],
          // Runs against the hosted dev Supabase project; serial to keep fixtures predictable.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          setupFiles: ["tests/support/load-env.ts"],
        },
      },
    ],
  },
});
