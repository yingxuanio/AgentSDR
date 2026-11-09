import { ConnectionSettingsPage } from "@/components/settings/ChannelSettingsPages";

export const metadata = { title: "Email connection" };
export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <ConnectionSettingsPage
      platforms={[
        {
          platform: "smtp",
          note: "Connect Aliyun Enterprise Mail (smtp.qiye.aliyun.com / imap.qiye.aliyun.com) or any standard SMTP/IMAP mail server with real-time IMAP IDLE and 60s UID reply sync.",
        },
        { platform: "google" },
      ]}
      comingSoon={[
        {
          name: "Microsoft Outlook",
          description: "Send and read email from Microsoft 365 and Outlook mailboxes, connected through Microsoft Azure.",
          iconUrl: "/Integrations - Icon/microsoft.svg",
          enables: ["Outlook mailboxes", "email campaigns", "inbox sync"],
        },
      ]}
      title="Email connection"
      description="Connect an SMTP / IMAP mail server (such as Aliyun Enterprise Mail) or a Google Workspace service account to power every mailbox in Email → Accounts."
    />
  );
}
