# Kaname design system

> **A plain, flat hosting panel in the Vercel / Render mould.** Ink canvas, paper text, one
> brand purple, hairlines instead of fills, 8px corners on controls and cards, sentence-case
> sans labels, monospace only for values. Kaname keeps its own `--kn-*` token names; only the
> values changed. Decision record: KD-044 (supersedes KD-038's decoration, label, numbered
> section, eyebrow and pill rules; keeps its palette, fonts and status rules).
>
> Building or restyling a page? Read [`redesign-guide.md`](redesign-guide.md). This file is the
> rules and the reasons.

The rules that keep fifty-odd pages feeling like one product. If a page needs something that
is not here, the component in `@kaname/ui` grows a prop — it does not get a local variant.

---

## 1. What this is, and is not

It **is** a calm product UI: a flat background, a 24px page title, hairline cards and tables,
underline tabs, 8px buttons and inputs of matching height, one purple primary action per view,
a teal dot and a sentence for status.

It is **not** decorated. No blueprint grid, frame rails or "+" crosshair marks in the panel. No
numbered section rows, no leader dots, no eyebrow chips on routine pages, no uppercase tracked
labels, no pill buttons, no trailing arrows. The hero scale (`PageHero`, `GradientText`,
`.kn-headline`, `GridBackdrop`) is kept for login, setup, invite and first-run states only, and
stays calm there too.

Operator rules still hold: tables stay 36px-row dense, anything greppable stays monospace in its
own case, status colour means status and nothing else.

Deliberately not referenced, at any level: cPanel, Plesk, DirectAdmin, Webmin, HestiaCP,
CyberPanel, aaPanel, Bootstrap/Tailwind admin templates, crypto dashboards, cyberpunk
dashboards, glassmorphism, vibrancy or backdrop blur, gradient washes behind content, giant
metric cards, decorative illustration.

No literal Japanese imagery either — no anime, samurai, temples, blossoms or decorative kanji.
The name means *keystone* / *pivot*; the influence lives in restraint and precision, not
decoration.

---

## 2. Colour

Ink canvas, essentially monochrome, one purple accent used sparingly. Dark is the default and
the design target; light ships with the same token names on a paper palette.

```
                  dark             light
--kn-bg           #0A0A0C          #F5F4F0     canvas (ink / paper)
--kn-bg-inset     #060608          #ECEAE4     the recess: terminal, code wells, CardInset
--kn-surface      #131316          #FFFFFF     cards, tables, secondary buttons
--kn-surface-2    #1A1A1F          #F0EEE9     menus, popovers, hover
--kn-surface-3    #24242B          #E6E3DC     pressed, active row, selected segment
--kn-border       white 8%         ink 11%     the hairline
--kn-border-str   white 16%        ink 22%     controls, chips, overlays
--kn-line-control white 40%        ink 42%     input border on hover
--kn-rail         white 8%         ink 8%      hero-only rails (GridBackdrop)
--kn-grid-line    white 2.6%       ink 3%      hero-only grid (GridBackdrop)
--kn-field-bg     white 3%         #FFFFFF     inputs
--kn-field-border white 14%        ink 18%     inputs
--kn-text         #F5F4F0          #0A0A0C     primary          (18.0:1 / 18.0:1 on bg)
--kn-text-2       #B3B2AF          #52525B     muted, labels    (9.3:1 / 7.0:1)
--kn-text-3       #8E8D8B          #6B6B74     subtle           (6.0:1 / 4.8:1)
```

**Accent: brand purple `#7A4FF4`.** It fills the primary button (white on it is 4.9:1) and the
focus ring. It is never small text on ink (4.0:1) — text accent is 400. Tabs, segments and
selection use the foreground colour, not purple.

```
                  dark             light
--kn-accent-300   #C9B6FF          #5A30D4     gradient start, highlights
--kn-accent-400   #A98DF8          #6A3EE8     links, active icons (7.4:1 / 5.5:1)
--kn-accent-500   #7A4FF4          #7A4FF4     primary fill, indicators
--kn-accent-600   #6A3EE8          #6A3EE8     primary hover
--kn-accent-700   #5A30D4          #5A30D4     pressed
--kn-accent-900   #3B2391          —           glow floor (hero only)
--kn-gradient-brand   95deg  #C9B6FF → #A98DF8 30% → #7A4FF4     (hero only)
--kn-glow             radial purple, behind hero art only
```

**Semantic colour means status — never decoration.**

