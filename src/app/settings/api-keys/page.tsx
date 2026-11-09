import ApiKeysSettingsClient from "@/components/settings/ApiKeysSettingsClient";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { listApiKeys } from "@/lib/auth/api-keys";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";

export const dynamic = "force-dynamic";

export const metadata = { title: "API keys" };

export default async function ApiKeysPage() {
  const ctx = await requirePageOrgContext();
  const initialKeys = await runInOrganization(ctx.organizationId, () => listApiKeys());

  return (
    <SettingsPage
      title="API keys"
      description="Create and manage organization API keys for programmatic access to CRM drafts, leads, and outreach endpoints."
    >
      <ApiKeysSettingsClient initialKeys={initialKeys} />
    </SettingsPage>
  );
}
