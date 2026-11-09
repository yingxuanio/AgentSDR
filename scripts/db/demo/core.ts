/**
 * The demo's foundation: Northwind's team, the companies and people it
 * prospects (the lead database), custom lead fields, and the platform
 * integrations — stored with placeholder credentials, so every LinkedIn,
 * WhatsApp and Calling page opens. Nothing ever uses those credentials: the
 * demo refuses every write and runs no background work (src/lib/demo/mode.ts).
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { invitations, members, teamMembers, teams, users } from "@/lib/auth/schema";
import { gridProviderCredentials, gridProviders } from "@/lib/grid/schema";
import { encryptIntegrationCredentials } from "@/lib/integrations/credentials";
import { addColumn } from "@/lib/leads/columns";
import { companies, people } from "@/lib/leads/schema";
import { getPlatformIntegration, type PlatformKey } from "@/lib/platform/catalog";
import { ensureCrmDefaults } from "@/lib/crm/defaults";
import { saveChannelRules } from "@/lib/channels/rules.server";
import { UNIPILE_WEBHOOKS } from "@/lib/platform/unipileWebhooks";
import {
  CITY_FOR_COUNTRY,
  COMPANIES,
  FEMALE_FIRST,
  LAST_NAMES,
  MALE_FIRST,
  TEAM,
  TITLES,
  companyDomain,
  type TeamKey,
} from "./content";
import { DAY, SEED_SOURCE, count, daysAgo, type DemoCompany, type DemoContext, type DemoPerson } from "./context";

const PEOPLE_TOTAL = 700;
const POOL_SIZES = { email: 300, linkedin: 250, whatsapp: 120 } as const;

/** Portraits already used by the team (content.ts), so no lead shares a face with a rep. */
const TEAM_PORTRAITS = { men: new Set([32, 46, 75]), women: new Set([44, 65]) };

export async function seedCore(ctx: DemoContext, ownerId: string): Promise<void> {
  await seedTeam(ctx, ownerId);
  await seedLeadDatabase(ctx);
  await seedPlatformIntegrations(ctx);
  await saveChannelRules(
    "email",
    { sendingHours: { timezone: "America/New_York", days: [1, 2, 3, 4, 5], start: "08:30", end: "17:30" } },
    ownerId,
  );
  const { pipelineId } = await ensureCrmDefaults();
  ctx.pipelineId = pipelineId;
}

// ---------------------------------------------------------------------------
// Team: users, memberships, teams, a pending invitation
// ---------------------------------------------------------------------------

async function seedTeam(ctx: DemoContext, ownerId: string) {
  const orgId = ctx.organizationId;
  const joined: Record<TeamKey, number> = { alex: 120, priya: 112, jordan: 96, sam: 64, lena: 41 };

  await db.update(users).set({ name: TEAM.alex.name, image: TEAM.alex.avatar }).where(eq(users.id, ownerId));
  ctx.users.alex = { id: ownerId, name: TEAM.alex.name, email: TEAM.alex.email };
  await db.update(members).set({ createdAt: daysAgo(ctx, joined.alex) }).where(and(eq(members.organizationId, orgId), eq(members.userId, ownerId)));

  for (const key of ["priya", "jordan", "sam", "lena"] as const) {
    const t = TEAM[key];
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, t.email)).limit(1);
    const id =
      existing?.id ??
      (
        await db
          .insert(users)
          .values({ name: t.name, email: t.email, emailVerified: true, image: t.avatar, createdAt: daysAgo(ctx, joined[key]), updatedAt: daysAgo(ctx, joined[key]) })
          .returning({ id: users.id })
      )[0].id;
    await db.insert(members).values({ organizationId: orgId, userId: id, role: t.role, createdAt: daysAgo(ctx, joined[key]) });
    ctx.users[key] = { id, name: t.name, email: t.email };
  }

  const [outbound] = await db.insert(teams).values({ name: "Outbound", organizationId: orgId, createdAt: daysAgo(ctx, 110) }).returning({ id: teams.id });
  const [closers] = await db.insert(teams).values({ name: "Account Executives", organizationId: orgId, createdAt: daysAgo(ctx, 110) }).returning({ id: teams.id });
  const roster: [string, TeamKey][] = [
    [outbound.id, "priya"], [outbound.id, "sam"], [outbound.id, "lena"],
    [closers.id, "alex"], [closers.id, "jordan"],
  ];
  await db.insert(teamMembers).values(roster.map(([teamId, key]) => ({ teamId, userId: ctx.users[key].id, createdAt: daysAgo(ctx, 100) })));

  await db.insert(invitations).values({
    organizationId: orgId,
    email: "chris@northwind.example",
    role: "member",
    status: "pending",
    expiresAt: new Date(ctx.now.getTime() + 5 * DAY),
    inviterId: ownerId,
  });
  count(ctx, "team members", 5);
}

