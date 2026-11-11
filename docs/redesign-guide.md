# Redesign guide — building pages in the ffstudios.io language

For whoever rebuilds a page on top of the new foundation. Read this, then read code. Rules and
reasons live in [`design-system.md`](design-system.md); the decision is KD-038.

The foundation is done: tokens, every `@kaname/ui` component, and the app shell (sidebar, top
bar, palette, drawers, canvas) already speak the language. Because component APIs did not
change, your page already looks different. Your job is the **composition**: give the page the
ffstudios anatomy, replace local one-off styling with the primitives below, and delete
anything that fights the language.

---

## 1. The language in ten lines

1. **Flat ink, hairlines.** Structure is a 1px line (`--kn-border`), not a filled band. No
   blur, no translucency, no shadow on anything that is part of the page.
2. **Pills for actions.** Every button is a pill. Primary = filled purple; secondary = hairline
   ghost. The one forward action of a view gets the trailing arrow (`arrow`).
3. **Mono uppercase tracked labels** for anything that *annotates*: group names, tabs, table
   headers, metric labels, eyebrows, captions on a diagram. Never for a *value*.
4. **Monospace, in its own case,** for anything greppable: hostnames, IPs, paths, ids, versions.
5. **Tight headlines.** Page title 28px, weight 500, tracking −0.035em (`PageHeader` does it).
   Hero scale and the purple gradient second line are for setup / login / invite / first-run.
6. **Eyebrow chip** (mono word + purple square) names the area above a title.
7. **Numbered sections.** A page body is a stack of `01 Title ····· caption` rows with a
   hairline, each followed by its content.
8. **Status colour means status.** Teal ok, yellow warn, red danger, blue info. Purple is brand
   and selection only. Overall condition is a dot and a sentence (`StatusLine`).
9. **The canvas** (blueprint grid + frame rails + crosshair marks) is drawn by the shell. Keep
   it calm: don't cover it with full-width filled bands and don't draw more decoration on it.
10. **Dense.** 13px base, 36px rows, 16–24px between sections. This is an operator tool.

---

## 2. Page anatomy

Every panel page is: **header → (optional controls row) → numbered sections → content**.

```tsx
import {
  PageHeader, PageBody, NumberedSection, SectionCard, MetricTile, StatusLine, Button,
} from "@kaname/ui";

export default function MonitoringPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        eyebrow="Monitoring"                       // area name → chip with the purple square
        title="Fleet health"                       // the h1; keep e2e-visible names unchanged
        subtitle="4 agents · 1 open alert"         // mono identity line (optional)
        lede="Live readings from every connected agent, and what needs you."  // optional
        status={<StatusLine tone="warn">1 alert open · last sample 12s ago</StatusLine>}
        actions={<Button variant="primary" icon={Plus}>New alert rule</Button>}
        tabs={<ViewTabs … />}                      // optional, sits on the hairline
      />
      <PageBody>                                   {/* px-6 py-6, gap-6 */}
        <NumberedSection index={1} title="At a glance" caption="Fleet-wide, last 24h.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile label="Agents" value="4/4" tone="ok" />
            …
          </div>
        </NumberedSection>

        <NumberedSection index={2} title="Resources" caption="Raw samples per host."
          actions={<TimeRangePicker … />}>
          <div className="grid gap-4 lg:grid-cols-2">
            <SectionCard title="CPU" padded={false}>…chart…</SectionCard>
            <SectionCard title="Memory" padded={false}>…chart…</SectionCard>
          </div>
        </NumberedSection>
      </PageBody>
    </div>
  );
}
```

Variants of the same anatomy:

| Page kind | Shape |
|---|---|
| **List** (most pages) | `ResourcePage` (apps/web/components) — already header + table. Pass `eyebrow="Websites"` and optionally `lede`. Don't wrap the table in sections. |
| **Dashboard / overview** | `PageHeader` + `PageBody` + 2–4 `NumberedSection`s (tiles, charts, attention list). |
| **Detail** | `ResourceHeader` (name + the two status axes + mono identity + tabs) → `DetailLayout` with `SectionCard`s in the main column and `PropertyList` cards in the rail. Number the main-column cards with `index`. |
| **Settings / forms** | `PageHeader` + `<PageBody width="prose">` + one `SectionCard index={n}` per group, `FieldRow`s / `FormField`s inside, the Save pill in the card's `actions`. |
| **Standalone** (setup, login, invite) | `GridBackdrop rails glow="right"` full-screen → `PageHero` (eyebrow, title + gradient `accent`, lede, `lg` pills, `StatusLine`) with the form/card as `aside` or below. `CheckList` for steps. |
| **First-run / empty module** | `PageHero size="md"` inside the body, or `EmptyState` inside the table — never both. |

