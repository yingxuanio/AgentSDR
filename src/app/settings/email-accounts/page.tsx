import AddMailboxButton from "@/components/outreach/AddMailboxButton";
import MailboxesPageClient from "@/components/outreach/MailboxesPageClient";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { requirePageOrgContext } from "@/lib/auth/context";
import { runInOrganization } from "@/lib/tenancy/scope";
import { listMailboxes } from "@/lib/outreach/mailboxes";

export const dynamic = "force-dynamic";

export const metadata = { title: "Email accounts" };

async function Mailboxes() {
  const ctx = await requirePageOrgContext();
  const mailboxes = await runInOrganization(ctx.organizationId, () => listMailboxes());
  return <MailboxesPageClient mailboxes={mailboxes} />;
}

export default function EmailAccountsPage() {
  return (
    <SettingsPage
      title="Email accounts"
      description="The mailboxes outreach campaigns send from (supports direct SMTP / IMAP mailboxes such as Aliyun Enterprise Mail or Google Workspace)."
      actions={<AddMailboxButton />}
    >
      <Mailboxes />
    </SettingsPage>
  );
}
