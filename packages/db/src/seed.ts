import { sql } from "drizzle-orm";
import { createDb, type Database } from "./index.js";
import * as s from "./schema/index.js";

/* ------------------------------------------------------------------ *
 * Demo seed.
 *
 * Creates a plausible small fleet with the state an owner-operator
 * would actually have: a few servers, sites with certificates at
 * different stages of expiry, a Yunori Mail Server whose DNS checklist
 * is partly unpublished in the way real ones are, databases, backups, and 48
 * hours of metric history so every chart has something honest to draw.
 *
 * Servers are marked `simulated` so the panel can label them
 * unmistakably (KD-010) — a fake fleet that can be mistaken for a real
 * one is worse than no fake fleet.
 * ------------------------------------------------------------------ */

const SEED = 0x4b414e41; // "KANA"

/** Deterministic PRNG, so the demo fleet is identical on every reset. */
function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const SERVERS = [
  {
    name: "forge-01",
    hostname: "forge-01.futureforge.dev",
    address: "203.0.113.14",
    provider: "Hetzner",
    os: "Debian GNU/Linux 12 (bookworm)",
    osFamily: "debian",
    osVersion: "12",
    arch: "amd64",
    kernel: "6.1.0-18-amd64",
    cpuModel: "AMD Ryzen 7 3700X 8-Core Processor",
    cpuCores: 16,
    memoryTotal: 64 * 1024 ** 3,
    capabilities: [
      "systemd",
      "docker",
      "nginx",
      "postgres",
      "nftables",
      "fail2ban",
      "certbot",
      "restic",
      "simulated",
    ],
    labels: { role: "apps", region: "fsn1", tier: "primary" },
    health: "healthy" as const,
  },
  {
    name: "mail-01",
    hostname: "mail-01.futureforge.dev",
    address: "198.51.100.42",
    provider: "Vultr",
    os: "Ubuntu 22.04.4 LTS",
    osFamily: "ubuntu",
    osVersion: "22.04",
    arch: "amd64",
    kernel: "5.15.0-101-generic",
    cpuModel: "Intel Xeon Processor (Cascadelake)",
    cpuCores: 4,
    memoryTotal: 8 * 1024 ** 3,
    capabilities: [
      "systemd",
      "docker",
      "nginx",
      "yunori",
      "nftables",
      "fail2ban",
      "certbot",
      "simulated",
    ],
    labels: { role: "mail", region: "ams", tier: "primary" },
    health: "warning" as const,
  },
  {
    name: "db-01",
    hostname: "db-01.futureforge.dev",
    address: "198.51.100.77",
    provider: "Vultr",
    os: "Debian GNU/Linux 12 (bookworm)",
    osFamily: "debian",
    osVersion: "12",
    arch: "amd64",
    kernel: "6.1.0-18-amd64",
    cpuModel: "Intel Xeon Processor (Cascadelake)",
    cpuCores: 8,
    memoryTotal: 32 * 1024 ** 3,
    capabilities: ["systemd", "postgres", "mysql", "nftables", "restic", "simulated"],
    labels: { role: "database", region: "ams", tier: "primary" },
    health: "healthy" as const,
  },
  {
    name: "edge-01",
    hostname: "edge-01.futureforge.dev",
    address: "203.0.113.201",
    provider: "Hetzner",
    os: "Alpine Linux v3.19",
    osFamily: "alpine",
    osVersion: "3.19",
    arch: "arm64",
    kernel: "6.6.14-0-lts",
    cpuModel: "Ampere Altra",
    cpuCores: 2,
    memoryTotal: 4 * 1024 ** 3,
    capabilities: ["systemd", "nginx", "certbot", "simulated"],
    labels: { role: "edge", region: "hel1", tier: "secondary" },
    health: "healthy" as const,
  },
];