```
                  dark             light
--kn-ok           #4FE3CB teal     #0B7564     (12.4:1 / 5.1:1)
--kn-warn         #FBB13C yellow   #8F5300     (10.8:1 / 5.6:1)
--kn-danger       #F45B69 red      #C42B3C     (6.2:1 / 5.1:1)
--kn-info         #7CB7FF          #22639E
```

Each has a `-soft` tint (10–12% alpha) used as a chip fill. Purple is brand and selection; it is
not a status.

Rules:

- The gradient and the glow exist only on hero screens (login, setup, invite, first run).
- No coloured shadows, no gradient fills on surfaces, no tinted cards for decoration.
- Charts lead with purple, then teal, blue, yellow, red, grey (`--kn-chart-1…6`).

---

## 3. Space, size, shape

- **Grid:** 4px. Spacing is a closed set (`Stack`/`Inline` `gap` props, Tailwind's scale); no
  arbitrary values.
- **Radius:** chips and badges 6px (`--kn-r-sm`); buttons, inputs, selects, cards, tables and
  menus 8px (`--kn-r-md`, `--kn-r-lg`); dialogs and drawers 12px (`--kn-r-xl`). The pill
  (`--kn-r-pill`) is only for dots, switches and avatars — never an action.
- **Heights match:** button and input `xs` 24, `sm` 28, `md` 32; button `lg` 36.
- **Flat.** No vibrancy, blur or translucency. The canvas (`.kn-canvas`) is a plain background:
  nothing is drawn on it.
- **Depth:** none on anything that is part of the page, in both themes (`--kn-shadow-sm` is
  empty). Floating overlays — menus, popovers, tooltips, toasts (`-md`), dialogs and drawers
  (`-lg`) — keep a restrained neutral drop and a `--kn-border-strong` outline.
- **Hairlines carry the structure.** One 1px border around a card or table; no card inside a
  card. `CardInset` is for code wells and previews only.
- **Focus:** one ring for the whole product: 2px `--kn-ring` (purple), 2px off the edge,
  following the element's corner.
- **Density:** table rows are 36px, 30px in compact mode. Base font size is 13px. Section gaps
  are 16–24px. Content sits on a 24px gutter (`--kn-gutter`).
- **Card vs table:** default to the table. A card is for something genuinely singular — a
  metric tile, an attention item — not for a list of records.

---

## 4. Type

- **Geist Sans** — everything that is not a value. Loaded by `next/font` from the `geist`
  package (OFL) as `--font-geist-sans`. 13px base, 12px secondary.
  - `.kn-display` — the page title: 24/32px, weight 600, tracking −0.02em.
  - `.kn-title` — card, section and dialog titles: weight 600 (14px sections, 16px dialogs).
  - `.kn-label` (13px) / `.kn-label-sm` (12px), `<MonoLabel>` — **labels**: nav groups, tabs,
    table headers, metric labels, property keys, captions, breadcrumbs. Sentence case, weight
    500, normal letter-spacing, muted colour. Never uppercase, never tracked. (`MonoLabel` keeps
    its name; it renders sans now.)
  - `.kn-lede` — 14/22px muted sentence under a title.
  - `.kn-headline` — the hero size, login / setup / invite / first run only.
- **JetBrains Mono** (self-hosted from `@fontsource`) — **values only**, in their own case:
  hostnames, IPs, ports, paths, ids, SHAs, versions, unit names, log lines, commands
  (`.kn-mono`, `<MonoText>`, `mono` props). Never for labels.
- **Geist Pixel Square** (`.kn-pixel`) — small brand accents only. Never body, never titles.
- No call to Google Fonts or any font CDN, ever; every face is self-hosted.
- **Tabular numerals everywhere numbers stack vertically.** Applied globally to tables and to
  `.kn-num`.
- Sentence case for every heading, label, tab, button and sentence.

---

## 5. Motion

150 / 240 / 400 ms (`--kn-dur-fast`, `--kn-dur`, `--kn-dur-slow`). `--kn-ease` is ease-out-expo
`cubic-bezier(.16, 1, .3, 1)` for anything that moves (overlays entering, the sidebar width);
`--kn-ease-std` is `cubic-bezier(.4, 0, .2, 1)` for colour and border changes. `opacity` and
`transform` only.

No bounce, no spring physics, no page transitions, no staggered list entrances, no skeleton
shimmer sweeping across the screen, no scroll-driven animation.

Three entrance animations exist: `kn-fade-in`, `kn-rise` (4px), `kn-scale-in` (0.98 → 1). Plus
`kn-spin` for spinners and `kn-pulse-ring` for the one thing that legitimately needs attention.
Everything respects `prefers-reduced-motion`.

---

## 6. The two status axes

This is the most important consistency rule in the product.

| Component | Question | States |
|---|---|---|
| `AgentConnectionIndicator` | Can we reach the box? | connected · degraded · disconnected · never_enrolled · revoked |
| `HealthBadge` | Is the box OK? | healthy · warning · critical · unknown |

They are independent and are **never** collapsed into one dot. A server can be connected and
critical (disk full), or disconnected and unknown. Showing one green dot for both is how panels
end up telling operators everything is fine while a host is unreachable.

`connected` is a quiet steady dot — reachability is the normal case and should not shout.
`degraded` pulses. `disconnected` is hollow. Each carries a tooltip saying what the state means
and, where it applies, since when.

---

## 7. Jobs, not spinners

Every mutation that crosses the network to a host renders a `JobStatusPill`
(`queued → running → succeeded | failed | cancelled | timed_out`), not a spinner followed by a
toast. The job drawer streams its log. This is a component contract, not a per-page choice —
see [KD-008](../DECISIONS.md).

Control-plane-only mutations (creating a domain row, editing a role) may resolve inline with a
toast, because there is no remote machine that might be slow or gone.

---

## 8. Every list page

Non-negotiable checklist, because consistency across ~30 list pages is what makes the product
learnable:

- Search, filter, sort, pagination, bulk actions.
- **Loading:** `SkeletonRow` matching the real column widths. Never a centred spinner.
- **Empty:** `EmptyState` with a one-sentence description and the primary action. Calm — the
  icon sits on a small blueprint plate; no illustration, no oversized glyph.
- **Error:** `ErrorState` with the actual problem and what to do about it.
- **Staleness:** anything read from cache shows "synced 12s ago" with a Refresh control
  ([KD-012](../DECISIONS.md)). Stale data is surfaced, never hidden.

### Errors have remediations

Not this:

> Something went wrong.

This:

> **DNS record `_acme-challenge.example.com` not found**
> Let's Encrypt could not validate the challenge. The record may not have propagated yet.
> `[Check DNS]` `[Retry]`

Every API error carries `{ code, message, remediation: { summary, actions[] } }`. An action is
a link, a re-dispatchable action id, or a literal value to copy. If the control plane knows what
is wrong, the operator sees it.

---

## 9. Destructive actions

Three tiers:

1. **Reversible** (stop a service) — a plain confirm dialog.
2. **Hard to undo** (drop a database, delete a mailbox, restore over live files) — `ConfirmDialog`
   with `confirmText`: the operator types the resource's own name. The confirm button stays
   disabled until it matches.
3. **Could lock you out** (firewall rules, sshd config) — applied behind a rollback window. The
   host reverts unless the operator confirms within the timeout, and the countdown is a
   persistent banner, not a toast.

---

## 10. Keyboard

The command palette (`⌘K` / `Ctrl+K`) is a signature interaction, not a search box. It searches
every resource type *and* exposes actions — "Restart nginx on web-01", "Issue certificate for
example.com" — filtered by what the caller may actually do.

```
⌘K / Ctrl+K   command palette
g then s/w/d/c/m/f/b   jump to Servers / Websites / Domains / Containers / Mailboxes / Files / Databases
/             focus the list search
j / k         move the focused row
Enter         open the focused row
x             toggle selection
?             shortcut sheet
Esc           close the topmost overlay
```

Every interactive element is reachable by Tab with a visible focus ring. Overlays trap focus and
return it to the trigger. Semantic HTML first; ARIA only where semantics run out.

---

## 11. Responsive

Desktop-first — this is infrastructure software and the primary surface is a wide screen — but
it degrades properly:

- **≤1024px:** the sidebar becomes a drawer.
- **≤768px:** columns marked `hideBelow` collapse into a secondary line under the primary cell;
  row actions move into an overflow menu; the toolbar wraps.

Tables never scroll horizontally by default. If a column does not fit, it collapses.

---

## 12. The mark

In the FutureForge family: solid, forward-leaning slabs in the brand purple, two-tone, no
outline. Where the FutureForge mark is an F made of raked bars, Kaname's is a K made of three —
a raked stem and two arms meeting it at one point. That meeting point is the name: 要 is the
pivot pin of a folding fan, the keystone everything else turns on. Three filled polygons, so it
survives 16px in the sidebar and as a favicon (`components/Logo.tsx`, `app/icon.svg`).

The wordmark is "Kaname" in Geist Sans at weight 500 with −0.03em tracking, set beside the mark
the way "FutureForge" sits beside its F.
