# Redesign guide — building pages in the plain (KD-044) language

For whoever builds or restyles a page. Rules and reasons live in
[`design-system.md`](design-system.md); the decision is KD-044.

The foundation is done: tokens and every `@kaname/ui` component already draw the new look, and
no prop was removed, so an untouched page already looks different. Your job is the
**composition**: a plain header, a body of titled sections or one table, and nothing that
fights the language.

---

## 1. The language in ten lines

1. **Flat.** Plain background, 1px hairlines (`--kn-border`). No grid, rails, crosshairs,
   blur, translucency, or shadow on anything that is part of the page.
2. **8px corners** on buttons, inputs, cards, tables and menus; 6px on badges; 12px on dialogs.
   Pills only for dots, switches and avatars.
3. **Buttons:** primary = filled purple, secondary = hairline on the surface, ghost = text.
   Heights match inputs (24 / 28 / 32; `lg` 36). No trailing arrows.
4. **Labels** (nav groups, tabs, table headers, metric labels, property keys, captions,
   breadcrumbs): sentence-case sans, 12–13px, muted. Never uppercase, never tracked.
5. **Monospace, in its own case,** only for values: hostnames, IPs, paths, ids, SHAs, versions.
6. **Page title** 24px, weight 600, tracking −0.02em (`PageHeader` does it).
7. **Sections** are a plain 14px semibold title with an optional muted caption. No numbers.
8. **No eyebrow chips** on routine pages. Hero scale, gradient text and eyebrows are for login,
   setup, invite and first run only.
9. **Status colour means status.** Teal ok, yellow warn, red danger, blue info. Purple is brand
   and the primary action. Overall condition is a dot and a sentence (`StatusLine`).
10. **Dense.** 13px base, 36px rows, 16–24px between sections. This is an operator tool.

---

## 2. Page anatomy

Every panel page is: **header → (optional controls row) → sections or one table**.

```tsx
import { PageHeader, PageBody, NumberedSection, SectionCard, MetricTile, StatusLine, Button } from "@kaname/ui";

export default function MonitoringPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Fleet health"                       // the h1; keep e2e-visible names unchanged
        subtitle="4 agents · 1 open alert"         // mono identity line (optional)
        lede="Live readings from every connected agent."  // optional
        status={<StatusLine tone="warn">1 alert open · last sample 12s ago</StatusLine>}
        actions={<Button variant="primary" icon={Plus}>New alert rule</Button>}
        tabs={<ViewTabs … />}                      // optional, sits on the hairline
      />
      <PageBody>                                   {/* px-6 py-6, gap-6 */}
        <NumberedSection title="At a glance" caption="Fleet-wide, last 24h.">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricTile label="Agents" value="4/4" tone="ok" />
          </div>
        </NumberedSection>
        <SectionCard title="CPU" padded={false}>…chart…</SectionCard>
      </PageBody>
    </div>
  );
}
```

| Page kind | Shape |
|---|---|
| **List** (most pages) | `ResourcePage` (apps/web/components) — header + table. Don't wrap the table in sections. |
| **Dashboard / overview** | `PageHeader` + `PageBody` + a few `NumberedSection`s / `SectionCard`s. |
| **Detail** | `ResourceHeader` (name, the two status axes, mono identity, `status` line, actions, `menu`, tabs) → `DetailLayout` with `SectionCard`s in the main column and `PropertyList` cards in the rail. |
| **Settings / forms** | `PageHeader` + `<PageBody width="prose">` + one `SectionCard` per group, the Save button in the card's `actions`. |
| **Standalone** (setup, login, invite) | `GridBackdrop` (calm: no glow unless it earns it) → `PageHero` with the form as `aside` or below. `CheckList` for steps. |
| **First-run / empty module** | `PageHero size="md"` inside the body, or `EmptyState` inside the table — never both. |

Gutter: 24px (`px-6`). `PageHeader`, `ResourceHeader`, `PageBody` and `ResourcePage` already
do this — don't add your own horizontal padding around them.