Gutter: page content sits on **24px** (`px-6`) so it lines up just inside the canvas rails
(which sit at 12px). `PageHeader`, `ResourceHeader`, `PageBody` and `ResourcePage` already do
this — don't add your own horizontal padding around them.

---

## 3. New primitives (`@kaname/ui`, `components/Editorial.tsx`)

All are presentational, forward refs and take `className`.

### `Eyebrow`
Hairline chip, mono uppercase word, trailing purple square.
Props: `tone?: Tone` (square colour, default `accent`), `marker?: boolean`, `icon?`.
```tsx
<Eyebrow>Infrastructure</Eyebrow>
<Eyebrow tone="ok">Live</Eyebrow>
```
One per header. `PageHeader eyebrow="…"` / `PageHero eyebrow="…"` render it for you from a string.

### `MonoLabel`
The mono uppercase tracked label. Props: `as?` (`span` default, `div|p|dt|label|h2|h3|h4`),
`size?: "xs" | "sm"` (10 / 11px), `tone?: "subtle" | "muted" | "fg" | "accent" | "ok" | "warn" | "danger" | "info"`.
```tsx
<MonoLabel>Last deploy</MonoLabel>
<MonoLabel as="dt" size="xs" tone="muted">Region</MonoLabel>
```
CSS equivalents when you only need a class: `kn-label` (11px), `kn-label-sm` (10px). Write the
text in normal case in the source — the class uppercases it, so tests and screen readers see
real words.

### `GradientText`
Purple-soft → purple text. Props: `block?` (own line). At most once per view, hero scale only.
```tsx
<h1 className="kn-headline">Set up <GradientText block>your first server.</GradientText></h1>
```

### `LeaderLabel`
`04 INTERFACE ———` annotation. Props: `index?`, `leader?: "end" | "start" | "both" | "none"`, `tone?`.
```tsx
<LeaderLabel index={2}>Network</LeaderLabel>
<LeaderLabel leader="both">or</LeaderLabel>
```
Use it to caption a region or as a named divider. It is lighter than a `SectionHeader`.

### `StatusLine`
Dot + one muted sentence. Props: `tone?: Tone` (default `ok`), `pulse?`.
```tsx
<StatusLine pulse>Control plane healthy · 4 agents connected</StatusLine>
<StatusLine tone="danger">mail-01 has been unreachable for 25 minutes</StatusLine>
```
For the condition of a whole page or system. A row's state is still a `StatusBadge` /
`HealthBadge` / `AgentConnectionIndicator`.

### `SectionHeader` and `NumberedSection`
The numbered row: mono `01`, title, right-aligned caption, optional actions, hairline.
Props: `index?: number | string` (numbers zero-pad), `title`, `caption?`, `actions?`,
`headingLevel?: 2 | 3 | 4`, `divider?` (SectionHeader only).
```tsx
<NumberedSection index={1} title="Certificates" caption="Issued and renewed automatically.">
  …content…
</NumberedSection>

<SectionHeader index="A" title="Danger zone" divider={false} />
```
`NumberedSection` = `<section>` + `SectionHeader` + children at `gap-4`. Number in reading
order, restart at 01 on every page (and inside each tab).

### `CheckList` / `CheckItem`
Soft purple circle + title + muted description, hairline separators.
`CheckList` props: `divided?: true | "between" | false`.
`CheckItem` props: `title`, `description?`, `state?: "done" | "current" | "todo"`, `icon?`, `action?`.
```tsx
<CheckList divided="between">
  <CheckItem title="Control plane reachable" description="Answering on this origin." />
  <CheckItem state="current" title="Pair a server" description="Run the enroll command on the host."
    action={<Button size="xs" arrow>Open</Button>} />
  <CheckItem state="todo" title="Point a domain" />
</CheckList>
```
Use `divided="between"` directly under a `SectionHeader` or inside a card (they already draw
the outer line). Good for onboarding steps, preflight checks, "what happens next".

