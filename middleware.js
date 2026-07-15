import { next } from "@vercel/edge";

export const config = {
  matcher: "/:path*",
};

export default function middleware(request) {
  const url = new URL(request.url);

  const maintenanceMode = process.env.MAINTENANCE_MODE === "true";
  const bypassKey = process.env.MAINTENANCE_BYPASS_KEY || "";

  // Maintenance off → continue normally (do NOT fetch(request) — that breaks Edge)
  if (!maintenanceMode) {
    return next();
  }

  const keyFromUrl = url.searchParams.get("key");
  const cookies = request.headers.get("cookie") || "";
  const hasBypassCookie = cookies.includes("maint_bypass=1");

  // Always allow static/API/maintenance assets
  if (
    url.pathname === "/maintenance.html" ||
    url.pathname === "/favicon.ico" ||
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/.well-known/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/src/") ||
    url.pathname === "/contracts-config.js" ||
    url.pathname === "/index.html"
  ) {
    return next();
  }

  if (hasBypassCookie) {
    return next();
  }

  if (bypassKey && keyFromUrl === bypassKey) {
    const cleanUrl = new URL(request.url);
    cleanUrl.searchParams.delete("key");
    return new Response(null, {
      status: 302,
      headers: {
        Location: cleanUrl.toString(),
        "Set-Cookie":
          "maint_bypass=1; Path=/; Max-Age=7200; HttpOnly; Secure; SameSite=Lax",
      },
    });
  }

  return Response.redirect(new URL("/maintenance.html", request.url), 307);
}
