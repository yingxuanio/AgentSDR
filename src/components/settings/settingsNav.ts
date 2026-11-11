import {
  RiBookOpenLine,
  RiBuilding2Line,
  RiCpuLine,
  RiEqualizerLine,
  RiGroupLine,
  RiKey2Line,
  RiTeamLine,
  RiLayoutColumnLine,
  RiLinkedinBoxLine,
  RiMailLine,
  RiPhoneLine,
  RiPlugLine,
  RiPaletteLine,
  RiPriceTag3Line,
  RiQuillPenLine,
  RiWhatsappLine,
  type RemixiconComponentType,
} from "@remixicon/react";

export type SettingsTab = { href: string; label: string; icon: RemixiconComponentType };

/** A row in the settings rail. With `tabs`, it opens the first and stays active on any of them. */
export type SettingsNavItem = SettingsTab & { tabs?: SettingsTab[] };

/** Every page a row covers: itself, or its tabs. */
export function itemPages(item: SettingsNavItem): SettingsTab[] {
  return item.tabs ?? [item];
}

/**
 * Every settings screen in the app. Each is its own route under /settings;
 * the pages they replaced redirect here (next.config.ts).
 */
export const SETTINGS_NAV: { label: string; items: SettingsNavItem[] }[] = [
  {
    label: "Organization",
    items: [
      { href: "/settings/organization", label: "General", icon: RiBuilding2Line },
      { href: "/settings/members", label: "Members", icon: RiGroupLine },
      { href: "/settings/teams", label: "Teams", icon: RiTeamLine },
      { href: "/settings/api-keys", label: "API keys", icon: RiKey2Line },
    ],
  },
  // Each channel is one row here; its pages — the connected accounts, the
  // integration it runs on, its sending rules (src/lib/channels/rules.ts) —
  // are tabs across the top of the section (SettingsShell).
  {
    label: "Channels",
    items: [
      {
        href: "/settings/email-accounts",
        label: "Email",
        icon: RiMailLine,
        tabs: [
          { href: "/settings/email-accounts", label: "Mailboxes", icon: RiMailLine },
          { href: "/settings/email-connection", label: "Connection", icon: RiPlugLine },
          { href: "/settings/email-rules", label: "Sending rules", icon: RiEqualizerLine },
        ],
      },
      {
        href: "/settings/linkedin-accounts",
        label: "LinkedIn",
        icon: RiLinkedinBoxLine,
        tabs: [
          { href: "/settings/linkedin-accounts", label: "Accounts", icon: RiLinkedinBoxLine },
          { href: "/settings/linkedin-connection", label: "Connection", icon: RiPlugLine },
          { href: "/settings/linkedin-rules", label: "Sending rules", icon: RiEqualizerLine },
        ],
      },
      {
        href: "/settings/whatsapp-accounts",
        label: "WhatsApp",
        icon: RiWhatsappLine,
        tabs: [
          { href: "/settings/whatsapp-accounts", label: "Numbers", icon: RiWhatsappLine },
          { href: "/settings/whatsapp-stations", label: "Calling numbers", icon: RiPhoneLine },
          { href: "/settings/whatsapp-connection", label: "Integrations", icon: RiPlugLine },
          { href: "/settings/whatsapp-rules", label: "Sending rules", icon: RiEqualizerLine },
        ],
      },
    ],
  },
  {
    label: "AI",
    items: [
      { href: "/settings/instructions", label: "Instructions", icon: RiQuillPenLine },
      { href: "/settings/knowledge", label: "Knowledge", icon: RiBookOpenLine },
      { href: "/settings/ai", label: "AI provider", icon: RiCpuLine },
    ],
  },
  {
    label: "CRM & leads",
    items: [
      { href: "/settings/lead-categories", label: "Lead categories", icon: RiPriceTag3Line },
      { href: "/settings/columns", label: "Lead columns", icon: RiLayoutColumnLine },
    ],
  },
  {
    label: "Preferences",
    items: [{ href: "/settings/appearance", label: "Appearance", icon: RiPaletteLine }],
  },
];

/** Where "Settings" opens. */
export const SETTINGS_HOME = SETTINGS_NAV[0].items[0].href;