### `Card` / `CardInset`
The plain hairline card and its recessed inner panel.
`Card` props: `radius?: "lg" | "xl"` (14 / 18px), `padding?: "none" | "sm" | "md" | "lg"`,
`interactive?` (hover line, for a card that is a link target), `flat?` (canvas colour).
`CardInset` props: `grid?` (blueprint inside), `padding?`.
```tsx
<Card radius="xl" padding="lg">
  <CardInset grid className="h-40">…diagram / big number / code…</CardInset>
  <p className="kn-title mt-4 text-md">Automatic TLS</p>
  <p className="text-sm text-[var(--kn-text-2)]">Issued on first request, renewed at 30 days.</p>
</Card>
```
Use `SectionCard` when the block has a title row; `Card` for free-form tiles.

### `GridBackdrop` and `Crosshair`
Full-bleed blueprint canvas for standalone screens.
Props: `rails?`, `railInset?: number` (px, default 24), `glow?: false | "right" | "left" | "center" | "top"`,
`fade?` (grid fades out downwards), `grid?`.
```tsx
<GridBackdrop rails glow="right" fade className="min-h-dvh px-6 py-16 sm:px-16">
  <PageHero … />
</GridBackdrop>
```
Inside the panel you never need it — `<main>` is already `.kn-canvas`. `glow` is for setup /
login / invite only. `<Crosshair className="left-[18px] top-[-6px]" />` places one "+" mark by
hand; `PageHeader` / `ResourceHeader` already draw theirs (CSS class `kn-crosshairs` on any
full-bleed element with a bottom hairline does the same).

### `PageHero`
Eyebrow → headline (+ gradient second line) → lede → pills → status, optional right column.
Props: `eyebrow?`, `title`, `accent?` (gradient line), `lede?`, `actions?`, `status?`, `aside?`,
`size?: "lg" | "md"`, `align?: "start" | "center"`, `headingLevel?: 1 | 2`.
```tsx
<PageHero
  eyebrow="Setup"
  title="Systems that"
  accent="keep running."
  lede="Pair a server, point a domain, and Kaname takes the repeated work off you."
  actions={<>
    <Button variant="primary" size="lg" arrow>Start setup</Button>
    <Button size="lg" arrow>Read the docs</Button>
  </>}
  status={<StatusLine pulse>Control plane healthy</StatusLine>}
  aside={<Card radius="xl" padding="lg">…</Card>}
/>
```

### `PageBody`
Body wrapper under a header: `px-6 py-6`, flex column. Props: `gap?: "sm" | "md" | "lg"`
(16 / 24 / 40px), `width?: "full" | "prose"` (prose caps at 896px for forms).

### `SegmentedControl`
A pill of mono uppercase segments; a radio group (arrow keys work).
Props: `options: { value, label, icon?, disabled? }[]`, `value`, `onValueChange`, `label`
(accessible name), `size?: "xs" | "sm"`.
```tsx
<SegmentedControl label="View" value={view} onValueChange={setView}
  options={[{ value: "list", label: "List" }, { value: "grid", label: "Grid" }]} />
```
For switching a mode in place. Navigation between views is `Tabs` / `ViewTabs`.

---

## 4. What changed in components you already use

