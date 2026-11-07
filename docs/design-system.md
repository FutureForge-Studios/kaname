# Kaname design system

> **Visual language: the FF Studios design (FutureForge Studios), with an Apple-style UI layer.**
> Palette, type lanes and the one-accent rule come from the ffstudios design system; corners,
> materials, depth, motion and focus follow Apple's platform conventions. Kaname keeps its own
> `--kn-*` token names; only the values changed. Decision record: KD-036.

The rules that keep thirty-odd pages feeling like one product. If a page needs something that
is not here, the component in `@kaname/ui` grows a prop — it does not get a local variant.

---

## 1. What this is not

Deliberately not referenced, at any level: cPanel, Plesk, DirectAdmin, Webmin, HestiaCP,
CyberPanel, aaPanel, Bootstrap/Tailwind admin templates, crypto dashboards, cyberpunk
dashboards, glassmorphism, gradient washes, giant metric cards, pill-shaped everything,
decorative illustration.

No literal Japanese imagery either — no anime, samurai, temples, blossoms or decorative kanji.
The name means *keystone*; the influence lives in restraint and precision, not decoration. The
only Japanese element in the product is 要 as a secondary mark, used as a glyph, never as
ornament.

Translucency is not glassmorphism here: exactly two surfaces are materials (the sidebar and the
top bar, §3), and no card, menu or dialog is ever see-through.

Principles taken from elsewhere — principles only, never layout: Linear's typographic hierarchy
and density, Vercel's calm treatment of infrastructure, Raycast's command-palette-first
interaction, GitHub's information density.

---

## 2. Colour

Ink canvas, essentially monochrome, one purple accent used sparingly. Dark is the default and
the design target; light ships with the same token names on the ffstudios paper palette.

```
                 dark            light
--kn-bg          #0A0A0C         #F5F4F0     canvas (ink / paper)
--kn-bg-inset    #060608         #ECEAE4     the recess: terminal, code wells
--kn-surface     #131316         #FFFFFF     cards, tables
--kn-surface-2   #1A1A1F         #F0EEE9     raised, hover, menus
--kn-surface-3   #24242B         #E8E5DE     pressed, active row
--kn-border      white 8%        #DEDBD3     hairlines
--kn-border-str  white 16%       #C8C4BA     emphasised, hover boundary
--kn-text        #F4F4F5         #0A0A0C     primary          (18.0:1 / 18.0:1 on bg)
--kn-text-2      #B4B4BC         #52525B     secondary        (9.6:1 / 7.0:1)
--kn-text-3      #8A8A93         #6E6E78     tertiary         (5.8:1 / 4.6:1)
```

**Accent: FF purple `#7A4FF4`.** Never text at 500 (4.0:1 on ink); it fills, it outlines, it
lights the brand mark.

```
                 dark            light
--kn-accent-300  #C9B8FB         #8B66F6     tints
--kn-accent-400  #A98DF8         #6A3EE8     links, active icons, the one hot datum (7.4:1 / 5.5:1)
--kn-accent-500  #7A4FF4         #7A4FF4     brand, borders, selected outline
--kn-accent-600  #6A3EE8         #6A3EE8     primary button fill (white on it: 6.1:1)
--kn-accent-700  #5A30D4         #5A30D4     pressed
```

On paper, ffstudios' accent-fg `#A98DF8` is only 2.4:1, so 400 takes `primary-ink` `#6A3EE8`
there. The primary button rests on 600 and hovers to 500 (white on it: 4.9:1).

**Semantic.** From the ffstudios secondary hues, each with a `-soft` background at 14% (12% on
paper):

```
                 dark            light
--kn-ok          #4FE3CB teal    #0B7564     (12.4:1 / 5.1:1)
--kn-warn        #FBB13C yellow  #8F5300     (10.8:1 / 5.6:1)
--kn-danger      #F45B69 red     #C42B3C     (6.2:1 / 5.1:1)
--kn-info        #7CB7FF         #22639E     (9.5:1 / 5.7:1) derived: ffstudios has no blue
```

The light values are the same hues darkened until they pass 4.5:1 on paper, white and the
raised surface. Known gap: white on the dark `--kn-danger` fill (the danger button) is 3.2:1.

The rule that matters: in an infrastructure panel, green/amber/red **mean something**. Never
use a semantic colour decoratively, and never use the accent to indicate state. If a coloured
element is not conveying status, it is either accent or nothing.

Charts: `--kn-chart-1..6` run accent, then info, ok, warn, danger and a neutral grey.

Dark is the default and the design target; light ships with the same token names.

---

## 3. Space, size, shape

