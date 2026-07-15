/**
 * Lightweight Edge middleware (no external imports).
 * Maintenance mode only — pass-through when off.
 */
export const config = {
  matcher: [
    /*
      Skip static assets & API so middleware never blocks them.
    */
    "/((?!api/|assets/|src/|\\.well-known/|favicon\\.ico|contracts-config\\.js|maintenance\\.html).*)",
  ],
};

export default function middleware(request) {
  const maintenanceMode = process.env.MAINTENANCE_MODE === "true";
  if (!maintenanceMode) {
    // Pass through: returning nothing / empty continues on some runtimes.
    // Safest portable approach: rewrite to same path via Response that doesn't re-fetch.
    return;
  }

  const url = new URL(request.url);
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || "";
  const keyFromUrl = url.searchParams.get("key");
  const cookies = request.headers.get("cookie") || "";
  const hasBypassCookie = cookies.includes("maint_bypass=1");

  if (hasBypassCookie) return;

  if (bypassKey && keyFromUrl === bypassKey) {
    const cleanUrl = new URL(request.url);
    cleanUrl.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: cleanUrl.pathname + cleanUrl.search,
        "Set-Cookie":
          "maint_bypass=1; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax",
      },
    });
  }

  return Response.redirect(new URL("/maintenance.html", request.url), 307);
}
