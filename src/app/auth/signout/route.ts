import { NextResponse, type NextRequest } from "next/server";

import { createSupabaseServerClient } from "@/server/supabase/server";

// POST only, so a cross-site link or prefetch cannot sign someone out.
export async function POST(request: NextRequest) {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login?error=signed_out", request.nextUrl.origin), { status: 303 });
}
