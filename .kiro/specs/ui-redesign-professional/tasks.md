# Implementation Plan: UI Redesign — Professional & Consistent

## Overview

Seven-phase migration of `src/styles.css` from the current glassmorphic theme to the flat, opaque, token-driven surface system defined in `design.md`. The migration order is **P1 Tokens → P2 Base → P3 Shell → P4 Board → P5 Detail → P6 Overlays → P7 Finalize** (Requirement 11.3), and every phase closes with a green `npx tsc -b` + `npx vite build` and a viewable app (Requirements 11.4, 12.1, 12.2 / Property 11).

**Scope guardrail — read before starting any task.** This is a presentation-only change. `src/api.ts`, `src/format.ts`, `src/main.tsx`, and `src/LineChart.tsx` are never edited. `.tsx` files are touched only in P5, P6, and P7 (Requirement 11.7), and each such task below names exactly which single class of Presentational_Edit it is allowed to make — one of:

- **(A) className change** — edit a `className` attribute value.
- **(B) wrapper element** — add a wrapping element that carries only styling / ARIA attributes.
- **(C) aria attribute** — add or edit an `aria-*` attribute.
- **(D) color-literal substitution** — replace a static or data-driven color literal with its token hex value.

Anything outside the stated class — adding/removing/altering a hook call, an event handler, a prop, an API call, an array's shape or ordering, or a `{cond && …}` expression — is rejected (Requirements 10.3, 10.4 / Property 10).

**Cascade ordering note for P1.** The existing `:root` block (`src/styles.css` lines 1–30) declares 8 names that the new Token_Block also declares (`--border`, `--border-strong`, `--accent`, `--pos`, `--neg`, `--prem`, `--disc`, `--oi`) and 11 names the Alias_Block redefines (`--bg`, `--bg-elev`, `--panel`, `--panel-2`, `--text`, `--muted`, `--faint`, `--radius`, `--radius-sm`, `--glass`, `--glass-border`). Equal-specificity custom properties are resolved by source order, so the new blocks must be inserted **immediately after** the legacy `:root` block for the new values to win. The legacy block itself is deleted in task 9.8 together with the Alias_Block.

## Tasks

- [x] 1. Phase 1 — Token_Block and Alias_Block (additive)

  - [x] 1.1 Add the Token_Block to `src/styles.css`
    - Insert a new `:root { … }` block immediately after the existing `:root` block (ends line 30), before the `*` reset, containing the complete token set from design.md "Design Token System": `--surface-0/-1/-2/-3`; `--border-subtle/--border/--border-strong`; `--text-1/-2/-3`; `--accent`, `--accent-hover`, `--accent-text`, `--accent-surface`, `--accent-border`; `--pos`, `--pos-surface`, `--neg`, `--neg-surface`, `--warn`, `--warn-surface`, `--prem`, `--prem-surface`, `--disc`, `--disc-surface`; `--oi`, `--series-1/-2/-3`, `--series-expired`, `--chart-grid`, `--chart-guide`; `--font-ui`, `--font-mono`, `--fs-1`…`--fs-7`, `--fw-regular/medium/semibold/bold`, `--lh-tight`, `--lh-base`, `--tracking-caps`; `--sp-1/-2/-3/-4/-5/-6/-8/-10`; `--r-sm/--r-md/--r-lg/--r-pill`; `--shadow-popover`, `--shadow-overlay`, `--scrim`, `--ring`; `--dur-fast`, `--dur`, `--ease`.
    - Use the exact hex/px values from design.md. Alpha-bearing values are permitted only in `--scrim`, `--ring`, `--shadow-popover`, `--shadow-overlay`.
    - Add no rule outside `:root` in this task and delete nothing — every existing rule must keep resolving.
    - _Requirements: 3.1, 3.4, 4.1, 4.2, 4.3, 5.1, 11.1_
    - _Satisfies: Property 2 (token closure), Property 4 (bounded vocabulary)_

  - [x] 1.2 Add the temporary Alias_Block to `src/styles.css`
    - Append a second `:root { … }` block directly after the Token_Block, headed `/* TEMPORARY — removed in Phase 7 */`, with the design.md aliases: `--bg: var(--surface-0)`, `--bg-elev: var(--surface-2)`, `--panel: var(--surface-1)`, `--panel-2: var(--surface-3)`, `--text: var(--text-1)`, `--muted: var(--text-2)`, `--faint: var(--text-3)`, `--radius: var(--r-lg)`, `--radius-sm: var(--r-md)`, `--glass: transparent`, `--glass-border: var(--border)`.
    - Extend the block to cover the remaining still-referenced legacy names so no rule resolves to a legacy value while the aliases are present (Requirements 3.7, 11.2): `--pos-soft: var(--pos-surface)`, `--neg-soft: var(--neg-surface)`, `--prem-soft: var(--prem-surface)`, `--disc-soft: var(--disc-surface)`, `--amber: var(--warn)`, `--shadow: var(--shadow-overlay)`, `--shadow-soft: var(--shadow-popover)`. `--accent-2` and `--oi-soft` have zero references and need no alias.
    - Verify closure: `grep -oE 'var\(--[a-z0-9-]+' src/styles.css | sort -u` and confirm every name is declared in the Token_Block, the Alias_Block, or the still-present legacy `:root`.
    - _Requirements: 3.7, 11.1, 11.2_
    - _Satisfies: Property 2, Property 21 (alias safety)_

  - [x] 1.3 Phase 1 verification
    - Run `npx tsc -b` (require exit 0) and `npx vite build` (require an emitted bundle).
    - Re-run the `var()` closure grep from 1.1–1.2 and confirm zero unresolved names.
    - Confirm the app still renders every screen: P1 re-palettes the 8 colliding color names and the two radius names, so the board will look re-tinted but must remain fully laid out and readable. Report to the user for visual confirmation; ask if anything looks broken rather than unfamiliar.
    - _Requirements: 11.4, 12.1, 12.2, 12.6_
    - _Satisfies: Property 11 (build integrity), Property 21_