// ---------------------------------------------------------------------------
// Lead database
// ---------------------------------------------------------------------------

async function seedLeadDatabase(ctx: DemoContext) {
  const orgId = ctx.organizationId;
  const { rand } = ctx;

  // Custom fields first, so the values below land under registered keys.
  const seniority = await addColumn({ entity: "person", name: "Seniority", type: "text" });
  const location = await addColumn({ entity: "person", name: "Location", type: "text" });
  const industry = await addColumn({ entity: "company", name: "Industry", type: "text" });
  const employees = await addColumn({ entity: "company", name: "Employees", type: "number" });
  const hq = await addColumn({ entity: "company", name: "Headquarters", type: "text" });
  const funding = await addColumn({ entity: "company", name: "Funding stage", type: "text" });

  const companyRows = await db
    .insert(companies)
    .values(
      COMPANIES.map((c) => {
        // Imported in a few batches 2–4 months ago; about half touched since (enrichment, edits).
        const created = new Date(daysAgo(ctx, rand.pick([112, 104, 97, 88, 76, 63])).getTime() - rand.int(0, 9 * 60) * 60_000);
        const updated = rand.chance(0.5) ? new Date(ctx.now.getTime() - rand.int(2 * 60, 40 * 24 * 60) * 60_000) : created;
        return {
          organizationId: orgId,
          domain: companyDomain(c),
          name: c.name,
          linkedinUrl: `https://www.linkedin.com/company/${c.slug}`,
          custom: {
            [industry.key]: c.industry,
            [employees.key]: c.employees,
            [hq.key]: c.hq,
            [funding.key]: c.funding,
          },
          raw: { industry: c.industry, employees: c.employees, founded: c.founded, description: c.blurb },
          source: SEED_SOURCE,
          createdAt: created,
          updatedAt: updated,
        };
      }),
    )
    .returning({ id: companies.id, domain: companies.domain });
  const idByDomain = new Map(companyRows.map((r) => [r.domain, r.id]));
  ctx.companies = COMPANIES.map((c) => ({ ...c, id: idByDomain.get(companyDomain(c))!, domain: companyDomain(c) }));

  // Bigger companies get more people, every company at least two.
  const companyWeights = ctx.companies.map((c) => [c, Math.sqrt(c.employees)] as const);
  const assigned: DemoCompany[] = [...ctx.companies, ...ctx.companies];
  while (assigned.length < PEOPLE_TOTAL) assigned.push(rand.weighted(companyWeights));
  const order = rand.shuffle(assigned);

  const titleWeights = TITLES.map((t) => [t, t.weight] as const);
  const usedEmails = new Set<string>();
  const drafts: Omit<DemoPerson, "id" | "avatarUrl" | "phone">[] = order.map((company, i) => {
    const gender = rand.chance(0.48) ? "female" : "male";
    const firstName = rand.pick(gender === "female" ? FEMALE_FIRST : MALE_FIRST);
    const lastName = LAST_NAMES[(i * 7 + rand.int(0, LAST_NAMES.length - 1)) % LAST_NAMES.length];
    const local = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
    let email = `${local(firstName)}.${local(lastName)}@${company.domain}`;
    if (usedEmails.has(email)) email = `${local(firstName)[0]}${local(lastName)}@${company.domain}`;
    if (usedEmails.has(email)) email = `${local(firstName)}.${local(lastName)}${i}@${company.domain}`;
    usedEmails.add(email);
    const title = rand.weighted(titleWeights);
    return {
      firstName,
      lastName,
      fullName: `${firstName} ${lastName}`,
      gender,
      email,
      linkedinSlug: `${local(firstName)}-${local(lastName)}-${(i * 2654435761 >>> 0).toString(36).slice(0, 5)}`,
      title: title.title,
      seniority: title.seniority,
      location: rand.chance(0.7) ? company.hq.split(" / ")[0] : rand.pick(CITY_FOR_COUNTRY[company.country]),
      company,
    };
  });

  // Pools: disjoint slices of the same people.
  const emailSlice = drafts.slice(0, POOL_SIZES.email);
  const linkedinSlice = drafts.slice(POOL_SIZES.email, POOL_SIZES.email + POOL_SIZES.linkedin);
  const whatsappSlice = drafts.slice(POOL_SIZES.email + POOL_SIZES.linkedin, POOL_SIZES.email + POOL_SIZES.linkedin + POOL_SIZES.whatsapp);

  // Everyone gets a portrait. There are ~98 per gender, so a face comes back
  // only after every other one of that gender has been used: ~200 people apart.
  const portraits = { female: rand.shuffle(freePortraits("women")), male: rand.shuffle(freePortraits("men")) };
  const used = { female: 0, male: 0 };
  const avatars = new Map<(typeof drafts)[number], string | null>();
  for (const p of drafts) {
    const pool = portraits[p.gender];
    const n = pool[used[p.gender]++ % pool.length];
    avatars.set(p, `https://randomuser.me/api/portraits/${p.gender === "female" ? "women" : "men"}/${n}.jpg`);
  }

  let usPhone = 0;
  let ukPhone = 0;
  const areaCodes = ["212", "415", "312", "617", "512", "206", "303", "404", "305", "646"];
  const phoneFor = (p: (typeof drafts)[number]) => {
    if (p.company.country === "UK" || p.company.country === "IE") return `+447700900${String(100 + ukPhone++).padStart(3, "0")}`;
    const n = usPhone++;
    return `+1${areaCodes[Math.floor(n / 100) % areaCodes.length]}55501${String(n % 100).padStart(2, "0")}`;
  };
  const phones = new Map(whatsappSlice.map((p) => [p, phoneFor(p)]));

  const rows = drafts.map((p, i) => {
    const created = new Date(daysAgo(ctx, 90 - (i % 85)).getTime() - rand.int(0, 8) * 3_600_000);
    return {
      organizationId: orgId,
      email: p.email,
      linkedinUrl: p.linkedinSlug,
      firstName: p.firstName,
      lastName: p.lastName,
      fullName: p.fullName,
      title: p.title,
      profilePictureUrl: avatars.get(p) ?? null,
      phone: phones.get(p) ?? null,
      companyId: p.company.id,
      custom: { [seniority.key]: p.seniority, [location.key]: p.location },
      raw: { headline: `${p.title} at ${p.company.name}` },
      source: SEED_SOURCE,
      createdAt: created,
      updatedAt: created,
    };
  });
  const inserted: { id: string }[] = [];
  for (let i = 0; i < rows.length; i += 200) {
    inserted.push(...(await db.insert(people).values(rows.slice(i, i + 200)).returning({ id: people.id })));
  }

  ctx.people = drafts.map((p, i) => ({ ...p, id: inserted[i].id, avatarUrl: avatars.get(p) ?? null, phone: phones.get(p) ?? null }));
  const at = (slice: typeof drafts) => slice.map((p) => ctx.people[drafts.indexOf(p)]);
  ctx.pools = {
    email: at(emailSlice),
    linkedin: at(linkedinSlice),
    whatsapp: at(whatsappSlice),
    unassigned: ctx.people.slice(POOL_SIZES.email + POOL_SIZES.linkedin + POOL_SIZES.whatsapp),
  };
  count(ctx, "companies", ctx.companies.length);
  count(ctx, "people", ctx.people.length);
}

