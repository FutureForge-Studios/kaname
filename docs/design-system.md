# Kaname design system

> **Visual language: FutureForge Studios — [ffstudios.io](https://ffstudios.io) — adapted to a
> dense infrastructure control panel.** Ink canvas, paper text, one brand purple, hairlines
> instead of fills, pills for actions, mono uppercase tracked labels for everything that
> annotates, a faint blueprint grid with frame rails behind the content. Kaname keeps its own
> `--kn-*` token names; only the values changed. Decision record: KD-038 (supersedes KD-036).
>
> Building or restyling a page? Read [`redesign-guide.md`](redesign-guide.md) — it has every
> primitive with a snippet and the page anatomy. This file is the rules and the reasons.

The rules that keep thirty-odd pages feeling like one product. If a page needs something that
is not here, the component in `@kaname/ui` grows a prop — it does not get a local variant.

---

## 1. What this is, and is not

It **is** the ffstudios.io language: big tight-tracked headlines, a purple gradient on the
second line of a hero, mono uppercase labels, eyebrow chips with a purple square, numbered
section rows ("01  Title ······· caption"), leader annotations, pill buttons with a trailing
arrow, hairline cards with an inset panel, a blueprint grid with frame rails and "+"
registration marks, a teal dot and a sentence for status.

It is **adapted**, not transplanted. The marketing site sells; this panel is operated forty
times a day. So tables stay 36px-row dense, anything greppable stays monospace in its own case,
status colour means status and nothing else, and the hero scale is reserved for onboarding,
sign-in and first-run states.

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
the design target; light ships with the same token names on the ffstudios paper palette.

```
                  dark             light
--kn-bg           #0A0A0C          #F5F4F0     canvas (ink / paper)
--kn-bg-inset     #060608          #ECEAE4     the recess: terminal, code wells, CardInset
--kn-surface      #131316          #FFFFFF     cards, tables (ink-2)
--kn-surface-2    #1A1A1F          #F0EEE9     menus, popovers, hover (ink-3)
--kn-surface-3    #24242B          #E6E3DC     pressed, active row
--kn-border       white 8%         ink 11%     the hairline
--kn-border-str   white 16%        ink 22%     chips, overlays, secondary pill at rest
--kn-line-control white 40%        ink 42%     secondary pill on hover, crosshair marks
--kn-rail         white 8%         ink 8%      frame rails
--kn-grid-line    white 2.6%       ink 3%      blueprint grid (64px cell)
--kn-field-bg     white 3%         #FFFFFF     inputs
--kn-field-border white 14%        ink 18%     inputs
--kn-text         #F5F4F0          #0A0A0C     primary          (18.0:1 / 18.0:1 on bg)
--kn-text-2       #B3B2AF          #52525B     muted (paper 72%) (9.3:1 / 7.0:1)
--kn-text-3       #8E8D8B          #6B6B74     subtle (paper 56%) (6.0:1 / 4.8:1)
```

**Accent: FF purple `#7A4FF4`.** It fills the primary pill (white on it is 4.9:1), draws the
active indicator and the eyebrow square. It is never small text on ink (4.0:1) — text accent is
400.

```
                  dark             light
--kn-accent-300   #C9B6FF          #5A30D4     gradient start, highlights
--kn-accent-400   #A98DF8          #6A3EE8     links, active icons, the one hot datum (7.4:1 / 5.5:1)
--kn-accent-500   #7A4FF4          #7A4FF4     primary fill, indicators, the purple square
--kn-accent-600   #6A3EE8          #6A3EE8     primary hover
--kn-accent-700   #5A30D4          #5A30D4     pressed
--kn-accent-900   #3B2391          —           primary-deep, glow floor
--kn-gradient-brand   95deg  #C9B6FF → #A98DF8 30% → #7A4FF4     (.kn-gradient-text / <GradientText>)
--kn-glow             radial purple, behind feature art only
```

**Semantic colour is the ffstudios accent trio, and it means status — never decoration.**

```
                  dark             light
--kn-ok           #4FE3CB teal     #0B7564     (12.4:1 / 5.1:1)
--kn-warn         #FBB13C yellow   #8F5300     (10.8:1 / 5.6:1)
--kn-danger       #F45B69 red      #C42B3C     (6.2:1 / 5.1:1)
--kn-info         #7CB7FF          #22639E     derived: the ff palette has no blue
```

Each has a `-soft` tint (10–12% alpha) used as a chip fill. Chips carry a hairline in their own
colour (`currentColor` at 24%). Purple is brand and selection; it is not a status.

Rules:

- A page uses the gradient at most once, on a headline's second line, and only at hero scale.
- The glow exists only behind feature art on standalone screens (setup, login, invite). Never
  inside the panel.
- No coloured shadows, no gradient fills on surfaces, no tinted cards for decoration.
- Charts lead with purple, then teal, blue, yellow, red, grey (`--kn-chart-1…6`).

---

## 3. Space, size, shape

- **Grid:** 4px. Spacing is a closed set (`Stack`/`Inline` `gap` props, Tailwind's scale); no
  arbitrary values.
- **Radius:** chips 4–6px (`--kn-r-xs` 4, `--kn-r-sm` 6), fields 8px (`--kn-r-md`), cards and
  tables 14px (`--kn-r-lg`), dialogs and feature cards 18px (`--kn-r-xl`, the ffstudios card),
  and **the pill (`--kn-r-pill`) for every action**: buttons, icon buttons, status badges,
  segmented controls, switches, avatars.
- **Flat.** No vibrancy, no backdrop blur, no translucency. The sidebar and top bar are solid
  ink with a hairline, like the ffstudios header (`.kn-material` is kept as a class name and is
  now simply the canvas colour).
- **Depth:** none on anything that is part of the page in dark (`--kn-shadow-sm` is empty on
  ink); on paper, cards get the ffstudios card's one tight line plus a wide, very soft drop.
  Floating overlays — menus, popovers, tooltips, toasts (`-md`), dialogs and drawers (`-lg`) —
  keep a restrained neutral drop in both themes and a `--kn-border-strong` outline.
- **Hairlines carry the structure.** A section is a row with a line under it, not a filled
  band. Full-bleed hairlines (the page header's) get "+" crosshair marks where they cross the
  frame rails.
- **The canvas:** the panel's main area is `.kn-canvas` — the 64px blueprint grid at ~3% plus
  two vertical rails 12px in from each edge. Content sits on a 24px gutter (`--kn-gutter`), just
  inside the rails. It must stay calm: nothing else may be drawn on the canvas.
- **Focus:** one ring for the whole product: 2px `--kn-ring`, 2px off the edge, following the
  element's corner. Dark `#A98DF8` (7.4:1 on canvas), light `#6A3EE8` (5.5:1).
- **Density:** table rows are 36px, 30px in compact mode. Base font size is 13px. Section gaps
  are 16–24px. Top bar 52px, sidebar 240px (56px collapsed). This product should show a lot
  without scrolling.
- **Card vs table:** default to the table. A card is for something genuinely singular — a
  metric tile, an attention item — not for a list of records.

---

## 4. Type

Three lanes, each with one job.

- **Geist Sans** — interface and headlines. Loaded by `next/font` from the `geist` package
  (OFL) as `--font-geist-sans`. It stands in for the site's Satoshi, which is licensed to
  ffstudios.io only and is never used in this public repository. 13px base, 12px secondary,
  14/16px titles. Weight 500 for emphasis and headlines; nothing bolder.
  - `.kn-display` — the in-panel page title: 28/32px, weight 500, tracking −0.035em.
  - `.kn-headline` — the hero: clamp(36px, 5vw, 64px), leading 1.02, tracking −0.045em.
  - `.kn-title` — card and section titles: weight 500, tracking −0.015em.
  - `.kn-lede` — 15/24px muted sentence under a headline.
- **JetBrains Mono** (self-hosted from `@fontsource`, 400/500/600) — two uses:
  - **Data**, in its own case: anything an operator would type, copy or grep — IPs, ports,
    paths, hashes, unit names, container ids, log lines, DNS records, commands (`.kn-mono`,
    `<MonoText>`, `mono` props). This is not decorative: it is what makes a path scannable.
  - **Labels**, uppercase and wide-tracked (`.kn-label` 11px, `.kn-label-sm` 10px,
    letter-spacing 0.14em; `<MonoLabel>`): navigation groups, tabs, table headers, metric
    labels, eyebrows, breadcrumbs, axis and annotation labels. Labels annotate; they are never
    a value. Never uppercase an identifier.
- **Geist Pixel Square** (`.kn-pixel`) — kept for small brand accents (a numeral, a version
  stamp). Never body, never titles.
- No call to Google Fonts or any font CDN, ever; every face is self-hosted.
- **Tabular numerals everywhere numbers stack vertically.** Applied globally to tables and to
  `.kn-num`.
- Sentence case for every heading, button and sentence. Uppercase exists only through the mono
  label classes — never typed in the source, so screen readers and tests see real words.

---

## 5. Motion

150 / 240 / 400 ms (`--kn-dur-fast`, `--kn-dur`, `--kn-dur-slow`). Two curves, both from the
ffstudios site: `--kn-ease` is ease-out-expo `cubic-bezier(.16, 1, .3, 1)` for anything that
moves (overlays entering, the arrow nudge, the sidebar width); `--kn-ease-std` is
`cubic-bezier(.4, 0, .2, 1)` for colour and border changes. `opacity` and `transform` only.

No bounce, no spring physics, no page transitions, no staggered list entrances, no skeleton
shimmer sweeping across the screen, no scroll-driven animation. A panel that animates when you
are trying to read a disk-usage figure is working against you.

Three entrance animations exist: `kn-fade-in`, `kn-rise` (4px), `kn-scale-in` (0.98 → 1). Plus
`kn-spin` for spinners and `kn-pulse-ring` for the one thing that legitimately needs attention.
The one flourish is the primary action's trailing arrow, which nudges 2px on hover. Everything
respects `prefers-reduced-motion`.

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
