import ByokSettingsClient from "@/components/ai/ByokSettingsClient";
import { SettingsPage } from "@/components/settings/SettingsPage";

export const metadata = { title: "AI provider" };
export const dynamic = "force-dynamic";

export default function AiSettingsPage() {
  return (
    <SettingsPage
      title="AI provider"
      description="Configure OpenAI Responses (/v1/responses), Anthropic Messages (/v1/messages), or OpenRouter with custom BaseURL, API key, model discovery, and live test calls."
    >
      <ByokSettingsClient />
    </SettingsPage>
  );
}