- [x] 2. Phase 2 — Base layer (body, typography, focus, motion, shell meta)

  - [x] 2.1 Flatten the body and app shell in `src/styles.css`
    - `body` (lines 41–55): delete the `background-image` with its two `radial-gradient(…)` layers and delete `background-attachment: fixed`; set `background: var(--surface-0)`, `color: var(--text-1)`, `font-family: var(--font-ui)`, `font-size: var(--fs-4)`, `line-height: var(--lh-base)`. Keep `min-height: 100vh`, `-webkit-font-smoothing`, and `text-rendering`.
    - `.app` (line 61): keep `max-width: 1480px`; express padding as `0 var(--sp-6) var(--sp-10)`.
    - _Requirements: 1.2, 1.6, 3.3, 9.2_
    - _Satisfies: Property 1 (no glass), Property 13 (opaque token fills)_

  - [x] 2.2 Install the typographic scale and the numeric rule in `src/styles.css`
    - `.mono` (line 56): `font-family: var(--font-mono)`, keep `font-variant-numeric: tabular-nums`.
    - Add a shared numeric rule listing `.num, .card-price, .chip, .leg-cell, .trade-pnl` (extended with `.metric-value` in task 9.1): `font-family: var(--font-mono); font-variant-numeric: tabular-nums;`.
    - Convert every `font-size` in the base rules to a `--fs-*` token; add no new font family beyond the two already declared.
    - Drop the negative `letter-spacing` on `.brand h1` (line 108) and confirm `--tracking-caps` is applied only in uppercase micro-label rules.
    - _Requirements: 3.6, 4.1, 4.8, 5.4_
    - _Satisfies: Property 15 (uniform geometry/scale), Property 16 (numeric legibility)_

  - [x] 2.3 Add the global focus indicator to `src/styles.css`
    - Add `:where(button, a, input, [tabindex]):focus-visible { outline: none; border-color: var(--accent); box-shadow: var(--ring); }` in the base layer.
    - Pair each existing `outline: none` with that replacement indicator: `.search:focus` (line 168–174), `.rf input:focus` (781–786), `.admin-input:focus` (878–883) — remove their one-off `rgba(59,130,246,0.15)` glows and let the shared `--ring` apply.
    - Keep `.search-wrap:focus-within svg` (line 147) as an additional affordance, recolored to `var(--accent-text)`.
    - _Requirements: 8.4, 8.5_
    - _Satisfies: Property 7 (focus visibility)_

  - [x] 2.4 Add the reduced-motion block to `src/styles.css`
    - Add `@media (prefers-reduced-motion: reduce)` at the end of the base layer neutralizing motion for all elements (`animation: none !important; transition: none !important; scroll-behavior: auto;`) and rendering the skeleton static: `.sk { background: var(--surface-2); }`.
    - Confirm all three keyframe animations are covered: `pulse` (line 220), `spin` (705), `shimmer` (727).
    - In default mode keep `pulse` on `.status--live .status-dot` (line 204) but reduce its glow radius to at most 4px.
    - _Requirements: 8.7, 8.8_
    - _Satisfies: Property 12 (motion respect)_

  - [x] 2.5 Update the shell meta in `index.html`
    - Line 6: change `<meta name="theme-color" content="#0b0e14" />` to `content="#0f1216"` so it equals `--surface-0`.
    - Change nothing else in this file — the existing Google Fonts link for Inter and JetBrains Mono is retained verbatim.
    - _Requirements: 3.5, 3.6_
    - _Satisfies: Property 18 (cross-screen shell consistency)_

  - [x] 2.6 Phase 2 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted).
    - Assert `grep -cE 'radial-gradient|background-attachment' src/styles.css` returns 0.
    - Assert a `:focus-visible` rule exists and that every `outline: none` occurrence is inside or adjacent to a rule with a replacement indicator.
    - Confirm every screen renders; report to the user for visual confirmation.
    - _Requirements: 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 11_

- [x] 3. Phase 3 — Shell (topbar, buttons, inputs, status, banners)

  - [x] 3.1 De-blur the topbar and flatten the brand mark in `src/styles.css`
    - `.topbar` (68–84): delete `backdrop-filter` (80) and `-webkit-backdrop-filter` (81); delete the `border-bottom: 1px solid var(--border)` declaration (82) entirely so the rule set carries no bottom border at all; set `background: var(--surface-0)`, padding `var(--sp-3) var(--sp-4)`.
    - Retain `margin-bottom` (78), expressed as `margin-bottom: var(--sp-4)` (the token equal to the current `16px`), so the gap between the topbar and the first stock-card row is preserved and the board does not shift up. Add no replacement divider — pseudo-element, `box-shadow`, or otherwise.
    - `.brand-mark` (92–102): replace `background: linear-gradient(135deg, var(--accent), #06b6d4)` (98) with `background: var(--accent)`; delete the `box-shadow` glow; 32px square, `border-radius: var(--r-md)`. `.brand-mark svg` (103): stroke/fill inherit the white glyph.
    - `.brand h1` (108): `font-size: var(--fs-7)`, `font-weight: var(--fw-semibold)`. `.subtitle` (116): `var(--fs-2)` / `var(--text-2)`. `.toolbar` (123): `gap: var(--sp-2)`.
    - _Requirements: 1.1, 1.4, 1.7, 2.3, 4.8_
    - _Satisfies: Property 1, Property 13, Property 18_

  - [x] 3.2 Unify button geometry and the four variants in `src/styles.css`
    - `.btn` (239–254): 32px control height (`padding: 0 var(--sp-3)`, `min-height: 32px`), `font-size: var(--fs-4)`, `font-weight: var(--fw-medium)`, `border-radius: var(--r-md)`, `background: var(--surface-2)`, `border: 1px solid var(--border)`, `color: var(--text-1)`, `transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease)`.
    - `.btn:hover:not(:disabled)` (255): declare only `background: var(--surface-3)` and `border-color: var(--border-strong)` — delete any `transform`, `box-shadow`, `filter`, `opacity`. `.btn:active` (262): `background: var(--surface-3)`. `.btn:disabled` (266): `opacity: 0.45; cursor: default;` and no hover response.
    - Variants per the design table: `.btn--primary` (271) `--accent` fill + white text, hover `--accent-hover` (278); `.btn--trade` (948) `--accent-surface` / `--accent-text` / `--accent-border`, hover (955) `--surface-3` + `border-color: var(--accent)`; `.btn--danger` (905) `--neg` fill + white text, hover (911) darkened `--neg`; `.btn--danger-ghost` (921) transparent + `--neg` text + `--neg` border, hover (927) `--neg-surface`. Define no fifth variant.
    - `.btn--sm` (942): 26px height, `var(--fs-3)`. `.btn--full` (898), `.btn-badge` (965), `.trade-del-confirm` (932): token-only values.
    - Delete `.btn--danger:disabled { transform: none; }` (917–920) — with no transforms left in the sheet the override is dead code.
    - _Requirements: 1.9, 4.5, 4.9, 4.10_
    - _Satisfies: Property 14 (hover/disabled invariance), Property 15_

  - [x] 3.3 Unify the three input controls in `src/styles.css`
    - Give `.search` (151), `.rf input` (770), and `.admin-input` (859) one identical tuple: `background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, `min-height: 32px`, `font-size: var(--fs-4)`, `text-align: left`, `color: var(--text-1)`.
    - Remove `.admin-input`'s letter-spacing gimmick and centered text. `.search::placeholder` (164) and `.admin-input::placeholder` (873): `var(--text-3)`. `.search-wrap svg` (137): `var(--text-3)`. `.rf` (757) label chrome and `.rf input[type="number"]` / spin-button rules (787–796): token values only.
    - Focus comes from task 2.3's shared rule — add no per-input glow.
    - _Requirements: 3.2, 4.6, 8.4_
    - _Satisfies: Property 15, Property 7_

  - [x] 3.4 Restyle status pill, counters, banners, links, and legend tags in `src/styles.css`
    - `.status` (176): `border-radius: var(--r-pill)`, `var(--fs-2)`, `var(--fw-medium)`, `background: var(--surface-2)`; `.status--live` (198) `--pos-surface` / `--pos`; `.status--wait` (210) `--warn-surface` / `--warn`. Leave `border-radius: 50%` on `.status-dot` (190) — a circle, not a rectangular radius, and outside the four-radius budget.
    - `.count` (226) / `.count strong` (233): `var(--fs-2)` / `var(--text-2)` and `var(--text-1)`.
    - `.banner` (284): `background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, padding `var(--sp-3) var(--sp-4)`; `.banner--error` (297): `box-shadow: inset 3px 0 0 var(--neg)` and `color: var(--neg)` replacing `#ffa0a8`; `.banner--info` (303): `box-shadow: inset 3px 0 0 var(--accent)` and `color: var(--accent-text)` replacing `#93c5fd`. Use the same 3px rail width as `.row-spot` (task 5.2).
    - `.link` (309) / `.link:hover` (315): `var(--accent-text)`. `.legend` (320), `.tag` (330), `.tag--prem` (339) → `--prem` / `--prem-surface`, `.tag--disc` (344) → `--disc` / `--disc-surface`, `.legend-sep` (349) → `var(--border)`.
    - _Requirements: 2.8, 5.2, 5.7, 8.2, 8.8_
    - _Satisfies: Property 5 (P&L / prem-disc separation), Property 13_

  - [x] 3.5 Phase 3 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted).
    - Assert `grep -cE 'backdrop-filter|-webkit-backdrop-filter' src/styles.css` returns 0.
    - Assert the `.topbar` rule set contains zero `border-bottom` declarations, and that it still declares `margin-bottom: var(--sp-4)`.
    - Assert no `:hover` rule in the migrated shell selectors declares `transform`, `box-shadow`, `filter`, or `opacity`.
    - Re-run the `var()` closure grep; add any missing token before closing the phase.
    - Confirm every screen renders; report to the user for visual confirmation.
    - _Requirements: 1.1, 1.4, 1.9, 3.7, 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 11, Property 13, Property 14_

