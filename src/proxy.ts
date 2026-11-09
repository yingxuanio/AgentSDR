import { getSessionCookie } from "better-auth/cookies";
import { NextRequest, NextResponse } from "next/server";
import { migrationMutationBlockReason } from "@/lib/migration/controls";
import { DEMO_READ_ONLY_CODE, DEMO_READ_ONLY_MESSAGE, demoRequestBlock, isDemoMode } from "@/lib/demo/mode";

/**
 * Unauthenticated paths.
 *
 * The Unipile callbacks are listed individually rather than as an
 * "/api/webhooks" prefix on purpose: /api/webhooks/[id] also lives under
 * that prefix and returns raw stored webhook bodies to the UI, so a prefix
 * match would expose it to anyone.
 */
const PUBLIC = [
  // Signing in, up, back in, and joining — Better Auth's endpoints and pages.
  "/api/auth",
  "/login",
  "/sign-in",
  "/sign-up",
  // First-run setup of an empty instance; the page and route refuse once a user exists.
  "/setup",
  "/api/setup",
  "/forgot-password",
  "/reset-password",
  "/accept-invitation",
  "/api/outreach/tick",
  "/api/outreach/build-queue",
  "/api/outreach/webhooks",
  "/api/outreach/mailboxes/watch",
  "/unsubscribe",
  "/api/outreach/unsubscribe",
  "/api/webhooks/connection-accepted",
  "/api/webhooks/message-received",
  "/api/webhooks/unipile-account",
  // Unipile's WhatsApp messaging webhook; checks the stored Unipile notify secret itself.
  "/api/webhooks/whatsapp-message",
  // The single messaging webhook AgentSDR registers; routes to the two above.
  "/api/webhooks/unipile-message",
  // Cal.com bookings for AI calling campaigns; checks the organization's
  // webhook secret (x-cal-signature-256) itself. See aiCampaigns/booking.ts.
  "/api/webhooks/calcom",
  // Called by the WhatsApp call-recorder Chrome extension's service worker,
  // which holds a per-call bearer token, not the site cookie. Every route
  // under this prefix authenticates itself with authorizeRecorder() (see
  // src/lib/calls/sessions.ts) — never add a route here that doesn't.
  "/api/call-recorder/",
  // Called by the cloud call worker (services/call-worker), which holds
  // CALL_WORKER_SECRET, not a session. Every route under this prefix starts
  // with authorizeWorker() (src/lib/calls/stations.ts) — never add one that doesn't.
  "/api/call-worker/",
];

/**
 * Routes an external cron may call with a Bearer secret instead of a session
 * cookie. The outreach equivalents are in PUBLIC above because they carry
 * their own OUTREACH_TICK_SECRET check inside the route.
 */
const CRON_PATHS = ["/api/linkedin/jobs"];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const migrationBlockReason = migrationMutationBlockReason(pathname, request.method);
  if (migrationBlockReason) {
    return NextResponse.json({ error: migrationBlockReason }, { status: 503 });
  }

  // The public demo (DEMO_MODE): read-only, and the sign-in screens lead
  // straight in as the demo user. See src/lib/demo/mode.ts.
  const demo = demoRequestBlock(pathname, request.method);
  if (demo?.kind === "enter") {
    const url = request.nextUrl.clone();
    const from = request.nextUrl.searchParams.get("from");
    url.pathname = "/demo";
    url.search = "";
    if (from) url.searchParams.set("from", from);
    return NextResponse.redirect(url);
  }
  if (demo?.kind === "refuse") {
    return NextResponse.json({ error: DEMO_READ_ONLY_MESSAGE, code: DEMO_READ_ONLY_CODE }, { status: 403 });
  }
  if (demo?.kind === "silent") return NextResponse.json({ ok: true });
  if (pathname === "/demo" && isDemoMode()) return NextResponse.next();
  const isPublic =
    pathname === "/robots.txt" ||
    PUBLIC.some((p) => pathname.startsWith(p)) ||
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    /\.(?:png|jpe?g|gif|svg|webp|ico)$/i.test(pathname);

  if (isPublic) return NextResponse.next();

  // Cron/external callers on job routes with a valid Bearer secret.
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && CRON_PATHS.some((p) => pathname.startsWith(p))) {
    const auth = request.headers.get("authorization");
    if (auth === `Bearer ${cronSecret}`) return NextResponse.next();
  }

  // Optimistic check only: a Better Auth session cookie is present. Better
  // Auth's docs are explicit that this does not validate it — the real check
  // (valid session, active organization, current membership) is
  // requireOrgContext() in every route and page that touches data
  // (src/lib/auth/context.ts). This only turns visitors without a cookie
  // away early.
  if (getSessionCookie(request)) return NextResponse.next();

  // API routes also accept organization API keys (validated inside requireOrgContext).
  if (pathname.startsWith("/api/")) {
    const hasApiKey =
      Boolean(request.headers.get("x-api-key")?.trim()) ||
      /^Bearer\s+\S+/i.test(request.headers.get("authorization")?.trim() ?? "");
    if (hasApiKey) return NextResponse.next();
    return NextResponse.json({ error: "Sign in to continue", code: "UNAUTHENTICATED" }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  // In the demo nobody signs in: /demo creates the session and comes back.
  url.pathname = isDemoMode() ? "/demo" : "/sign-in";
  url.search = "";
  url.searchParams.set("from", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Skip auth for Next assets, favicons, and other static files in /public
  matcher: [
    "/((?!_next/static|_next/image|favicon|linkbird|.*\\.(?:png|jpe?g|gif|svg|webp|ico)$).*)",
  ],
};