---

## 3. Primitives (`@kaname/ui`, `components/Editorial.tsx`)

All are presentational, forward refs and take `className`. Props that no longer render
(`index`, `eyebrow` on headers, `arrow`, `CardInset grid`) are still accepted so old call
sites compile; don't add new uses.

- **`MonoLabel`** — the label (the name is historic; it renders sans). `as?`, `size?: "xs" |
  "sm"` (12 / 13px), `tone?` (default `subtle`). Class equivalents: `kn-label` (13px),
  `kn-label-sm` (12px). Write the text in sentence case.
- **`StatusLine`** — dot + one muted sentence. `tone?` (default `ok`), `pulse?`. For a page or
  system; a row's state is a `StatusBadge` / `HealthBadge` / `AgentConnectionIndicator`.
- **`SectionHeader` / `NumberedSection`** — plain title (14px semibold), optional `caption`,
  `actions`, hairline (`divider?`, SectionHeader only). `NumberedSection` = `<section>` +
  header + children at `gap-4`. `index` is ignored.
- **`LeaderLabel`** — a muted label with a hairline running off to one side; a named divider.
  `leader?: "end" | "start" | "both" | "none"`. `index` is ignored.
- **`CheckList` / `CheckItem`** — soft purple circle + title + muted description, hairline
  separators. `divided?: true | "between" | false`; `state?: "done" | "current" | "todo" |
  "warning" | "failed"`, `action?`.
- **`Card`** — the flat 8px hairline container for free-form content. `padding?`,
  `interactive?` (hover line), `flat?` (canvas colour), `radius?: "lg" | "xl"` (`xl` 12px, hero
  only). Use `SectionCard` when the block has a title row.
- **`CardInset`** — a recessed well for code, a terminal sample or a preview. Not a second card.
- **`PageBody`** — `px-6 py-6` flex column. `gap?: "sm" | "md" | "lg"`, `width?: "full" |
  "prose"`.
- **`SegmentedControl`** — 8px hairline box of segments, neutral selected fill; a radio group.
  For switching a mode in place; navigation is `Tabs` / `ViewTabs`.
- **Hero only:** `PageHero`, `GradientText`, `Eyebrow`, `GridBackdrop`.

---

## 4. What changed in components you already use

| Component | Now |
|---|---|
| `Button`, `IconButton` | 8px corners (`xs` 6px); `secondary` is a hairline on `--kn-surface`; `lg` is 36px. `arrow` renders nothing. |
| `PageHeader` | 24px semibold title, mono subtitle, sans breadcrumb, hairline. `eyebrow` not rendered. |
| `ResourceHeader` | Same treatment. New: `status` (line under the identity) — it replaces `DetailHeader`. |
| `SectionCard` | Flat 8px hairline card, 14px semibold title. `index` ignored. |
| `Tabs` / `Tab` | Underline tabs, 13px sentence case, active = foreground text + 2px foreground underline. |
| `DataTable` | 8px card; header labels sentence-case sans, muted. Rows unchanged (36 / 30px). |
| `MetricTile` | Muted sans label over a semibold numeral. |
| `Badge`, `StatusBadge`, `Tag` | 6px chips in the tone's colour. Case preserved. |
| `Input`, `Select`, `Combobox`, `Textarea` | 8px hairline boxes (`xs` 6px), heights matching buttons, purple focus ring. |
| `Dialog`, `Drawer` | 12px corners, 16px semibold title. |
| `DropdownMenu`, `Popover`, `Combobox` list, `Toast` | 8px, strong hairline, restrained shadow. |
| `EmptyState` | Icon in a plain hairline tile. |
| `TimeRangePicker` | Same box as `SegmentedControl`; values in mono, own case. |

Nothing was removed or renamed.

### Tokens and classes worth knowing