function freePortraits(kind: "men" | "women"): number[] {
  const used = TEAM_PORTRAITS[kind];
  return Array.from({ length: 100 }, (_, i) => i).filter((n) => !used.has(n));
}

// ---------------------------------------------------------------------------
// Platform integrations (placeholder credentials; nothing calls them)
// ---------------------------------------------------------------------------

const PLACEHOLDER_CREDENTIALS: Record<PlatformKey, Record<string, string>> = {
  unipile: { baseUrl: "https://api.unipile.example", apiKey: "demo-unipile-key", notifySecret: "demo-notify-secret" },
  google: {
    clientEmail: "agentsdr-sender@northwind-demo.iam.gserviceaccount.example",
    privateKey: "-----BEGIN PRIVATE KEY-----\nDEMO\n-----END PRIVATE KEY-----\n",
    gmailWatchTopic: "projects/northwind-demo/topics/gmail-replies",
  },
  smtp: {
    smtpHost: "smtp.qiye.aliyun.com",
    smtpPort: "465",
    imapHost: "imap.qiye.aliyun.com",
    imapPort: "993",
    defaultEmail: "",
    defaultPassword: "",
  },
  r2: { accountId: "demo0000000000000000000000000000", bucket: "northwind-call-recordings", accessKeyId: "demo-access-key", secretAccessKey: "demo-secret-key" },
  gologin: { apiToken: "demo-gologin-token" },
  calcom: { webhookSecret: "demo-calcom-webhook-secret", apiKey: "" },
};