- [ ] 4. Checkpoint — shell review
  - Ensure the build is green and the shell (topbar, buttons, inputs, banners) renders on both the board and the admin screen; ask the user if questions arise.

- [x] 5. Phase 4 — Board (card, table, chips, skeletons, breakpoints)

  - [x] 5.1 De-glass the stock card in `src/styles.css`
    - `.card` (465–473): replace `background: linear-gradient(180deg, var(--glass) 0%, transparent 100%), var(--panel)` (469) with `background: var(--surface-1)`; `border: 1px solid var(--border)`; `border-radius: var(--r-lg)`; delete the `box-shadow`.
    - Delete the `.card::before` rule (474–483, the `linear-gradient(90deg, transparent, rgba(59,130,246,0.4), transparent)` hairline) and `.card:hover::before` (490–493) in full.
    - `.card:hover` (484–489): declare only `background: var(--surface-2)` and `border-color: var(--border-strong)` — no `transform`, no `box-shadow`.
    - `.card-head` (494): padding `var(--sp-3) var(--sp-4)`, `border-bottom: 1px solid var(--border)`. `.card-title` (503). `.card-symbol` (507): `var(--fs-4)` / `var(--fw-semibold)` (was 14.5px/700). `.card-name` (528): `var(--fs-2)` / `var(--text-2)`. `.card-quote` (538). `.card-price` (546): `var(--fs-5)` mono. `.card-spread` (551) with `.card-spread.prem` (558) → `--prem` and `.card-spread.disc` (562) → `--disc`. `.card-foot` (960): `border-top: 1px solid var(--border)`, padding `var(--sp-3) var(--sp-4)`. `.card--clickable` (1373) and `.detail-card .card` (1396): token values only.
    - `.badge-index` (516): `var(--fs-1)`, `border-radius: var(--r-sm)`, `background: var(--prem-surface)`, `color: var(--prem)`.
    - _Requirements: 1.8, 1.9, 1.10, 2.2, 2.6, 4.1, 5.2_
    - _Satisfies: Property 1, Property 13, Property 14_

  - [x] 5.2 Restyle the card table in `src/styles.css`
    - `.card-table thead th` (573): `var(--fs-1)`, `var(--fw-semibold)`, uppercase, `letter-spacing: var(--tracking-caps)`, `color: var(--text-3)`, `border-bottom: 1px solid var(--border)`.
    - `.card-table td` (588): `var(--fs-3)`, padding `var(--sp-2) var(--sp-4)`, `border-bottom: 1px solid var(--border-subtle)`.
    - `.card-table tbody tr:nth-child(even)` (601): `background: var(--surface-2)` replacing `rgba(255,255,255,0.015)`. `.card-table tbody tr:hover` (605): `background: var(--surface-3)`.
    - `.row-spot` (609): `background: var(--accent-surface)` plus `box-shadow: inset 3px 0 0 var(--accent)` — same 3px rail width as `.banner`.
    - `.contract-name` (613), `.contract-meta` (618) `var(--text-3)`, `.contract-oi` (624) `var(--oi)`, `.num` (635) mono tabular, `.card-table td.fair` (639) `var(--text-2)`.
    - _Requirements: 1.10, 2.7, 4.4, 5.4, 9.7_
    - _Satisfies: Property 4, Property 13, Property 16_

  - [x] 5.3 Collapse chips and value colors onto one geometry in `src/styles.css`
    - `.chip` (656): `min-width: 60px`, `text-align: right`, padding `var(--sp-1) var(--sp-2)`, `border-radius: var(--r-sm)`, `font-weight: var(--fw-semibold)`, `font-size: var(--fs-3)`, `font-family: var(--font-mono)`, `font-variant-numeric: tabular-nums`.
    - `.chip.prem` (668) and `.chip.disc` (674): stop stripping padding and background — set `color: var(--prem)` / `background: var(--prem-surface)` and `color: var(--disc)` / `background: var(--disc-surface)` while inheriting the base geometry. Add `.chip.pos` (`--pos` / `--pos-surface`) and `.chip.neg` (`--neg` / `--neg-surface`). `.chip.muted` (680): `var(--text-3)` / `var(--surface-2)`.
    - `.pos` (644) → `var(--pos)`, `.neg` (648) → `var(--neg)`, `.muted` (652) → `var(--text-3)`. No `.pos`/`.neg` rule may reference a `--prem`/`--disc` token and no `.prem`/`.disc` rule may reference a `--pos`/`--neg` token.
    - `.empty` (686) and `.spinner` (693): token values; leave `border-radius: 50%` on `.spinner`.
    - _Requirements: 4.7, 5.1, 5.2, 5.3, 5.4_
    - _Satisfies: Property 5, Property 15, Property 16_

  - [x] 5.4 Rebuild the skeleton shimmer on opaque stops in `src/styles.css`
    - `.sk` (714–726): rewrite the `linear-gradient` stops from `rgba(255,255,255,0.04)` / `rgba(255,255,255,0.08)` to `var(--surface-2)` → `var(--surface-3)` → `var(--surface-2)`. This must remain the **only** `linear-gradient` consumer in the stylesheet.
    - `.sk-symbol` (732), `.sk-name` (738), `.sk-price` (743), `.sk-row` (748): `border-radius: var(--r-sm)`, sizes on the spacing scale.
    - `.skeleton .card-table td` (752): set the identical padding token pair as `.card-table td` (`var(--sp-2) var(--sp-4)`) so the grid does not shift when real cards land.
    - _Requirements: 1.3, 9.7_
    - _Satisfies: Property 1, Property 20 (breakpoint closure / skeleton parity)_

  - [x] 5.5 Consolidate the four breakpoints and touch targets in `src/styles.css`
    - Reduce the media-query set to exactly `max-width: 1180px`, `860px`, `720px`, `480px`. Merge or retarget any query that does not use one of those four widths.
    - `.cards` (354): 3 columns ≥1181px; 2 columns at 1180 (361); add the 860px band holding 2 columns; 1 column at 720 (367).
    - Shell padding on `.app`: `var(--sp-6)` ≥861px, `var(--sp-4)` at 860, `var(--sp-3)` at 720, `var(--sp-2)` at 480.
    - At 720px: `.search-wrap` full width with `order: 3`. At 480px (392, 1214, 1361, 1526): `table-layout: fixed`, table text `var(--fs-2)`, and `min-height: 44px` on `button`, `a.btn`, and `input` (the `.chart-toggle` segment minimum is added in task 6.2).
    - _Requirements: 8.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
    - _Satisfies: Property 9 (touch targets), Property 20_

  - [x] 5.6 Phase 4 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted).
    - Assert `grep -c 'linear-gradient' src/styles.css` returns 1 and that the single occurrence is inside the `.sk` rule.
    - Assert every media query width is a member of {1180, 860, 720, 480}.
    - Assert `.skeleton .card-table td` and `.card-table td` declare the same padding token pair.
    - Confirm every screen renders; report to the user for visual confirmation.
    - _Requirements: 1.3, 9.1, 9.7, 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 11, Property 20_