export async function seedDemo(db: Database): Promise<void> {
  const random = rng(SEED);
  const now = Date.now();

  const existing = await db.select({ n: sql<number>`count(*)::int` }).from(s.servers);
  if ((existing[0]?.n ?? 0) > 0) {
    console.log("servers already present — skipping demo seed");
    return;
  }

  /* ------------------------------- fleet ------------------------------ */

  const serverIds: Record<string, string> = {};
  for (const spec of SERVERS) {
    const [row] = await db
      .insert(s.servers)
      .values({
        ...spec,
        capabilities: spec.capabilities as never,
        simulated: true,
        connection: "disconnected",
        healthReasons: spec.health === "warning" ? ["warning:disk /var 88% full"] : [],
        enrolledAt: new Date(now - 40 * 86_400_000),
        bootTime: new Date(now - 31 * 86_400_000),
        lastSeenAt: new Date(now - 90_000),
        timezone: "UTC",
      })
      .returning({ id: s.servers.id });
    serverIds[spec.name] = row!.id;
  }

  /* ------------------------------ metrics ----------------------------- */
  // 48 hours at 5-minute resolution, as a smooth walk with a daily
  // rhythm, so the charts look like telemetry rather than noise.

  for (const spec of SERVERS) {
    const id = serverIds[spec.name]!;
    let cpu = 12 + random() * 20;
    let mem = spec.memoryTotal * (0.35 + random() * 0.2);
    let netRx = 400_000 + random() * 800_000;
    const diskTotal = 512 * 1024 ** 3;
    let diskUsed = diskTotal * (spec.name === "mail-01" ? 0.86 : 0.42);

    const rows: (typeof s.serverMetrics5m.$inferInsert)[] = [];
    for (let i = 48 * 12; i >= 0; i -= 1) {
      const ts = new Date(now - i * 5 * 60_000);
      const hour = ts.getUTCHours() + ts.getUTCMinutes() / 60;
      const daily = Math.sin(((hour - 4) / 24) * Math.PI * 2);

      cpu = clamp(cpu + (random() - 0.5) * 6 + daily * 0.8, 3, 96);
      mem = clamp(
        mem + (random() - 0.5) * spec.memoryTotal * 0.01,
        spec.memoryTotal * 0.25,
        spec.memoryTotal * 0.92,
      );
      netRx = clamp(netRx + (random() - 0.5) * 300_000 + daily * 90_000, 20_000, 40_000_000);
      diskUsed = Math.min(diskUsed + random() * 4 * 1024 ** 2, diskTotal * 0.97);

      rows.push({
        serverId: id,
        bucket: ts,
        samples: 5,
        cpuPercent: round(cpu, 2),
        memoryUsed: Math.round(mem),
        memoryTotal: spec.memoryTotal,
        swapUsed: Math.round(spec.memoryTotal * 0.02 * random()),
        swapTotal: Math.round(spec.memoryTotal * 0.25),
        load1: round((cpu / 100) * spec.cpuCores, 2),
        load5: round((cpu / 100) * spec.cpuCores * 0.9, 2),
        load15: round((cpu / 100) * spec.cpuCores * 0.85, 2),
        processes: 120 + Math.round(random() * 90),
        netRxRate: Math.round(netRx),
        netTxRate: Math.round(netRx * (0.3 + random() * 0.4)),
        netRxBytes: Math.round(netRx * 300),
        netTxBytes: Math.round(netRx * 120),
        diskReadRate: Math.round(random() * 12 * 1024 ** 2),
        diskWriteRate: Math.round(random() * 8 * 1024 ** 2),
        disks: [
          {
            mount: "/",
            device: "/dev/sda1",
            fstype: "ext4",
            total: diskTotal,
            used: Math.round(diskUsed),
            available: Math.round(diskTotal - diskUsed),
            used_percent: round((diskUsed / diskTotal) * 100, 1),
          },
        ] as never,
      });
    }

    // Chunked because PGlite parameterises every value in one statement.
    for (let i = 0; i < rows.length; i += 100) {
      await db.insert(s.serverMetrics5m).values(rows.slice(i, i + 100));
    }
    await db
      .insert(s.serverMetrics)
      .values(rows.slice(-24).map(({ bucket, samples, ...rest }) => ({ ...rest, ts: bucket })));
  }

  /* ------------------------------ storage ----------------------------- */

  for (const spec of SERVERS) {
    const total = 512 * 1024 ** 3;
    const used = Math.round(total * (spec.name === "mail-01" ? 0.88 : 0.44));
    await db.insert(s.storageSamples).values({
      serverId: serverIds[spec.name]!,
      sampledAt: new Date(now - 3 * 3600_000),
      total,
      used,
      available: total - used,
      mounts: [
        {
          mount: "/",
          device: "/dev/sda1",
          fstype: "ext4",
          total,
          used,
          available: total - used,
          used_percent: round((used / total) * 100, 1),
        },
      ] as never,
      categories: [
        { label: "Websites", path: "/var/www", bytes: Math.round(used * 0.31), kind: "category" },
        {
          label: "Databases",
          path: "/var/lib/postgresql",
          bytes: Math.round(used * 0.27),
          kind: "category",
        },
        {
          label: "Mail",
          path: "/var/vmail",
          bytes: Math.round(used * (spec.name === "mail-01" ? 0.33 : 0.02)),
          kind: "category",
        },
        {
          label: "Containers",
          path: "/var/lib/docker",
          bytes: Math.round(used * 0.14),
          kind: "category",
        },
        { label: "Logs", path: "/var/log", bytes: Math.round(used * 0.06), kind: "category" },
        {
          label: "Backups",
          path: "/var/backups",
          bytes: Math.round(used * 0.04),
          kind: "category",
        },
      ],
      largest: [
        {
          path: "/var/lib/docker/overlay2",
          bytes: Math.round(used * 0.14),
          kind: "directory",
          modified_at: new Date(now - 3600_000).toISOString(),
        },
        {
          path: "/var/www/futureforge.dev",
          bytes: Math.round(used * 0.11),
          kind: "directory",
          modified_at: new Date(now - 26 * 3600_000).toISOString(),
        },
        {
          path: "/var/log/journal",
          bytes: Math.round(used * 0.05),
          kind: "directory",
          modified_at: new Date(now - 900_000).toISOString(),
        },
      ],
      inodesTotal: 33_554_432,
      inodesUsed: Math.round(33_554_432 * 0.18),
      durationMs: 42_000,
    });
  }

  /* ------------------------------- sites ------------------------------ */

  const siteSpecs = [
    {
      name: "futureforge-www",
      server: "forge-01",
      domain: "futureforge.dev",
      runtime: "node" as const,
      version: "22",
      root: "/var/www/futureforge.dev",
    },
    {
      name: "forgebase-docs",
      server: "forge-01",
      domain: "docs.forgebase.dev",
      runtime: "static" as const,
      version: null,
      root: "/var/www/docs.forgebase.dev",
    },
    {
      name: "kaname-panel",
      server: "edge-01",
      domain: "panel.futureforge.dev",
      runtime: "proxy" as const,
      version: null,
      root: "/var/www/panel",
    },
    {
      name: "legacy-shop",
      server: "forge-01",
      domain: "shop.futureforge.dev",
      runtime: "php" as const,
      version: "8.3",
      root: "/var/www/shop.futureforge.dev",
    },
  ];

  const domainIds: Record<string, string> = {};
  for (const spec of siteSpecs) {
    const serverId = serverIds[spec.server]!;
    const [site] = await db
      .insert(s.sites)
      .values({
        serverId,
        name: spec.name,
        webroot: spec.root,
        runtime: spec.runtime,
        runtimeVersion: spec.version,
        upstream: spec.runtime === "proxy" ? "http://127.0.0.1:3000" : null,
        status: "active",
        configPath: `/etc/nginx/sites-available/${spec.name}.conf`,
        owner: "www-data",
        diskUsage: Math.round(random() * 4 * 1024 ** 3),
        repoUrl:
          spec.runtime === "static" || spec.runtime === "node"
            ? `git@github.com:futureforge/${spec.name}.git`
            : null,
        branch: "main",
      })
      .returning({ id: s.sites.id });

    const [domain] = await db
      .insert(s.domains)
      .values({
        name: spec.domain,
        siteId: site!.id,
        serverId,
        dnsProvider: "cloudflare",
        dnsZoneId: `zone_${spec.domain.replace(/\W/g, "")}`,
        proxied: spec.domain !== "futureforge.dev",
        status: "active",
        registrar: "Porkbun",
        expiresAt: new Date(now + 200 * 86_400_000),
        nameservers: ["ns1.cloudflare.com", "ns2.cloudflare.com"],
        verified: true,
        verificationMethod: "dns_txt",
        verifiedAt: new Date(now - 30 * 86_400_000),
        hasMail: spec.domain === "futureforge.dev",
      })
      .returning({ id: s.domains.id });
    domainIds[spec.domain] = domain!.id;

    await db
      .update(s.sites)
      .set({ primaryDomainId: domain!.id })
      .where(sql`${s.sites.id} = ${site!.id}`)
      .catch(() => undefined);

    await db.insert(s.dnsRecords).values([
      {
        domainId: domain!.id,
        type: "A",
        name: "@",
        content: SERVERS.find((x) => x.name === spec.server)!.address,
        ttl: 300,
        proxied: spec.domain !== "futureforge.dev",
        managedBy: "kaname",
        lastSyncedAt: new Date(now - 3600_000),
      },
      {
        domainId: domain!.id,
        type: "CNAME",
        name: "www",
        content: spec.domain,
        ttl: 300,
        proxied: true,
        managedBy: "kaname",
        lastSyncedAt: new Date(now - 3600_000),
      },
      {
        domainId: domain!.id,
        type: "CAA",
        name: "@",
        content: '0 issue "letsencrypt.org"',
        ttl: 3600,
        managedBy: "kaname",
        lastSyncedAt: new Date(now - 3600_000),
      },
    ]);

    // Certificates at deliberately different points in their life, so the
    // expiry surfaces have something meaningful to render.
    const daysLeft =
      {
        "futureforge.dev": 62,
        "docs.forgebase.dev": 11,
        "panel.futureforge.dev": 84,
        "shop.futureforge.dev": 3,
      }[spec.domain] ?? 45;
    await db.insert(s.certificates).values({
      domainId: domain!.id,
      serverId,
      subject: spec.domain,
      sans: [spec.domain, `www.${spec.domain}`],
      issuer: "Let's Encrypt",
      challenge: "http-01",
      keyType: "ecdsa",
      status: daysLeft < 14 ? "expiring" : "active",
      issuedAt: new Date(now - (90 - daysLeft) * 86_400_000),
      expiresAt: new Date(now + daysLeft * 86_400_000),
      autoRenew: true,
      lastRenewalAt: new Date(now - (90 - daysLeft) * 86_400_000),
      installedPath: `/etc/letsencrypt/live/${spec.domain}/fullchain.pem`,
    });

    if (spec.runtime === "node" || spec.runtime === "static") {
      for (let i = 0; i < 6; i += 1) {
        const started = now - (i * 19 + 2) * 3600_000;
        await db.insert(s.deployments).values({
          siteId: site!.id,
          source: "git",
          repoUrl: `git@github.com:futureforge/${spec.name}.git`,
          branch: "main",
          commitSha: Array.from(
            { length: 40 },
            () => "0123456789abcdef"[Math.floor(random() * 16)],
          ).join(""),
          commitMessage:
            [
              "fix: correct cache headers on static assets",
              "feat: add fleet overview panel",
              "chore: bump dependencies",
              "fix: handle empty state on domains list",
              "refactor: extract deploy pipeline",
              "docs: update runbook",
            ][i] ?? "chore: update",
          commitAuthor: "Lone Detective",
          status: i === 2 ? "failed" : "succeeded",
          startedAt: new Date(started),
          finishedAt: new Date(started + 90_000 + random() * 120_000),
          durationMs: Math.round(90_000 + random() * 120_000),
          triggeredByName: "Lone Detective",
          releasePath: `/var/www/${spec.domain}/releases/${started}`,
        });
      }
    }
  }

  /* -------------------------------- mail ------------------------------ */
  //
  // One Yunori Mail Server, installed and healthy except for the two
  // things that are really still open on a fresh box: the provider's
  // reverse DNS has not been set, and the DKIM record is not published
  // yet. Every value below is written the way a sync would write it from
  // `yunori-mail status`, `doctor` and `domain dns`, so the demo and the
  // real thing cannot drift.

  const mailServerId = serverIds["mail-01"]!;
  const mailDomainId = domainIds["futureforge.dev"]!;
  const mailHost = "mail.futureforge.dev";
  const mailIp = "198.51.100.42";
  const syncedAt = new Date(now - 4 * 60_000);
  const dkimValue =
    "v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0xM3RkFtb3VudE9mS2V5RGF0YUZvclNlZWQ";

  const [mailServer] = await db
    .insert(s.mailServers)
    .values({
      serverId: mailServerId,
      status: "installed",
      version: "0.3.1",
      installComplete: false,
      hostname: mailHost,
      primaryDomain: "futureforge.dev",
      adminEmail: "ops@futureforge.studio",
      sendingMode: "direct",
      relayProvider: null,
      consoleUrl: `https://${mailHost}/console`,
      steps: [
        { title: "Check this server", status: "done", detail: null },
        { title: "Your domain", status: "done", detail: null },
        { title: "Point the mail hostname here", status: "done", detail: null },
        { title: "Open mail ports", status: "done", detail: null },
        { title: "Install the mail engine", status: "done", detail: null },
        { title: "Configure the mail engine", status: "done", detail: null },
        { title: "Start the console and HTTPS edge", status: "done", detail: null },
        { title: "Get a trusted TLS certificate", status: "done", detail: null },
        { title: "Publish DNS records", status: "done", detail: null },
        {
          title: "Set reverse DNS",
          status: "waiting",
          detail: `In the Vultr control panel, set the reverse DNS of ${mailIp} to ${mailHost}. The server re-checks every minute and moves on by itself.`,
        },
        { title: "Create your first mailbox", status: "done", detail: null },
        { title: "Finish", status: "pending", detail: null },
      ],
      services: [
        { name: "stalwart", active: true },
        { name: "yunori-mail", active: true },
        { name: "unbound", active: true },
      ],
      checks: [
        {
          id: "services",
          label: "Services",
          status: "pass",
          detail: "stalwart, yunori-mail and unbound are running.",
          remedy: null,
          help_url: null,
        },
        {
          id: "ports",
          label: "Mail ports",
          status: "pass",
          detail: "25, 465, 587 and 993 answer from the public address.",
          remedy: null,
          help_url: null,
        },
        {
          id: "certificate",
          label: "TLS certificate",
          status: "pass",
          detail: `Let's Encrypt certificate for ${mailHost}, valid for another 71 days; the same certificate is served on 465, 587 and 993.`,
          remedy: null,
          help_url: null,
        },
        {
          id: "outbound_25",
          label: "Outbound port 25",
          status: "pass",
          detail:
            "A connection to a public MX on port 25 succeeded, so direct sending works from here.",
          remedy: null,
          help_url: null,
        },
        {
          id: "ptr",
          label: "Reverse DNS",
          status: "warn",
          detail: `${mailIp} reverses to 198-51-100-42.vultrusercontent.com, not to ${mailHost}. Receivers that require forward-confirmed reverse DNS will mark mail from here as suspicious.`,
          remedy: `Set the reverse DNS of ${mailIp} to ${mailHost} in the Vultr control panel. It is checked again every minute.`,
          help_url: "https://yunori.email/server/docs/reverse-dns",
        },
        {
          id: "blocklists",
          label: "Blocklists",
          status: "fail",
          detail: `${mailIp} is listed on Spamhaus PBL (policy block list), which covers the whole provider range as end-user space.`,
          remedy:
            "Request removal of this single address at spamhaus.org/pbl, or ask Vultr to delist the range. Until then, large receivers will refuse mail from it.",
          help_url: "https://yunori.email/server/docs/blocklists",
        },
        {
          id: "clock",
          label: "Clock",
          status: "pass",
          detail: "The system clock is within 40 ms of NTP time.",
          remedy: null,
          help_url: null,
        },
        {
          id: "disk",
          label: "Disk",
          status: "pass",
          detail: "/var/lib/stalwart has 61 GB free.",
          remedy: null,
          help_url: null,
        },
        {
          id: "updates",
          label: "Release",
          status: "info",
          detail: "yunori-mail 0.3.1 is the newest release.",
          remedy: null,
          help_url: null,
        },
      ],
      health: "fail",
      certificate: {
        state: "valid",
        covers: [mailHost, "autoconfig.futureforge.dev", "mta-sts.futureforge.dev"],
        issuer: "Let's Encrypt",
        expires_at: new Date(now + 71 * 86_400_000).toISOString(),
        days_left: 71,
        authority: "https://acme-v02.api.letsencrypt.org/directory",
        renews_at: new Date(now + 41 * 86_400_000).toISOString(),
        last_attempt: new Date(now - 19 * 86_400_000).toISOString(),
        next_attempt: new Date(now + 41 * 86_400_000).toISOString(),
      },
      lastSyncedAt: syncedAt,
    })
    .returning({ id: s.mailServers.id });

  const dnsRecord = (
    type: string,
    name: string,
    expected: string,
    status: "pass" | "warn" | "fail",
    actual: string[],
    required = true,
  ) => ({ id: `${type}:${name}`, type, name, expected, actual, status, required });

  const dnsRecords = [
    dnsRecord("MX", "futureforge.dev", `10 ${mailHost}.`, "pass", [`10 ${mailHost}.`]),
    dnsRecord("A", mailHost, mailIp, "pass", [mailIp]),
    dnsRecord("TXT", "futureforge.dev", `"v=spf1 mx -all"`, "pass", ["v=spf1 mx -all"]),
    dnsRecord("TXT", mailHost, `"v=spf1 a -all"`, "pass", ["v=spf1 a -all"]),
    // Not published yet: the host generated the key, the operator has not
    // copied it to the zone. The expected value is what the copy button carries.
    dnsRecord("TXT", "yunori._domainkey.futureforge.dev", `"${dkimValue}"`, "fail", []),
    dnsRecord(
      "TXT",
      "_dmarc.futureforge.dev",
      `"v=DMARC1; p=quarantine; rua=mailto:dmarc@futureforge.dev"`,
      "pass",
      ["v=DMARC1; p=quarantine; rua=mailto:dmarc@futureforge.dev"],
    ),
    dnsRecord("CNAME", "mta-sts.futureforge.dev", `${mailHost}.`, "pass", [`${mailHost}.`], false),
    dnsRecord(
      "TXT",
      "_mta-sts.futureforge.dev",
      `"v=STSv1; id=20260301T000000"`,
      "pass",
      ["v=STSv1; id=20260301T000000"],
      false,
    ),
    dnsRecord(
      "TXT",
      "_smtp._tls.futureforge.dev",
      `"v=TLSRPTv1; rua=mailto:tls-reports@futureforge.dev"`,
      "warn",
      [],
      false,
    ),
    dnsRecord(
      "CNAME",
      "autoconfig.futureforge.dev",
      `${mailHost}.`,
      "pass",
      [`${mailHost}.`],
      false,
    ),
    dnsRecord(
      "SRV",
      "_imaps._tcp.futureforge.dev",
      `0 1 993 ${mailHost}.`,
      "pass",
      [`0 1 993 ${mailHost}.`],
      false,
    ),
  ];
  const zoneFile = dnsRecords
    .map((r) => `${r.name}.\t3600\tIN\t${r.type}\t${r.expected}`)
    .join("\n");

  const [mailDomain] = await db
    .insert(s.mailDomains)
    .values({
      domainId: mailDomainId,
      serverId: mailServerId,
      mailServerId: mailServer!.id,
      isPrimary: true,
      status: "active",
      dnsStatus: "fail",
      dnsCheckedAt: syncedAt,
      dnsRecords,
      zoneFile,
      lastSyncedAt: syncedAt,
    })
    .returning({ id: s.mailDomains.id });

  const mailboxRows = await db
    .insert(s.mailboxes)
    .values(
      [
        { local: "hello", name: "Studio Inbox", quota: 10 },
        { local: "detective", name: "Lone Detective", quota: 20 },
        { local: "billing", name: "Billing", quota: 5 },
        { local: "noreply", name: "No Reply", quota: 1 },
        { local: "support", name: "Support", quota: 0 },
      ].map((m) => ({
        mailDomainId: mailDomain!.id,
        serverId: mailServerId,
        address: `${m.local}@futureforge.dev`,
        localPart: m.local,
        displayName: m.name,
        quotaBytes: Math.round(m.quota * 1024 ** 3),
        status: "active" as const,
        lastSyncedAt: syncedAt,
      })),
    )
    .returning({ id: s.mailboxes.id, address: s.mailboxes.address });
  const mailboxIdByAddress = new Map(mailboxRows.map((row) => [row.address, row.id]));

  await db.insert(s.mailAliases).values(
    [
      { alias: "admin", mailbox: "detective" },
      { alias: "security", mailbox: "detective" },
      { alias: "invoices", mailbox: "billing" },
      { alias: "postmaster", mailbox: "hello" },
    ].map((a) => ({
      mailDomainId: mailDomain!.id,
      serverId: mailServerId,
      address: `${a.alias}@futureforge.dev`,
      mailboxId: mailboxIdByAddress.get(`${a.mailbox}@futureforge.dev`) ?? null,
      mailboxAddress: `${a.mailbox}@futureforge.dev`,
      status: "active" as const,
    })),
  );

  /* ----------------------------- databases ---------------------------- */

  const dbServerId = serverIds["db-01"]!;
  const [pg] = await db
    .insert(s.dbInstances)
    .values({
      serverId: dbServerId,
      engine: "postgres",
      version: "16.2",
      host: "127.0.0.1",
      port: 5432,
      status: "reachable",
      uptimeSeconds: 2_600_000,
      connections: 24,
      maxConnections: 200,
      dataSize: 41 * 1024 ** 3,
      lastSyncedAt: new Date(now - 300_000),
    })
    .returning({ id: s.dbInstances.id });
  const [my] = await db
    .insert(s.dbInstances)
    .values({
      serverId: dbServerId,
      engine: "mariadb",
      version: "11.4.2",
      host: "127.0.0.1",
      port: 3306,
      status: "reachable",
      uptimeSeconds: 2_600_000,
      connections: 6,
      maxConnections: 151,
      dataSize: 4 * 1024 ** 3,
      lastSyncedAt: new Date(now - 300_000),
    })
    .returning({ id: s.dbInstances.id });

  const pgDbs = ["forgebase_prod", "futureforge_www", "kaname_panel", "analytics"];
  for (const name of pgDbs) {
    const [row] = await db
      .insert(s.dbDatabases)
      .values({
        instanceId: pg!.id,
        serverId: dbServerId,
        engine: "postgres",
        name,
        owner: `${name}_app`,
        encoding: "UTF8",
        collation: "en_US.utf8",
        sizeBytes: Math.round(random() * 18 * 1024 ** 3),
        tableCount: 12 + Math.round(random() * 90),
        lastBackupAt: new Date(now - 8 * 3600_000),
        lastSyncedAt: new Date(now - 300_000),
      })
      .returning({ id: s.dbDatabases.id });
    const [user] = await db
      .insert(s.dbUsers)
      .values({
        instanceId: pg!.id,
        serverId: dbServerId,
        engine: "postgres",
        username: `${name}_app`,
        hostPattern: "localhost",
        canLogin: true,
        lastSyncedAt: new Date(now - 300_000),
      })
      .returning({ id: s.dbUsers.id });
    await db.insert(s.dbGrants).values({
      databaseId: row!.id,
      dbUserId: user!.id,
      privileges: ["SELECT", "INSERT", "UPDATE", "DELETE"],
      grantOption: false,
    });
  }

  await db.insert(s.dbDatabases).values({
    instanceId: my!.id,
    serverId: dbServerId,
    engine: "mariadb",
    name: "legacy_shop",
    owner: "shop_app",
    encoding: "utf8mb4",
    collation: "utf8mb4_unicode_ci",
    sizeBytes: 3 * 1024 ** 3,
    tableCount: 64,
    lastSyncedAt: new Date(now - 300_000),
  });
  await db.insert(s.dbUsers).values({
    instanceId: my!.id,
    serverId: dbServerId,
    engine: "mariadb",
    username: "shop_app",
    hostPattern: "localhost",
    authPlugin: "mysql_native_password",
    canLogin: true,
    lastSyncedAt: new Date(now - 300_000),
  });

  /* ------------------------------ security ---------------------------- */

  for (const [name, id] of Object.entries(serverIds)) {
    await db.insert(s.firewallState).values({
      serverId: id,
      backend: name === "edge-01" ? "iptables" : "nftables",
      enabled: true,
      defaultInbound: "deny",
      defaultOutbound: "allow",
      lastAppliedAt: new Date(now - 6 * 86_400_000),
    });

    await db.insert(s.firewallRules).values([
      {
        serverId: id,
        priority: 10,
        action: "allow",
        direction: "inbound",
        protocol: "tcp",
        portSpec: "22",
        sourceCidr: "10.0.0.0/8",
        comment: "SSH from the private network",
        enabled: true,
        hitCount: Math.round(random() * 4000),
      },
      {
        serverId: id,
        priority: 20,
        action: "allow",
        direction: "inbound",
        protocol: "tcp",
        portSpec: "80,443",
        sourceCidr: "0.0.0.0/0",
        comment: "HTTP and HTTPS",
        enabled: true,
        hitCount: Math.round(random() * 900_000),
      },
      {
        serverId: id,
        priority: 30,
        action: "allow",
        direction: "inbound",
        protocol: "icmp",
        portSpec: null,
        sourceCidr: "0.0.0.0/0",
        comment: "ICMP echo",
        enabled: true,
        hitCount: Math.round(random() * 12_000),
      },
    ]);

    await db.insert(s.sshConfigs).values({
      serverId: id,
      port: 22,
      permitRootLogin: "prohibit-password",
      passwordAuthentication: false,
      pubkeyAuthentication: true,
      maxAuthTries: 4,
      allowUsers: ["root", "deploy"],
      lastAppliedAt: new Date(now - 12 * 86_400_000),
      lastSyncedAt: new Date(now - 600_000),
    });
  }

  const threatIps = [
    "45.155.205.233",
    "185.220.101.7",
    "103.156.91.14",
    "212.70.149.83",
    "80.94.95.226",
  ];
  for (const [i, ip] of threatIps.entries()) {
    await db.insert(s.threatEvents).values({
      serverId: serverIds[i % 2 === 0 ? "mail-01" : "forge-01"]!,
      kind: i % 2 === 0 ? "ssh_bruteforce" : "mail_bruteforce",
      sourceIp: ip,
      sourceCountry: ["NL", "DE", "ID", "BG", "RU"][i] ?? "??",
      target: i % 2 === 0 ? "sshd" : "dovecot",
      attempts: 40 + Math.round(random() * 900),
      firstSeen: new Date(now - (20 + i * 3) * 3600_000),
      lastSeen: new Date(now - i * 900_000),
      disposition: i < 3 ? "banned" : "observed",
      sample:
        i % 2 === 0 ? "Failed password for invalid user admin" : "auth failed for user postmaster",
    });
  }

  await db.insert(s.sshKeys).values([
    {
      name: "detective@workstation",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKn1seedkeyforthekanamedemofleet01",
      fingerprint: "SHA256:0Rk1seedfingerprintvalueforkanamedemo01",
      type: "ed25519",
      comment: "detective@workstation",
      serverIds: Object.values(serverIds),
      posixUser: "root",
      lastUsedAt: new Date(now - 4 * 3600_000),
    },
    {
      name: "ci-deploy",
      publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKn2seedkeyforthekanamedemofleet02",
      fingerprint: "SHA256:0Rk2seedfingerprintvalueforkanamedemo02",
      type: "ed25519",
      comment: "github-actions",
      serverIds: [serverIds["forge-01"]!],
      posixUser: "deploy",
      lastUsedAt: new Date(now - 26 * 3600_000),
    },
  ]);

  /* ------------------------------ backups ----------------------------- */

  const [dest] = await db
    .insert(s.backupDestinations)
    .values({
      name: "Backblaze B2 — kaname",
      kind: "b2",
      config: { bucket: "futureforge-backups", prefix: "kaname" },
      status: "ok",
      lastCheckedAt: new Date(now - 3600_000),
      usedBytes: 412 * 1024 ** 3,
      snapshotCount: 148,
    })
    .returning({ id: s.backupDestinations.id });

  for (const [name, id] of Object.entries(serverIds)) {
    const [schedule] = await db
      .insert(s.backupSchedules)
      .values({
        name: `${name} nightly`,
        serverId: id,
        // Selectors the planner accepts: "*" is not a path or a database
        // name, so these schedules could never run — not by hand, and not
        // once the scheduler started firing them at 03:00. An empty
        // selector list is "everything this kind covers".
        scope:
          name === "db-01"
            ? [
                {
                  kind: "databases",
                  selectors: [...pgDbs.map((db) => `postgres:${db}`), "mariadb:legacy_shop"],
                },
              ]
            : [
                { kind: "files", selectors: ["/etc", "/var/www", "/home"] },
                { kind: "config", selectors: [] },
              ],
        cron: "0 3 * * *",
        timezone: "UTC",
        destinationId: dest!.id,
        retention: {
          keep_last: 7,
          keep_daily: 7,
          keep_weekly: 4,
          keep_monthly: 6,
        },
        encryption: true,
        repositoryPath: `b2:futureforge-backups:kaname/${name}`,
        enabled: true,
        lastRunAt: new Date(now - 9 * 3600_000),
        lastRunStatus: name === "mail-01" ? "failed" : "succeeded",
        nextRunAt: new Date(now + 15 * 3600_000),
      })
      .returning({ id: s.backupSchedules.id });

    // Encrypted, so it names its repository password the way a schedule
    // created through the API does. Without a ref the agent refuses every
    // verify and restore of these points ("password_ref is required"),
    // matching snapshot ids or not. No password is stored behind the ref:
    // the seed cannot seal one without the control plane's master key, so
    // the control plane generates and stores it the first time a job is
    // queued for the schedule, and hands it to the host before restic runs
    // (services/backup-secrets.ts).
    await db
      .update(s.backupSchedules)
      .set({ passwordRef: `backup_schedule:${schedule!.id}` })
      .where(sql`${s.backupSchedules.id} = ${schedule!.id}`);

    for (let i = 0; i < 7; i += 1) {
      const started = now - (i * 24 + 9) * 3600_000;
      const failed = name === "mail-01" && i === 0;
      const [run] = await db
        .insert(s.backupRuns)
        .values({
          scheduleId: schedule!.id,
          serverId: id,
          trigger: "scheduled",
          status: failed ? "failed" : "succeeded",
          bytes: failed ? 0 : Math.round(8 * 1024 ** 3 + random() * 4 * 1024 ** 3),
          files: failed ? 0 : 40_000 + Math.round(random() * 20_000),
          startedAt: new Date(started),
          finishedAt: new Date(started + 480_000),
          durationMs: 480_000,
          error: failed ? "repository locked by a previous run that did not exit cleanly" : null,
        })
        .returning({ id: s.backupRuns.id });

      if (!failed) {
        await db.insert(s.restorePoints).values({
          runId: run!.id,
          scheduleId: schedule!.id,
          serverId: id,
          label: `${name}-${new Date(started).toISOString().slice(0, 10)}`,
          // The simulated agent seeds the same repository with the same
          // history (newest first, one a day), so day i here is its
          // snapshot i. A random id verified and restored as "not found".
          snapshotId: simSnapshotId(name, `b2:futureforge-backups:kaname/${name}`, i),
          takenAt: new Date(started + 480_000),
          bytes: Math.round(8 * 1024 ** 3 + random() * 4 * 1024 ** 3),
          fileCount: 40_000 + Math.round(random() * 20_000),
          scope: [{ kind: "files", selectors: ["/etc", "/var/www"] }],
          verifiedAt: i === 0 ? new Date(started + 900_000) : null,
        });
      }
    }
  }

  /* ------------------------------- alerts ----------------------------- */

  const [rule] = await db
    .insert(s.alertRules)
    .values({
      name: "Disk above 85%",
      metric: "disk",
      comparator: "gte",
      threshold: 85,
      durationSeconds: 600,
      severity: "warning",
      scope: { kind: "fleet" },
      enabled: true,
    })
    .returning({ id: s.alertRules.id });

  await db.insert(s.alerts).values({
    ruleId: rule!.id,
    serverId: serverIds["mail-01"]!,
    state: "firing",
    severity: "warning",
    value: 88.4,
    threshold: 85,
    message: "/ is 88% full on mail-01",
    startedAt: new Date(now - 5 * 3600_000),
  });

  console.log(`seeded ${SERVERS.length} simulated servers with 48h of history`);
}

