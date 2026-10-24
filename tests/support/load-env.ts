import { config } from "dotenv";

// Security tests read credentials for the dedicated dev/test Supabase project.
config({ path: ".env.test.local", quiet: true });
config({ path: ".env.local", quiet: true });