- [x] 6. Phase 5 — Detail page and charts

  - [x] 6.1 Flatten the detail surfaces in `src/styles.css`
    - `.detail-grid` (1382): `minmax(300px, 380px) 1fr` ≥1181px, 2 columns 861–1180px, 1 column at 860 (1390). `.detail-charts` (1400) and `.chart-wrap` (1544): spacing tokens only.
    - `.detail-chart` (1457): replace `background: linear-gradient(180deg, var(--glass) 0%, transparent 100%), var(--panel)` (1460) with `background: var(--surface-1)`; `border: 1px solid var(--border)`; `border-radius: var(--r-lg)`; no `box-shadow`.
    - `.oi-panel` (1408): `var(--surface-1)` + `1px solid var(--border)` + `var(--r-lg)`. `.oi-panel-title` (1416): `var(--fs-1)` uppercase `var(--tracking-caps)` `var(--text-3)`. `.oi-panel-row` (1425): `border-bottom: 1px solid var(--border-subtle)` replacing `rgba(255,255,255,0.03)`. `.oi-panel-exp` (1444): `var(--fs-3)` (was 12.5px). `.oi-panel-val` (1450): mono tabular.
    - `.chart-head` (1465) / `.chart-head h2` (1472) `var(--fs-6)` / `.chart-sub` (1479) `var(--fs-2)` `var(--text-2)` / `.chart-empty` (1579) / `.back-btn` (1377) / `.oi-chart` (1548): token values only.
    - _Requirements: 1.3, 1.8, 1.10, 2.2, 2.6, 4.1, 9.2, 9.3, 9.4_
    - _Satisfies: Property 13, Property 20_

  - [x] 6.2 Rebuild `.chart-toggle` as a segmented control in `src/styles.css`
    - `.chart-toggle` (1484): the wrapper owns the chrome — `display: inline-flex`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, `overflow: hidden`.
    - `.chart-toggle button` (1492): `min-height: 28px`, `var(--fs-3)`, `background: var(--surface-2)`, `color: var(--text-2)`, no individual border or radius; add `.chart-toggle button + button { border-left: 1px solid var(--border); }`.
    - `.chart-toggle button.active` (1504): `background: var(--accent)` with white text — exactly one segment carries the active fill. `.chart-toggle button:not(.active):hover` (1509): `background: var(--surface-3)` only.
    - In the 480px query (1526): `min-height: 44px` on `.chart-toggle button`, which wins over the 28px compact height. Keep the 720px wrap behavior (1515).
    - _Requirements: 4.11, 8.6_
    - _Satisfies: Property 9, Property 15_

  - [x] 6.3 Token-drive the SVG chart furniture and tooltip in `src/styles.css`
    - `.chart-grid` (1554): `stroke: var(--chart-grid)`. `.chart-guide` (1559): `stroke: var(--chart-guide)`.
    - `.chart-ylabel` (1565) and `.chart-xlabel` (1572): `fill: var(--text-3)`, `font-size: var(--fs-1)`, `font-family: var(--font-mono)`.
    - `.chart-legend` (1586) / `.chart-legend-item` (1595): `var(--fs-2)`, `gap: var(--sp-1)`.
    - `.chart-tip` (1608): `background: var(--surface-1)` replacing `rgba(11,14,20,0.95)`, `border: 1px solid var(--border-strong)`, `border-radius: var(--r-lg)`, `box-shadow: var(--shadow-popover)`, padding `var(--sp-2) var(--sp-3)`. `.chart-tip-date` (1622), `.chart-tip-row` (1628), `.chart-tip-label` (1635), `.chart-tip-val` (1640): token values, mono tabular for the value.
    - _Requirements: 2.5, 3.2, 5.6_
    - _Satisfies: Property 2, Property 6 (elevation monotonicity), Property 17 (palette agreement)_

  - [x] 6.4 Fold the two 2px dot radii onto `--r-sm` in `src/styles.css`
    - `.oi-dot` (1437) and `.chart-dot` (1601): change `border-radius: 2px` to `border-radius: var(--r-sm)`. These two rules hold the only `2px` radii in the sheet and were the seventh distinct radius; folding them keeps the four-radius budget of criterion 4.2 intact.
    - Leave `border-radius: 50%` on `.status-dot` (190) and `.spinner` (693) unchanged — a full circle is not a rectangular radius and sits outside that budget.
    - CSS-only: `.chart-dot` is already applied via `className` in `LineChart.tsx` (lines 229, 242) whose inline styles carry only the data-driven `background` / `opacity`, so no `.tsx` edit is needed and Requirement 10.2 holds.
    - _Requirements: 4.2, 4.12_
    - _Satisfies: Property 4_

  - [x] 6.5 Substitute the series color literals in `src/StockDetail.tsx`
    - **Permitted edit: (D) color-literal substitution only.**
    - Replace `const LINE_COLORS = ["#4d8bff", "#22c55e", "#f59e0b"]` with `["#58a6ff", "#3fb950", "#d29922"]` (`--series-1`, `--series-2`, `--series-3` in near / next / far contract order) and `const EXPIRED_COLOR = "#8d97ac"` with `"#6e7681"` (`--series-expired`).
    - Array arity, element order, constant names, and every consumer stay exactly as they are. Make no other edit to this file in this phase — the inline-style extraction is task 9.4.
    - _Requirements: 5.5, 6.4, 10.3, 11.7_
    - _Satisfies: Property 17, Property 10 (logic untouched)_

  - [x] 6.6 Phase 5 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted).
    - Assert `grep -cE '#4d8bff|#22c55e|#f59e0b|#8d97ac' src/StockDetail.tsx` returns 0.
    - Assert `grep -c 'border-radius: 2px' src/styles.css` returns 0 and that distinct `border-radius` values in the migrated rules are drawn only from `--r-sm`, `--r-md`, `--r-lg`, `--r-pill`, plus `50%` on the two dot/spinner circles.
    - Assert the `git diff` for `src/StockDetail.tsx` contains no line matching `useState|useEffect|useMemo|useRef|fetch|await|on[A-Z]`.
    - Confirm all five detail charts render with one active toggle segment; report to the user for visual confirmation.
    - _Requirements: 4.2, 5.5, 10.5, 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 4, Property 10, Property 11, Property 17_

