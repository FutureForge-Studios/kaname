# Kaname design system

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

Near-black, essentially monochrome, one accent used sparingly.

```
--kn-bg          #0B0C0E     canvas
--kn-surface     #111316     cards, tables
--kn-surface-2   #16191D     raised, hover
--kn-surface-3   #1C2024     pressed, active row
--kn-border      #22262C     hairlines
--kn-border-str  #2E333A     emphasised
--kn-text        #E7E9EC     primary
--kn-text-2      #9BA3AE     secondary
--kn-text-3      #6B7280     tertiary, disabled
```

**Accent — Keystone Indigo.** Rationale and contrast maths in [KD-005](../DECISIONS.md).

```
--kn-accent-400  #8AA0FF     links, active icons, inline emphasis   (7.6:1 on bg)
--kn-accent-500  #5B76F7     brand, focus ring, 1px borders         (4.6:1 — never body text)
--kn-accent-600  #4A63E0     primary button fill                    (white on it: 5.6:1)
--kn-accent-700  #3A4FBF     pressed
```

**Semantic.** `--kn-ok #3FB950`, `--kn-warn #D29922`, `--kn-danger #F85149`, `--kn-info #58A6FF`,
each with a `-soft` background at 14% alpha.

The rule that matters: in an infrastructure panel, green/amber/red **mean something**. Never
use a semantic colour decoratively, and never use the accent to indicate state. If a coloured
element is not conveying status, it is either accent or nothing.

A light theme ships with the same token names and inverted values. Dark is the default and the
design target.

---

## 3. Space, size, shape

- **4px grid, strictly.** Tailwind's default scale only. No arbitrary spacing values in a
  component.
- **Radius:** `--kn-r-sm 6px` (controls, badges), `--kn-r-md 8px` (buttons, inputs, cards),
  `--kn-r-lg 10px` (dialogs, drawers). `9999px` appears in exactly one place: `StatusBadge`.
- **Density:** table rows are 36px, 30px in compact mode. Base font size is 13px. Section gaps
  are 16px, not 32px. This product should show a lot without scrolling.
- **Card vs table:** default to the table. A card is for something genuinely singular — a
  metric tile, an attention item — not for a list of records.

---

## 4. Type

One sans, one mono.

- **Inter Variable** for the interface. 13px base, 12px for secondary and table meta, 11px for
  labels, 16/20/24px for headings. Weight 500 for emphasis; 600 only for page titles.
- **JetBrains Mono** for anything an operator would type, copy or grep: IP addresses, ports,
  paths, hashes, unit names, container ids, log lines, DNS records, commands, SQL identifiers.
  If it is a technical identifier, it is monospace. This is not decorative — it is what makes a
  path scannable.
- **Tabular numerals everywhere numbers stack vertically.** Applied globally to tables and to
  `.kn-num`.
- Sentence case for every label, button and heading. Never Title Case, never ALL CAPS except
  for a 10px section eyebrow.

---

## 5. Motion

120–200 ms, `cubic-bezier(0.2, 0, 0, 1)`, `opacity` and `transform` only.

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

The wordmark is "Kaname" set in Inter at weight 600 with slightly tightened tracking. 要 is a
secondary mark, used alone where a single glyph is wanted.
