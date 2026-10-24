import "server-only";

export const INVITE_COOKIE = "clientos_invite";

/** Short-lived, httpOnly holder for the token between "verify email" and the magic-link return. */
export const INVITE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: 60 * 60,
};
