# Kaname design system

> **Visual language: the Yunori design (yunori.email), shared with the Yunori Mail Server
> console; tokens mirrored from that product's token sheet.** Kaname keeps its own `--kn-*`
> token names; only the values come from Yunori.

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

Principles taken from elsewhere — principles only, never layout: Linear's typographic hierarchy
and density, Vercel's calm treatment of infrastructure, Raycast's command-palette-first
interaction, GitHub's information density.

---

## 2. Colour

Warm off-white paper, near-ink text, essentially monochrome, one terracotta accent used
sparingly. Light is the default and the design target.

```
                 light       dark
--kn-bg          #FAF7F2     #060913     canvas (paper / navy ink)
--kn-bg-inset    #F5F2EC     #04060E     a hair below the canvas: terminal, wells
--kn-surface     #FEFDFB     #0D111C     cards, tables
--kn-surface-2   #F1EEE9     #1A1F2E     raised, hover, menus
--kn-surface-3   #EBE7E0     #1E2433     pressed, active row
--kn-border      #E2DED9     #242938     hairlines
--kn-border-str  #C9C3BA     #3F465A     emphasised
--kn-text        #121621     #FAF8F5     primary          (16.9:1 / 18.8:1 on bg)
--kn-text-2      #595D69     #ACB3C3     secondary        (6.2:1 / 9.5:1 on bg)
--kn-text-3      #757A8A     #878FA1     tertiary, disabled (4.0:1 / 6.1:1 on bg)
```

**Accent — torii.** Yunori's terracotta (`hsl(14 84% 44%)`), the only hue that is not a
status.

```
                 light       dark
--kn-accent-300  #F88F62     #FBB293     tints; links and active icons on dark (8.6:1)
--kn-accent-400  #ED5D31     #F88F62     inline emphasis on dark; decorative on light (3.2:1)
--kn-accent-500  #CE3E12     #D54013     brand, focus ring, 1px borders (4.6:1 light — never body text)
--kn-accent-600  #BC3810     #BC3810     primary button fill (white on it: 5.7:1)
--kn-accent-700  #A0300E     #A0300E     pressed
```

On dark, the readable accent is Yunori's `torii-ink` (`hsl(18 92% 68%)`), which is why the
tints carry text there while 500 stays torii for fills.

**Semantic.** Yunori's `-ink` values, each with a `-soft` background at 14% alpha:

```
                 light       dark
--kn-ok          #27684C     #79C3A1
--kn-warn        #904F0E     #E7B155
--kn-danger      #B6202F     #F0757D     (dark uses danger-ink; destructive is 3.4:1 on raised)
--kn-info        #325F76     #81B5CF
```

The rule that matters: in an infrastructure panel, green/amber/red **mean something**. Never
use a semantic colour decoratively, and never use the accent to indicate state. If a coloured
element is not conveying status, it is either accent or nothing.

Charts: `--kn-chart-1..6` run torii → info → success → warning → danger → a muted navy.

Light is the default and the design target; dark ships with the same token names.

---

## 3. Space, size, shape

- **4px grid, strictly.** Tailwind's default scale only. No arbitrary spacing values in a
  component.
- **Radius:** derived from Yunori's `--radius: .5rem`. `--kn-r-xs 4px` (focus rings, swatches),
  `--kn-r-sm 6px` (controls, badges), `--kn-r-md 8px` (buttons, inputs, cards), `--kn-r-lg 12px`
  (dialogs, drawers). `9999px` appears in exactly one place: `StatusBadge`.
- **Density:** table rows are 36px, 30px in compact mode. Base font size is 13px. Section gaps
  are 16px, not 32px. This product should show a lot without scrolling.
- **Card vs table:** default to the table. A card is for something genuinely singular — a
  metric tile, an attention item — not for a list of records.

---

## 4. Type

One sans, one mono, one display face used in one place.

- **Geist Variable** for the interface. 13px base, 12px for secondary and table meta, 11px for
  labels, 16/20/24px for headings. Weight 500 for emphasis; 600 only for page titles. Rendered
  with its default features (no Inter-style alternates).
- **Geist Mono Variable** for anything an operator would type, copy or grep: IP addresses,
  ports, paths, hashes, unit names, container ids, log lines, DNS records, commands, SQL
  identifiers. If it is a technical identifier, it is monospace. This is not decorative — it is
  what makes a path scannable.
- **Fraunces Variable** for display: page and resource titles only, via `.kn-display`
  (weight 500, tracking −0.01em). Never for body copy, labels or table content.
- All three are self-hosted from `@fontsource-variable/*`; the panel never calls Google Fonts.
- **Tabular numerals everywhere numbers stack vertically.** Applied globally to tables and to
  `.kn-num`.
- Sentence case for every label, button and heading. Never Title Case, never ALL CAPS except
  for a 10px section eyebrow.

---

## 5. Motion

150–250 ms (`--kn-dur-fast` 150, `--kn-dur` 200, `--kn-dur-slow` 250), Yunori's quiet curve
`cubic-bezier(0.22, 1, 0.36, 1)`, `opacity` and `transform` only.

No bounce, no spring, no page transitions, no staggered list entrances, no skeleton shimmer
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

The wordmark is "Kaname" set in Geist at weight 600 with slightly tightened tracking. 要 is a
secondary mark, used alone where a single glyph is wanted.