async function seedPlatformIntegrations(ctx: DemoContext) {
  for (const key of Object.keys(PLACEHOLDER_CREDENTIALS) as PlatformKey[]) {
    const integration = getPlatformIntegration(key);
    if (!integration) continue;
    const stored = Object.fromEntries(integration.fields.map((f) => [f.key, PLACEHOLDER_CREDENTIALS[key][f.key] ?? ""]));
    const config = {
      platformKey: key,
      values: Object.fromEntries(integration.fields.filter((f) => !f.secret).map((f) => [f.key, stored[f.key]])),
      secretsSet: integration.fields.filter((f) => f.secret && stored[f.key]).map((f) => f.key),
      verifiedAt: daysAgo(ctx, 100).toISOString(),
      // Saving Unipile registers its webhooks; show them as registered.
      ...(key === "unipile"
        ? {
            webhooks: {
              status: "registered" as const,
              at: daysAgo(ctx, 100).toISOString(),
              origin: process.env.NEXT_PUBLIC_APP_URL || process.env.BETTER_AUTH_URL || "https://demo.agentsdr.ai",
              items: UNIPILE_WEBHOOKS.map((hook, i) => ({ key: hook.key, id: `whk_demo${i + 1}${hook.key.length}` })),
            },
          }
        : {}),
    };
    const [row] = await db
      .insert(gridProviders)
      .values({ organizationId: ctx.organizationId, key: `platform-${key}`, name: "Platform integration", config, enabled: true, createdAt: daysAgo(ctx, 100), updatedAt: daysAgo(ctx, 100) })
      .returning({ id: gridProviders.id });
    await db.insert(gridProviderCredentials).values({ providerId: row.id, encryptedPayload: encryptIntegrationCredentials(stored) });
  }
  count(ctx, "integrations connected (placeholder credentials)", 3);
}
