import ByokSettingsClient from "@/components/ai/ByokSettingsClient";
import { PlatformConnection } from "@/components/settings/PlatformConnection";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { listPlatformStatus } from "@/lib/platform/credentials";
import { runInOrganization } from "@/lib/tenancy/scope";

export const metadata = { title: "AI provider" };
export const dynamic = "force-dynamic";

export default async function AiSettingsPage() {
  const ctx = await requirePageOrgContext();
  const statuses = await runInOrganization(ctx.organizationId, () => listPlatformStatus());
  return (
    <SettingsPage
      title="AI provider"
      description="Configure OpenAI Responses (/v1/responses), Anthropic Messages (/v1/messages), or OpenRouter with custom BaseURL, API key, model discovery, and live test calls, plus optional Langfuse prompt and trace observability."
    >
      <ByokSettingsClient>
        <section className="flex flex-col gap-3 pt-4">
          <div>
            <h3 className="text-label-md text-text-strong-950">Prompts and tracing (Langfuse)</h3>
            <p className="mt-1 max-w-2xl text-paragraph-sm text-text-sub-600">
              Optional, and saved on its own. Connect a Langfuse project to edit the AI&apos;s prompts there and see every AI call it makes. Without it, AI features use the prompts built into AgentSDR and nothing is traced.
            </p>
          </div>
          <PlatformConnection platformKey="langfuse" status={statuses.find((status) => status.key === "langfuse") ?? null} />
        </section>
      </ByokSettingsClient>
    </SettingsPage>
  );
}