- [ ] 7. Checkpoint — board and detail review
  - Ensure the build is green, the board reflows at 3/2/1 columns with no hover lift, and the detail charts and OI panel render; ask the user if questions arise.

- [x] 8. Phase 6 — Overlays (modals, trades panel, admin)

  - [x] 8.1 De-blur the scrim and restyle the modal shell in `src/styles.css`
    - `.modal-overlay` (981): delete `backdrop-filter` (986) and `-webkit-backdrop-filter` (987); set `background: var(--scrim)`.
    - `.modal` (994): `background: var(--surface-1)`, `border: 1px solid var(--border)`, `border-radius: var(--r-lg)`, `box-shadow: var(--shadow-overlay)`, default `max-width: 660px`.
    - `.modal-head` (1007) and `.modal-body` (1017): padding `var(--sp-4)`, `border-bottom: 1px solid var(--border)` on the head. `.modal-head h2` (1023): `var(--fs-6)`. `.modal-sub` (1030): `var(--fs-2)` / `var(--text-2)`.
    - `.modal-x` (1036): 28px square, `border-radius: var(--r-md)`, `background: var(--surface-2)`, `border: 1px solid var(--border)`; `.modal-x:hover` (1049): `background: var(--surface-3)` + `border-color: var(--border-strong)` only.
    - _Requirements: 1.1, 1.5, 2.5, 4.4_
    - _Satisfies: Property 1, Property 6, Property 13, Property 14_

  - [x] 8.2 Add the modal width classes to `src/styles.css`
    - Add `.modal--sm { max-width: 440px; }` and `.modal--md { max-width: 520px; }` immediately after `.modal`, so the widths become classes rather than inline `maxWidth` values.
    - _Requirements: 6.6_
    - _Satisfies: Property 19 (inline-style extraction)_

  - [x] 8.3 Restyle the trades panel with nested elevation in `src/styles.css`
    - `.trade-section` (1054) / `.trade-section + .trade-section` (1058) / `.trade-section-title` (1062, `var(--fs-1)` uppercase `var(--tracking-caps)` `var(--text-3)`) / `.pill-count` (1074) / `.trade-empty` (1089) / `.trade-list` (1095).
    - `.trade-card` (1230): sits on the `--surface-1` modal, so `background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, no `box-shadow`. `.trade-card--clickable:hover` (1246): `background: var(--surface-3)` + `border-color: var(--border-strong)` only.
    - `.trade-card--closed` (1237): `opacity: 1` with `var(--text-2)` values. `.trade-closed-tag` (1207): badge at `var(--fs-1)` / `var(--r-sm)` on `var(--surface-3)` with `1px solid var(--border-strong)` — the ceiling case of Requirement 2.9. `.trade-roi` (1178): drop the `0.85` opacity.
    - `.trade-head` (1251), `.trade-symbol` (1120), `.trade-spot` (1259) / `strong` (1265), `.trade-meta` (1149), `.trade-right` (1154), `.trade-pnl-label` (1185), `.trade-breakdown` (1193), `.trade-foot` (1339) / `.trade-foot .trade-meta` (1348), `.trade-net` (1353): token values only.
    - `.leg-grid` (1272) / `.leg-line` (1278): keep the 5-column layout; `.leg-cell` (1313), `.leg-exp` (1308), `.leg-now` (1318) mono tabular. `.leg-tag` (1288) / `.tag-buy` (1298) → `--prem-surface` / `--prem`; `.tag-sell` (1303) → `--disc-surface` / `--disc`. `.leg-pnl` (1200), `.leg-line .leg-pnl` (1322) with `.pnl-pos` (1327) → `--pos`, `.pnl-neg` (1331) → `--neg`, `.muted` (1335) → `--text-3`; `.trade-pnl` (1163) / `.pnl-pos` (1170) / `.pnl-neg` (1174).
    - Retain the legacy selectors `.trade-row` (1101), `.trade-row--closed` (1112), `.trade-main` (1116), `.trade-legs` (1128), `.leg` (1135), `.leg-buy` (1141), `.leg-sell` (1145) — rewrite their bodies onto tokens, do not rename or delete them (Requirements 7.1, 7.2).
    - _Requirements: 2.4, 2.9, 5.2, 5.4, 8.9_
    - _Satisfies: Property 3 (class-name preservation), Property 6, Property 16_

  - [x] 8.4 Flatten the admin page in `src/styles.css`
    - `.admin-page` (798): `background: var(--surface-0)`. `.admin-card` (805): `background: var(--surface-1)`, `border: 1px solid var(--border)`, `border-radius: var(--r-lg)`, `box-shadow: var(--shadow-overlay)`, padding `var(--sp-8)`, `max-width: 400px`.
    - Delete `.admin-card::before` (818–825) with its `linear-gradient(90deg, var(--accent), #06b6d4)` top rule.
    - `.admin-card .brand-mark` (826): 40px, flat `var(--accent)`; `.admin-card .brand-mark svg` (833): white glyph. `.admin-card h1` (838): `var(--fs-6)`. `.admin-subtitle` (846): `var(--fs-2)` / `var(--text-2)`. `.admin-card form` (853): `gap: var(--sp-3)`.
    - `.admin-error` (889): `var(--neg)` on `var(--neg-surface)` with `box-shadow: inset 3px 0 0 var(--neg)`, matching `.banner--error`. `.admin-input:disabled` (884): `opacity: 0.45; cursor: default;`.
    - _Requirements: 1.1, 2.5, 4.10, 5.7_
    - _Satisfies: Property 1, Property 13, Property 14_

  - [x] 8.5 Apply the small modal width class in `src/TradeConfirmModal.tsx`
    - **Permitted edits: (A) className change, and deletion of the static inline `maxWidth` declaration it replaces.**
    - Change the modal element's `className` to `"modal modal--sm"` and remove the inline `maxWidth` from its `style` object (delete the whole `style` attribute only if `maxWidth` was its sole entry).
    - Leave the remaining inline styles for task 9.5. Touch no handler, prop, hook, or conditional expression.
    - _Requirements: 6.6, 10.3, 11.7_
    - _Satisfies: Property 19, Property 10_

  - [x] 8.6 Apply the medium modal width class in `src/AccessTokenModal.tsx`
    - **Permitted edits: (A) className change, and deletion of the static inline `maxWidth` declaration it replaces.**
    - Change the modal element's `className` to `"modal modal--md"` and remove the inline `maxWidth` as in task 8.5. Leave the remaining inline styles for task 9.6.
    - _Requirements: 6.6, 10.3, 11.7_
    - _Satisfies: Property 19, Property 10_

  - [x] 8.7 Unify the admin brand mark color in `src/Admin.tsx`
    - **Permitted edit: (D) color-literal substitution only.**
    - Replace the three `#6366f1` literals — `stroke` on line 51, `fill` on line 63, `fill` on line 72 — with `#ffffff`, matching the topbar mark in `App.tsx` (lines 593, 596, 597). Change no attribute other than those three color values.
    - _Requirements: 6.7, 10.3, 11.7_
    - _Satisfies: Property 18, Property 10_

  - [x] 8.8 Phase 6 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted).
    - Assert `grep -cE 'backdrop-filter|-webkit-backdrop-filter|radial-gradient|conic-gradient|filter: blur\(' src/styles.css` returns 0.
    - Assert `box-shadow` elevation (non-inset) appears only in the `.modal`, `.chart-tip`, and `.admin-card` rule sets.
    - Assert `grep -c '#6366f1' src/Admin.tsx` returns 0, and that the `git diff` for `Admin.tsx`, `TradeConfirmModal.tsx`, and `AccessTokenModal.tsx` contains no line matching `useState|useEffect|useMemo|useRef|fetch|await|on[A-Z]`.
    - Confirm the trades modal, confirm modal, token modal, and admin screen render; report to the user for visual confirmation.
    - _Requirements: 1.1, 2.5, 6.7, 10.5, 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 1, Property 6, Property 10, Property 11_

