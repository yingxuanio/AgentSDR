import Link from "next/link";
import type { ReactNode } from "react";
import { RiPlugLine } from "@remixicon/react";

import * as Button from "@/components/alignui/button";
import { Frame, FramePanel } from "@/components/analytics/kit/Frame";
import { DocsLink } from "@/components/page/DocsLink";
import { EmptyState } from "@/components/page/EmptyState";
import { getPlatformIntegration, PLATFORM_SETTINGS_HREF, type PlatformKey } from "@/lib/platform/catalog";
import { requirePageOrgContext } from "@/lib/auth/context";
import { isPlatformConnected } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * Renders `children` while the platform integration is connected, otherwise a
 * "Connect X" prompt linking to the integration's Connection page in Settings
 * (`settingsHref` overrides it, e.g. WhatsApp's for Unipile) and to our guide
 * for it (`guideHref` overrides the catalog's, where the channel matters).
 * Reads the database, so the page using it must be dynamic. Resolves the
 * page's organization itself, so callers need no scope.
 */
export async function RequiresPlatform({
  platform,
  children,
  fallback,
  settingsHref,
  guideHref,
  className,
}: {
  platform: PlatformKey;
  settingsHref?: string;
  guideHref?: string;
  children: ReactNode;
  /** Replaces the Connect prompt — `null` to render nothing (e.g. for a header action). */
  fallback?: ReactNode;
  /** Wraps the Connect prompt only, e.g. in the page padding a layout leaves to its pages. */
  className?: string;
}) {
  const ctx = await requirePageOrgContext();
  const connected = await runInOrganization(ctx.organizationId, () => isPlatformConnected(platform));
  if (connected) return <>{children}</>;
  if (fallback !== undefined) return <>{fallback}</>;
  const prompt = <PlatformConnectPrompt platform={platform} settingsHref={settingsHref} guideHref={guideHref} />;
  return className ? <div className={className}>{prompt}</div> : prompt;
}

/** The "Connect X to use this" card on its own, with Connect and "How to connect". No database access. */
export function PlatformConnectPrompt({
  platform,
  settingsHref,
  guideHref,
}: {
  platform: PlatformKey;
  settingsHref?: string;
  guideHref?: string;
}) {
  const integration = getPlatformIntegration(platform);
  const isEmailPlatform = platform === "google" || platform === "smtp";
  const name = isEmailPlatform ? "SMTP / IMAP or Google Workspace" : (integration?.name ?? "this integration");
  const guide = guideHref ?? integration?.guideUrl;

  return (
    <Frame className="mx-auto max-w-2xl">
      <FramePanel>
        <EmptyState
          icon={RiPlugLine}
          title={`Connect ${name} to use this`}
          description={
            integration
              ? `${name} powers ${integration.enables.join(" and ").toLowerCase()}. Add its credentials once and this unlocks.`
              : undefined
          }
          action={
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button.Root asChild variant="primary" mode="filled" size="small">
                <Link href={settingsHref ?? PLATFORM_SETTINGS_HREF[platform]}>Connect {name}</Link>
              </Button.Root>
              {guide && <DocsLink href={guide} />}
            </div>
          }
        />
      </FramePanel>
    </Frame>
  );
}