- **4px grid, strictly.** Tailwind's default scale only. No arbitrary spacing values in a
  component.
- **Radius: continuous rounded corners** (Apple UI layer, overriding ffstudios' radius 0):
  `--kn-r-xs 6px` (swatches, checkboxes), `--kn-r-sm 8px` (controls, badges), `--kn-r-md 10px`
  (buttons, inputs, cards, tables), `--kn-r-lg 14px` (large panels), `--kn-r-xl 16px` (dialogs,
  drawers). `9999px` is for status badges and segmented controls only.
- **Materials:** the sidebar and the top bar are `.kn-material`: the surface at 72% alpha with
  `backdrop-filter: saturate(180%) blur(20px)` and a 1px hairline. Opaque under
  `prefers-reduced-transparency: reduce` or where backdrop filters are unsupported. Nothing
  else is translucent.
- **Depth** (overriding ffstudios' "no shadows"): each shadow is a tight 1px ambient plus a
  wide, faint drop. `--kn-shadow-sm` on cards and metric tiles, `-md` on menus, popovers,
  tooltips and toasts, `-lg` on dialogs and drawers. Never on table rows, never a coloured
  glow.
- **Focus:** one halo for the whole product: 3px `--kn-ring` 2px off the edge, following the
  element's corner. Dark: accent-fg `#A98DF8` at 60% (3.3:1 on canvas). Light: `#6A3EE8` at
  75% (3.4:1), because 60% falls under 3:1.
- **Density:** table rows are 36px, 30px in compact mode. Base font size is 13px. Section gaps
  are 16px, not 32px. This product should show a lot without scrolling.
- **Card vs table:** default to the table. A card is for something genuinely singular — a
  metric tile, an attention item — not for a list of records.

---

## 4. Type

The Apple system face for the interface, one mono, one pixel display face in one place.

- **SF Pro** (`-apple-system`, `"SF Pro Text"`) for the interface, falling back to self-hosted
  **Inter Variable** off Apple platforms. 13px base, 12px for secondary and table meta, 11px
  for labels, 16/20/24px for headings. Weight 500 for emphasis; 600 only for page titles.
  ffstudios' Satoshi is licensed to the ffstudios site only and is never used here.
- **SF Mono**, falling back to self-hosted **JetBrains Mono** (400/500), for anything an
  operator would type, copy or grep: IP addresses, ports, paths, hashes, unit names, container
  ids, log lines, DNS records, commands, SQL identifiers. If it is a technical identifier, it is
  monospace. This is not decorative: it is what makes a path scannable.
- **Geist Pixel Square** for page and resource titles only, via `.kn-display`. It ships under
  the OFL in the `geist` package and loads through `next/font`. The ffstudios pixel rule
  applies: the face sits on a 0.076em cell, so it is only set where the cell is a whole pixel,
  2px here (26.32px, 32px line). No tracking, no bold, never below 26.32px, never in body copy,
  buttons, labels or tables.
- No call to Google Fonts, ever; every face is either the platform's or self-hosted.
- **Tabular numerals everywhere numbers stack vertically.** Applied globally to tables and to
  `.kn-num`.
- Sentence case for every label, button and heading. Never Title Case, never ALL CAPS except
  for a 10px section eyebrow.

---

## 5. Motion

140 / 240 / 360 ms (`--kn-dur-fast`, `--kn-dur`, `--kn-dur-slow`, the ffstudios micro and UI
steps), on Apple's spring-like ease `cubic-bezier(0.32, 0.72, 0, 1)`: it starts quickly and
settles without overshoot. `opacity` and `transform` only.

No bounce, no real spring physics, no page transitions, no staggered list entrances, no skeleton shimmer
sweeping across the screen. A panel that animates when you are trying to read a disk-usage
figure is working against you.

Three animations exist: `kn-fade-in`, `kn-rise` (4px), `kn-scale-in` (0.98 → 1). Plus
`kn-spin` for spinners and `kn-pulse-ring` for the one thing that legitimately needs attention:
a degraded agent connection. Everything respects `prefers-reduced-motion`.

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
- **Empty:** `EmptyState` with a one-sentence description and the primary action. Calm — no
  illustration, no oversized icon.
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

An abstract geometric keystone: a central wedge locking two flanking forms. Built from a small
number of straight strokes so it survives at 16px in the sidebar and as a favicon, and drawn
with `currentColor` so it inherits the accent or the text colour depending on context.

The wordmark is "Kaname" set in the interface face at weight 600 with slightly tightened tracking. 要 is a
secondary mark, used alone where a single glyph is wanted.