```
--kn-r-xs 4  -sm 6  -md 8  -lg 8  -xl 12  -pill (dots, switches, avatars)
--kn-tracking-label 0   -display -.02em   -title -.015em      --kn-gutter 24px
--kn-field-bg / --kn-field-border   inputs                    --kn-ease / --kn-ease-std
--kn-font-sans (Geist)  --kn-font-mono (JetBrains Mono)       --kn-font-pixel (accents only)
```

Classes (in `@layer components`, so a Tailwind utility on the same element wins):
`kn-display` (page title) · `kn-headline` (hero) · `kn-title` · `kn-lede` · `kn-label` /
`kn-label-sm` (sentence-case labels) · `kn-mono` (values) · `kn-num` (tabular) ·
`kn-gradient-text` (hero) · `kn-canvas` (plain background) · `kn-pixel`. `kn-grid` and
`kn-crosshairs` draw nothing any more; delete them when you touch a file.

Tailwind aliases (from `theme.css`): `bg-surface`, `border-line`, `text-fg`, `text-muted`,
`text-faint`, `text-ok|warn|danger|info`, `rounded-xs…xl`, `text-2xs…5xl`. Arbitrary
`text-[var(--kn-text-2)]` style values are fine too.

---

## 5. Do / don't

**Do**

- Start every page with `PageHeader` / `ResourceHeader` / `ResourcePage`.
- Give a section a caption that says what it is *for*, in one short sentence.
- Use `SectionCard` / `Card` instead of local card markup; `MonoLabel` / `kn-label-sm` instead
  of local label styles; `StatusLine` for dot + text; `CheckList` for steps.
- Hand-rolled card: `rounded-[var(--kn-r-lg)] border border-[var(--kn-border)]
  bg-[var(--kn-surface)]`. Hand-rolled field: `--kn-r-md`.
- Keep tables as `DataTable`.
- Check both themes. Light is paper `#F5F4F0` with white cards.

**Don't**

- Don't use `uppercase`, `tracking-[0.1em]`-style tracking or mono on labels; don't put
  `kn-label` on a hostname, id, path, version, email or user-supplied name.
- Don't number sections, draw leader dots, or add eyebrow chips to routine pages.
- Don't use `rounded-full` / `--kn-r-pill` on anything button-like.
- Don't add grids, rails, crosshairs, `backdrop-blur`, translucent surfaces, `shadow-*` on page
  content, glows or gradient text inside the panel.
- Don't use purple for status, or status colours for decoration.
- Don't make every button `primary`. One per view region.
- Don't hardcode hex, px radii or durations; everything is a `--kn-*` token.
- Don't fork a kit component locally. If it lacks something, add a prop in `packages/ui`
  (additive only) and mention it in your report.

---

## 6. Things you must not break

- **Copy and names that tests use.** Before changing any visible text, heading, label,
  placeholder, `aria-label` or `data-testid`, grep `e2e/tests` and `packages/ui/src/**/*.test.tsx`.
- **Accessibility.** One `h1` per page (the header gives it). Section titles are `h2`, nested
  ones `h3`. Every icon-only control has a `label`. Focus rings come from the kit; a raw
  `<button>`/`<a>` with `outline-none` needs `focus-visible:outline-2
  focus-visible:outline-offset-2 focus-visible:outline-[var(--kn-ring)]`.
- **The two status axes** (`AgentConnectionIndicator` vs `HealthBadge`) are never merged.
- **Jobs, not spinners**; errors keep their remediation (`PageError` / `ErrorState`).
- **Behaviour.** A visual change never touches data fetching, routing, permissions or form
  semantics.

---

## 7. Checking your work

```bash
pnpm --filter @kaname/ui typecheck && pnpm --filter @kaname/ui test   # if you touched the kit
pnpm --filter @kaname/web typecheck
```

Then look at the page in both themes and at a narrow width. It is done when it opens with the
header, its body reads as titled sections or one table, nothing is decorated, and an operator
can find and read everything at least as fast as before.