| Component | Now | New props |
|---|---|---|
| `Button`, `IconButton` | Pills. `secondary` is the hairline ghost pill; `primary` is `#7A4FF4`; `danger-subtle` is outlined. | `arrow` (trailing →, nudges on hover), `size="lg"` (44px, hero CTAs) |
| `PageHeader` | 28px tight title, mono subtitle, crosshair marks, transparent over the canvas. | `eyebrow`, `lede`, `status` |
| `ResourceHeader` | Same treatment; breadcrumb slot is mono uppercase. | — |
| `ResourcePage` (app) | Passes through to `PageHeader`. | `eyebrow`, `lede` |
| `SectionCard` | 14px hairline card, tight title. | `index` (mono "01" before the title), `caption` |
| `Tabs` / `Tab`, `ViewTabs` | Mono uppercase tracked triggers, purple underline. | — |
| `DataTable` | 14px card, mono uppercase header labels, mono footer. Rows unchanged (36 / 30px). | — |
| `MetricTile` | Mono uppercase label over a large tight numeral (24px, `sm` 20px). | — |
| `Badge`, `StatusBadge`, `Tag` | Hairline chips in the tone's colour; `StatusBadge` is the pill. Case preserved. | — |
| `Input`, `Select`, `Combobox`, `Textarea` | Recessed hairline boxes (`--kn-field-bg` / `--kn-field-border`). | — |
| `Switch`, `Avatar` | Pill / round. | — |
| `Dialog`, `Drawer` | 18px, strong hairline, tight 16px title, 20px padding. | — |
| `DropdownMenu`, `Popover`, `Combobox` list, `Toast`, `Tooltip` | 14px, strong hairline, restrained shadow. `MenuLabel` is mono uppercase. | — |
| `EmptyState` | Icon on a small blueprint plate with registration ticks. | — |
| `TimeRangePicker` | Pill of mono segments. | — |
| Charts | Mono axis ticks and legend; ramp is purple, teal, blue, yellow, red, grey. Left margin 54px. | — |
| `Kbd` | Hairline chip, no fill. | — |
| `Logo` / `Wordmark` (app) | The three-slab K, two-tone purple. | `mono` (single colour) |

Nothing was removed or renamed.

### Tokens and classes worth knowing

```
--kn-line-control   the 40% line: pill hover, crosshairs      --kn-rail / --kn-grid-line / --kn-grid-size
--kn-field-bg / --kn-field-border   inputs                    --kn-gradient-brand / --kn-glow
--kn-r-xs 4  -sm 6  -md 8  -lg 14  -xl 18  -pill              --kn-ease (expo out)  --kn-ease-std (colour)
--kn-tracking-label .14em  -display -.035em  -title -.015em   --kn-gutter 24px
--kn-font-sans (Geist)  --kn-font-mono (JetBrains Mono)       --kn-font-pixel (Geist Pixel, accents only)
```

Classes (all in `@layer components`, so a Tailwind utility on the same element wins):
`kn-display` (page title) · `kn-headline` (hero) · `kn-title` (card/section title) · `kn-lede` ·
`kn-label` / `kn-label-sm` (mono uppercase) · `kn-mono` (data) · `kn-num` (tabular) ·
`kn-gradient-text` · `kn-grid` (blueprint on any box; set `[--kn-grid-size:16px]` to tighten) ·
`kn-canvas` (grid + rails) · `kn-crosshairs` · `kn-pixel`.

Tailwind aliases (from `theme.css`): `bg-bg`, `bg-surface`, `bg-surface-2`, `border-line`,
`border-line-strong`, `border-line-control`, `text-fg`, `text-muted`, `text-faint`,
`text-accent-hi`, `text-ok|warn|danger|info`, `rounded-xs…xl`, `rounded-pill`,
`tracking-label|display|title`, `text-2xs…2xl`, `text-3xl` (28) `text-4xl` (40) `text-5xl` (56).
The existing code mostly writes `text-[var(--kn-text-2)]` style arbitrary values; either is fine.

---

## 5. Do / don't

**Do**

- Start every page with `PageHeader` / `ResourceHeader` / `ResourcePage`; give it an `eyebrow`
  with the module name (the sidebar group: Infrastructure, Websites, Files, Email, Databases,
  Security, …).
- Break a body into `NumberedSection`s (or `SectionCard index`) with a caption that says what
  the section is *for*, in one sentence, ending with a full stop like the site.
- Use `arrow` on the single forward action: "Continue", "Start setup", the empty-state CTA.
- Put labels in `MonoLabel` / `kn-label-sm` and values in sans (or `kn-mono` if greppable).
- Replace local card markup (`rounded-… border … bg-[var(--kn-surface)]`) with `SectionCard` /
  `Card`; local "uppercase tracking-wider text-2xs" labels with `MonoLabel`; local dot+text
  with `StatusLine`; local step lists with `CheckList`.
- Use `rounded-[var(--kn-r-lg)]` for any card you must hand-roll, `--kn-r-md` for fields,
  `--kn-r-pill` for anything clickable and button-like.
