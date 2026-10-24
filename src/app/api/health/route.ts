import { handleRoute } from "@/server/http/route";

/** Liveness only; deliberately reveals nothing about configuration or data. */
export const GET = handleRoute(async () => ({ status: "ok" }));