/* ------------------------------------------------------------------ *
 * The simulated agent's restic history, reproduced.
 *
 * agent/src/providers/sim/backups.rs `snapshots_for` materialises a
 * repository the first time it is asked about, with ids derived from
 * the host's identity (its state directory's name, which is the server
 * name in both the dev fleet and the e2e stack) and the repository
 * string. These are the same FNV-1a and splitmix64 it uses, so a seeded
 * restore point names a snapshot the simulated repository really holds.
 * Change one side and the other must follow.
 * ------------------------------------------------------------------ */

const U64 = (1n << 64n) - 1n;
/** `SIM_SEED` in agent/src/providers/sim/state.rs: "kaname". */
const SIM_SEED = 0x6b616e616d65n;

function fnv1a64(value: string): bigint {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & U64;
  }
  return h;
}

function splitmix64(input: bigint): bigint {
  let x = (input + 0x9e3779b97f4a7c15n) & U64;
  x = ((x ^ (x >> 30n)) * 0xbf58476d1ce4e5b9n) & U64;
  x = ((x ^ (x >> 27n)) * 0x94d049bb133111ebn) & U64;
  return x ^ (x >> 31n);
}

/** Snapshot `index` (0 = newest) of `repository` on the simulated host `identity`. */
export function simSnapshotId(identity: string, repository: string, index: number): string {
  const seed = fnv1a64(identity) ^ SIM_SEED ^ fnv1a64(repository);
  const i = BigInt(index);
  const hex = (v: bigint) => v.toString(16).padStart(16, "0");
  return hex(splitmix64(seed ^ i ^ 0xe1n)) + hex(splitmix64(seed ^ i ^ 0xe2n));
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