- Keep tables as `DataTable`. Compact, sortable, mono where it matters.
- Check both themes. Light is paper `#F5F4F0` with white cards.

**Don't**

- Don't add `backdrop-blur`, translucent surfaces, `shadow-*` on page content, or coloured
  glows. (Overlays get their shadow from the kit.)
- Don't use the gradient text or the glow inside the panel's routine pages. One gradient line
  per view, hero scale only.
- Don't uppercase by typing capitals, and don't put `kn-label` on a hostname, id, path,
  version, email or any user-supplied name.
- Don't use purple for status, or status colours for decoration.
- Don't put the 40% line (`--kn-line-control`) on things at rest in a dense toolbar; it is the
  hover / emphasis line.
- Don't fill wide header bands (`bg-[var(--kn-surface)]` across the page) — they hide the
  canvas and its rails. Headers are transparent over the grid.
- Don't hardcode hex, px radii or durations; everything is a `--kn-*` token.
- Don't stack more than one eyebrow, one headline and one lede. No decorative illustration; an
  inset blueprint panel (`CardInset grid`) with real content is the house motif.
- Don't make every button `primary`. One filled pill per view region.
- Don't fork a kit component locally. If it lacks something, add a prop in `packages/ui`
  (additive only — other pages depend on it) and mention it in your report.

---

## 6. Things you must not break

- **Copy and names that tests use.** Before changing any visible text, heading, label,
  placeholder, `aria-label` or `data-testid`, grep `e2e/tests` and `packages/ui/src/**/*.test.tsx`.
  E.g. `getByRole("heading", { level: 1, name: "Command Center" })` must keep working — an
  eyebrow or lede is a sibling of the `h1`, not part of it.
- **Accessibility.** One `h1` per page (the header gives it). Section titles are `h2`
  (`NumberedSection`, `SectionCard`), nested ones `h3`. Every icon-only control has a `label`.
  Focus rings come from the kit (2px `--kn-ring`); if you write a raw `<button>`/`<a>` with
  `outline-none`, add `focus-visible:outline-2 focus-visible:outline-offset-2
  focus-visible:outline-[var(--kn-ring)]`. Decorative marks are `aria-hidden`.
- **The two status axes** (`AgentConnectionIndicator` vs `HealthBadge`) are never merged.
- **Jobs, not spinners**; errors keep their remediation (`PageError` / `ErrorState`).
- **Behaviour.** This is a visual redesign: no change to data fetching, routing, permissions
  or form semantics.

---

## 7. Checking your work

Dev servers are already running (web :3000, control plane :4000, hot reload). Don't start or
stop them.

```bash
SNAP=/tmp/claude-0/-home-user-kaname/5360cf53-97c1-5313-a80b-33031f6c4f54/scratchpad/snap.cjs
OUT=/tmp/claude-0/-home-user-kaname/5360cf53-97c1-5313-a80b-33031f6c4f54/scratchpad/<your-area>

node $SNAP $OUT /monitoring /infrastructure/servers        # dark, 1440×900, logs in for you
THEME=light node $SNAP $OUT /monitoring                    # writes monitoring-light.png
FULL=1 node $SNAP $OUT /administration/settings            # full-page
W=820 H=900 node $SNAP $OUT /monitoring                    # narrow (sidebar becomes a drawer)
```

Look at the PNGs (Read tool). References to compare against, same scratchpad:
`ff-top.png`, `ff-1.png`, `ff-2.png`, `ff-3.png` (the site), `foundation/kit_preview.png` and
`foundation/kit_preview-light.png` (every new primitive on one sheet),
`foundation/monitoring.png`, `foundation/infrastructure_servers.png`,
`foundation/websites_sites.png`, `foundation/palette.png`, `foundation/dialog.png`
(the shell and kit after the foundation pass), and `before/` (the old look).

Then:

```bash
pnpm --filter @kaname/ui typecheck && pnpm --filter @kaname/ui test   # if you touched the kit
pnpm --filter @kaname/web typecheck
```

A page is done when, in both themes: it opens with the header anatomy, its body reads as
numbered sections or one table, nothing is blurred / shadowed / filled that should be a
hairline, every action is a pill, every annotation is a mono label, and an operator can still
find and read everything at least as fast as before.