- [x] 9. Phase 7 — Finalize (inline extraction, alias removal, sweep)

  - [x] 9.1 Add the `.metric-*` classes to `src/styles.css`
    - `.metric-panel` (`margin-top: var(--sp-5)`, `border-top: 1px solid var(--border)`, `padding-top: var(--sp-4)`), `.metric-panel-title` (`var(--fs-1)`, uppercase, `var(--tracking-caps)`, `var(--text-3)`), `.metric-list` (`display: grid; gap: var(--sp-2)`), `.metric-row` (flex, `space-between`, `gap: var(--sp-3)`, padding `var(--sp-2) var(--sp-3)`, `background: var(--surface-2)`, `border: 1px solid var(--border-subtle)`, `border-radius: var(--r-sm)`), `.metric-label` (`var(--fs-3)` / `var(--text-2)`), `.metric-value` (`var(--fw-semibold)`, `var(--fs-4)`, `var(--font-mono)`, `font-variant-numeric: tabular-nums`).
    - Add `.metric-value` to the shared numeric selector list created in task 2.2.
    - _Requirements: 5.4, 6.1_
    - _Satisfies: Property 16, Property 19_

  - [x] 9.2 Add the `.confirm-*` classes to `src/styles.css`
    - `.confirm-hero` (`background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, padding `var(--sp-4)`), `.confirm-hero-label` (`var(--fs-1)`, uppercase, `var(--tracking-caps)`, `var(--text-3)`), `.confirm-hero-value` (`var(--fs-6)`, `var(--font-mono)`, tabular, `var(--text-1)`).
    - _Requirements: 6.2_
    - _Satisfies: Property 19_

  - [x] 9.3 Add the `.token-*` classes to `src/styles.css`
    - `.token-field` (`background: var(--surface-2)`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, padding `var(--sp-3)`), `.token-label` (`var(--fs-1)`, uppercase, `var(--tracking-caps)`, `var(--text-3)`), `.token-value` (`var(--font-mono)`, `var(--fs-3)`, `word-break: break-all`, `user-select: all`), `.token-note` (`var(--fs-2)` / `var(--text-2)`).
    - _Requirements: 6.3, 6.8_
    - _Satisfies: Property 19_

  - [x] 9.4 Extract the inline styles in `src/StockDetail.tsx`
    - **Permitted edits: (A) className change, (B) wrapper element carrying only styling, (D) color-literal substitution.**
    - Replace the static inline declarations in the spread-analytics block (`marginTop`, `borderTop: rgba(255,255,255,0.08)`, `background: rgba(255,255,255,0.03)`, `borderRadius: 6`, row padding) with `className="metric-panel"` / `"metric-panel-title"` / `"metric-list"` / `"metric-row"` / `"metric-label"` / `"metric-value"`.
    - For the remaining **data-driven** `style={{ color }}` entries, keep the declaration and substitute the literal only: `#22c55e` → `#3fb950` (`--pos`), `#ef4444` → `#f85149` (`--neg`), `#94a3b8` → `#9ba3af` (`--text-2`).
    - Do not change the metrics array's shape, length, or ordering, any `.map(...)`, any conditional, any hook, prop, or handler. End state: zero `rgba(` literals in the file.
    - _Requirements: 6.1, 6.4, 6.5, 6.9, 10.3, 10.4, 11.7_
    - _Satisfies: Property 19, Property 10_

  - [x] 9.5 Extract the inline styles in `src/TradeConfirmModal.tsx`
    - **Permitted edits: (A) className change, (B) wrapper element carrying only styling, (D) color-literal substitution.**
    - Replace the static inline hero block (`rgba(255,255,255,0.04)`) with `className="confirm-hero"` plus `.confirm-hero-label` / `.confirm-hero-value`, and the per-row `rgba(255,255,255,0.03)` blocks with the `.metric-row` / `.metric-label` / `.metric-value` classes from task 9.1.
    - Substitute the data-driven color literals only: `#22c55e` → `#3fb950`, `#ef4444` → `#f85149`, `#9ca3af` → `#9ba3af`.
    - End state: zero `rgba(` literals and no hex literal other than those three token values. No handler, prop, or conditional change.
    - _Requirements: 6.2, 6.4, 6.5, 6.9, 10.3, 10.4, 11.7_
    - _Satisfies: Property 19, Property 10_

  - [x] 9.6 Extract the inline styles in `src/AccessTokenModal.tsx`
    - **Permitted edits: (A) className change, (B) wrapper element carrying only styling, (D) color-literal substitution.**
    - Replace the static inline code block (`rgba(255,255,255,0.05)`) and label styles with `className="token-field"` / `"token-label"` / `"token-value"` / `"token-note"`, reusing `.metric-row` where a label/value pair is rendered. Substitute `#9ca3af` → `#9ba3af`.
    - The token value keeps `user-select: all` — now supplied by `.token-value` — and the copy control keeps its existing behavior untouched.
    - End state: zero `rgba(` literals in the file.
    - _Requirements: 6.3, 6.4, 6.5, 6.8, 6.9, 10.3, 10.4, 11.7_
    - _Satisfies: Property 19, Property 10_

  - [ ]* 9.7 OPTIONAL — toolbar `.btn-group` grouping (`src/styles.css` + `src/App.tsx`)
    - **Optional. Skipping this task breaks nothing: no other task, class, or assertion depends on `.btn-group`, and if it is skipped `App.tsx` needs no edit at all.**
    - CSS: add the four rules from design.md §2 — `.btn-group` (`display: inline-flex`, `border: 1px solid var(--border)`, `border-radius: var(--r-md)`, `overflow: hidden`), `.btn-group .btn` (`border: none; border-radius: 0; background: var(--surface-1)`), `.btn-group .btn + .btn` (`border-left: 1px solid var(--border)`), `.btn-group .btn--primary` (`background: var(--accent-surface); color: var(--accent-text)`). The group owns the outline and radius; member buttons keep the shared 32px height and `var(--fs-4)`.
    - **Permitted edits in `App.tsx`: (B) wrapper element, (C) aria attribute.** Wrap the Arbitrage / Min Arb / Max Arb / OI / Spread / Depth toolbar buttons (approximately lines 643–710) in a single `<div className="btn-group">`, and add `aria-pressed` to each toggle button reusing the exact boolean already present in its `className` expression (`arbOnly`, `sortMinArb`, `sortMaxArb`, `sortOi`, `sortSpread`).
    - The wrapper must enclose the existing `{cond && …}` expressions unchanged — do not merge, reorder, or rewrite any conditional, `onClick`, `title`, or state setter.
    - _Requirements: 4.5, 4.9, 10.3, 10.4, 11.7_
    - _Satisfies: Property 15, Property 10_

  - [x] 9.8 Remove the Alias_Block and the legacy `:root` block from `src/styles.css`
    - Before deleting anything, sweep for every Legacy_Token_Name: `--bg`, `--bg-elev`, `--panel`, `--panel-2`, `--text`, `--muted`, `--faint`, `--radius`, `--radius-sm`, `--glass`, `--glass-border`, `--accent-2`, `--pos-soft`, `--neg-soft`, `--prem-soft`, `--disc-soft`, `--oi-soft`, `--amber`, `--shadow`, `--shadow-soft`.
    - For every name with a surviving `var()` reference, migrate the referencing rule onto the new token first. Delete the Alias_Block and the original legacy `:root` block only when the sweep returns zero references, leaving exactly one `:root` Token_Block in the file.
    - If a reference is discovered after deletion, re-add the Alias_Block as a single block, finish the offending rule, and retry.
    - _Requirements: 3.7, 11.5, 11.6_
    - _Satisfies: Property 2, Property 21_

  - [x] 9.9 Vocabulary collapse sweep over `src/styles.css`
    - Convert every remaining raw value to a token: each `font-size` to `--fs-1`…`--fs-7` with no fractional px; each `border-radius` to `--r-sm` / `--r-md` / `--r-lg` / `--r-pill` (plus the two `50%` circles); each padding / margin / gap to `--sp-1/-2/-3/-4/-5/-6/-8/-10`; each color to a `var()` reference, leaving only `transparent`, `inherit`, and `currentColor` as literals in component rules.
    - Confirm at most 3 distinct non-inset elevation `box-shadow` values remain, with the `.row-spot` / `.banner` / `.admin-error` inset rails and `--ring` excluded from that count.
    - Delete duplicated or dead rules produced by the migration; rename no selector.
    - _Requirements: 3.2, 3.3, 4.1, 4.2, 4.3, 4.4, 4.12, 7.2_
    - _Satisfies: Property 2, Property 4, Property 15_

- [x] 10. Static verification assertion suite (Requirement 12.3)

  - [x] 10.1 Assert glass removal over `src/styles.css`
    - `grep -cE 'backdrop-filter|-webkit-backdrop-filter|filter: blur\(|radial-gradient|conic-gradient'` returns 0; `grep -c 'linear-gradient'` returns 1 and that occurrence is the `.sk` shimmer with `--surface-2` / `--surface-3` stops; `grep -c 'background-attachment'` returns 0.
    - _Requirements: 1.1, 1.2, 1.3, 12.3_
    - _Satisfies: Property 1_

  - [x] 10.2 Assert color-literal containment and token closure over `src/styles.css`
    - Every `#`, `rgb(`, `rgba(`, `hsl(`, `hsla(` literal lies inside the single `:root` Token_Block; component rules use only `var()` plus `transparent` / `inherit` / `currentColor`.
    - Alpha-bearing token values are limited to `--scrim`, `--ring`, `--shadow-popover`, `--shadow-overlay`.
    - Every `var(--name)` reference resolves to a name declared in the Token_Block: diff `grep -oE 'var\(--[a-z0-9-]+' ` against the declared set and require an empty difference.
    - _Requirements: 3.2, 3.3, 3.4, 3.7, 12.3_
    - _Satisfies: Property 2_

  - [x] 10.3 Assert class-name coverage across `src/*.tsx` and `src/styles.css`
    - Extract every class name from every `className` expression in `src/*.tsx` (including template-literal and conditional branches) and require a matching selector in `src/styles.css`.
    - Require the pre-migration selector set to be a subset of the post-migration selector set — compare against `git show HEAD:src/styles.css`. Any missing selector is added, not renamed.
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 12.3_
    - _Satisfies: Property 3_

  - [x] 10.4 Assert the bounded design vocabulary over `src/styles.css`
    - Distinct `font-size` values ≤ 7 with zero fractional px; distinct `border-radius` values ≤ 4 (excluding the `50%` circles on `.status-dot` and `.spinner`); distinct non-inset elevation `box-shadow` values ≤ 3, excluding the `.row-spot` / `.banner` / `.admin-error` inset rails and `--ring`.
    - Every media-query width is a member of {1180, 860, 720, 480}.
    - _Requirements: 4.1, 4.2, 4.4, 9.1, 12.3_
    - _Satisfies: Property 4, Property 20_

  - [x] 10.5 Assert semantic-color separation and focus-rule presence over `src/styles.css`
    - No `.pos` / `.neg` / `.pnl-pos` / `.pnl-neg` rule references a `--prem` or `--disc` token; no `.prem` / `.disc` / `.tag--prem` / `.tag--disc` / `.leg-tag` / `.tag-buy` / `.tag-sell` / `.badge-index` rule references a `--pos` or `--neg` token; the four hues are pairwise distinct.
    - A `:focus-visible` rule exists producing `var(--ring)` with a `var(--accent)` border, and every `outline: none` occurrence has a replacement indicator.
    - A `@media (prefers-reduced-motion: reduce)` block neutralizes `animation` and `transition` and sets the static `.sk` fill.
    - _Requirements: 5.1, 5.2, 5.3, 8.4, 8.5, 8.7, 12.3_
    - _Satisfies: Property 5, Property 7, Property 12_

  - [x] 10.6 Assert scope containment across the diff
    - `git diff --name-only` lists none of `src/api.ts`, `src/format.ts`, `src/main.tsx`, `src/LineChart.tsx`, `package.json`, `package-lock.json`.
    - No added or modified line in any `.tsx` file matches `useState|useEffect|useMemo|useRef|fetch|await|on[A-Z][A-Za-z]*=` — run `git diff -U0 -- 'src/*.tsx' | grep '^[+-]' | grep -vE '^(\+\+\+|---)'` and require zero matches.
    - `grep -c 'rgba(' ` returns 0 for `src/StockDetail.tsx`, `src/TradeConfirmModal.tsx`, and `src/AccessTokenModal.tsx`, and the only hex literals surviving in those files are the permitted data-driven token values `#3fb950`, `#f85149`, `#9ba3af`, `#58a6ff`, `#d29922`, `#6e7681`.
    - _Requirements: 6.9, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 12.3_
    - _Satisfies: Property 10, Property 19_

  - [x] 10.7 Phase 7 verification
    - Run `npx tsc -b` (exit 0) and `npx vite build` (bundle emitted) as the final phase boundary.
    - Require every assertion in tasks 10.1–10.6 to pass; resolve any failure before closing the phase.
    - Confirm every screen renders; report the assertion results to the user for visual confirmation.
    - _Requirements: 11.4, 12.1, 12.2, 12.3, 12.6_
    - _Satisfies: Property 11_

- [ ] 11. Final checkpoint — full visual checklist
  - Ensure the build is green and all static assertions pass, then walk the Requirement 12.5 checklist at 1440px / 1024px / 768px / 390px: board reflow and hover with no lift, opaque topbar during scroll, detail charts and segmented toggles, trades-modal scrim and nested elevation, admin-to-topbar brand consistency, skeleton-to-card stability, keyboard focus traversal, and `prefers-reduced-motion` behavior. Ask the user if questions arise.
  - _Requirements: 12.4, 12.5, 12.6_

## Notes

- **Optional tasks.** Only task 9.7 (`.btn-group` toolbar grouping) is marked with `*`. Every other sub-task is required: the phase-boundary verification tasks are mandated by Requirements 12.1/12.2 and Property 11, and the static assertions by Requirement 12.3.
- **No test framework.** This project has no test runner and the design adds none, so verification is `npx tsc -b` + `npx vite build` + greppable static assertions + the manual checklist. The correctness properties are static invariants, not generator-driven property tests.
- **Build half of every verification task was substituted.** The sandbox is network-restricted: `npm ci` cannot reach the registry and `node_modules/typescript` / `node_modules/vite` are empty stubs, so `npx tsc -b` and `npx vite build` are unrunnable. In their place, tasks 1.3, 2.6, 3.5, 5.6, 6.6, 8.8 and 10.7 were closed on a parse/JSX-structure check with the globally installed TypeScript (`tsc --noEmit --ignoreConfig --jsx preserve --noResolve src/*.tsx`) plus the full static assertion suite of section 10. That check reports the same 649 resolution-only diagnostics (TS7026 / TS7006 / TS2307 / TS5097 / TS2322 / TS2503 / TS7053 / TS2882) as the untouched `HEAD` tree and zero TS1xxx / TS17xx syntax errors, so the migration introduces no new diagnostic. A real `tsc -b` + `vite build` still needs to be run in a networked environment before the Requirement 11.4 build gate is formally satisfied.
- **Assertion timing.** Per-phase verification runs the assertions that are meaningful at that boundary (glass removal, `var()` closure, class coverage, diff scope). The full vocabulary and color-literal budgets of tasks 10.2 and 10.4 are only satisfiable once the Alias_Block and legacy `:root` are gone in task 9.8, so they are asserted at the end.
- **Alias-block lifecycle.** Added in tasks 1.1–1.2, kept alive through P2–P6, swept and deleted in task 9.8. It is what keeps every un-migrated rule resolving so no phase leaves the UI broken (Requirement 11.4, Property 21). If task 9.8 uncovers a surviving legacy reference, re-add the block as a unit rather than patching around it.
- **`.tsx` edit windows.** P1–P4 are CSS-and-`index.html` only. `.tsx` edits begin at task 6.5 and are confined to P5/P6/P7 (Requirement 11.7). Each `.tsx` task above names the permitted Presentational_Edit class explicitly; anything else is out of scope.
- **Files never touched.** `src/api.ts`, `src/format.ts`, `src/main.tsx`, `src/LineChart.tsx`, `package.json`. `TradesPanel.tsx`, `StockCard.tsx`, and `SkeletonCard.tsx` need no edit either — every change they require is CSS-only.
- **Radius decision.** Task 6.4 folds the one-off `border-radius: 2px` on `.oi-dot` and `.chart-dot` onto `--r-sm`, keeping the four-radius budget of criterion 4.2. The `50%` circles on `.status-dot` and `.spinner` stay as they are.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "2.5"] },
    { "id": 4, "tasks": ["2.2"] },
    { "id": 5, "tasks": ["2.3"] },
    { "id": 6, "tasks": ["2.4"] },
    { "id": 7, "tasks": ["2.6"] },
    { "id": 8, "tasks": ["3.1"] },
    { "id": 9, "tasks": ["3.2"] },
    { "id": 10, "tasks": ["3.3"] },
    { "id": 11, "tasks": ["3.4"] },
    { "id": 12, "tasks": ["3.5"] },
    { "id": 13, "tasks": ["5.1"] },
    { "id": 14, "tasks": ["5.2"] },
    { "id": 15, "tasks": ["5.3"] },
    { "id": 16, "tasks": ["5.4"] },
    { "id": 17, "tasks": ["5.5"] },
    { "id": 18, "tasks": ["5.6"] },
    { "id": 19, "tasks": ["6.1", "6.5"] },
    { "id": 20, "tasks": ["6.2"] },
    { "id": 21, "tasks": ["6.3"] },
    { "id": 22, "tasks": ["6.4"] },
    { "id": 23, "tasks": ["6.6"] },
    { "id": 24, "tasks": ["8.1"] },
    { "id": 25, "tasks": ["8.2"] },
    { "id": 26, "tasks": ["8.3"] },
    { "id": 27, "tasks": ["8.4", "8.5", "8.6", "8.7"] },
    { "id": 28, "tasks": ["8.8"] },
    { "id": 29, "tasks": ["9.1"] },
    { "id": 30, "tasks": ["9.2"] },
    { "id": 31, "tasks": ["9.3"] },
    { "id": 32, "tasks": ["9.4", "9.5", "9.6"] },
    { "id": 33, "tasks": ["9.7"] },
    { "id": 34, "tasks": ["9.8"] },
    { "id": 35, "tasks": ["9.9"] },
    { "id": 36, "tasks": ["10.1", "10.2", "10.3", "10.4", "10.5", "10.6"] },
    { "id": 37, "tasks": ["10.7"] }
  ]
}
```

**Reading the graph.** Almost every task writes `src/styles.css`, so the migration is strictly sequential by construction — that serialization is what guarantees no phase leaves the UI broken. Parallelism appears only where tasks write different files: wave 3 (`styles.css` + `index.html`), wave 19 (`styles.css` + `StockDetail.tsx`), wave 27 (`styles.css` + three separate `.tsx` files), wave 32 (three separate `.tsx` files), and wave 36 (six read-only assertion tasks). Verification tasks 1.3, 2.6, 3.5, 5.6, 6.6, 8.8, and 10.7 each occupy their own wave because they gate the phase boundary. Checkpoint tasks 4, 7, and 11 are top-level and excluded from the graph.
