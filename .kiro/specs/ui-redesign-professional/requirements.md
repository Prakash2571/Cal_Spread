# Requirements Document

## Introduction

Calspread is a React 18 + TypeScript + Vite dashboard for calendar-spread trading whose entire visual layer lives in `src/styles.css`. The current theme is glassmorphic: blurred translucent surfaces, radial-gradient body wash, gradient card overlays, a glowing gradient brand mark, and lift-on-hover transforms. The stylesheet has also accumulated an inconsistent vocabulary — six border radii, eighteen distinct font sizes of which six are fractional, arbitrary paddings — and three components bypass the stylesheet entirely with hardcoded inline hex colors.

This feature replaces that aesthetic with a flat, opaque, terminal-grade surface system in which depth is expressed as discrete surface-elevation steps plus 1px hairline borders, and shadows are reserved for true overlays. It is simultaneously a consistency pass that collapses every ad-hoc value onto a formal token scale and pulls the inline styles back into the stylesheet.

These requirements are derived from the approved design document and are scoped by the same guardrail: the change is presentation-only. No application logic is modified.

## Glossary

- **Calspread_UI**: The rendered presentation layer of the Calspread application, comprising the DOM produced by the components in `src/` styled by the Stylesheet.
- **Stylesheet**: The single stylesheet file `src/styles.css`.
- **Token_Block**: The `:root` custom-property declaration block in the Stylesheet that defines all design tokens.
- **Alias_Block**: The temporary `:root` block that maps legacy token names (`--bg`, `--panel`, `--glass`, `--radius`, and related names) onto the new tokens during migration.
- **Surface_Token**: One of the four opaque background tokens `--surface-0`, `--surface-1`, `--surface-2`, `--surface-3`, whose numeric suffix is the token's **surface index**.
- **Elevation_Token**: One of the two `box-shadow` tokens `--shadow-popover` and `--shadow-overlay`.
- **Semantic_Color**: One of the four state hues `--pos`, `--neg`, `--prem`, `--disc`, each paired with a tinted surface token (`--pos-surface`, `--neg-surface`, `--prem-surface`, `--disc-surface`).
- **Numeric_Cell**: Any element that renders a price, quantity, percentage, spread value, or profit-and-loss figure.
- **Migration**: The seven-phase execution plan that transforms the current Stylesheet and component markup into the redesigned state.
- **Verification_Suite**: The combination of the TypeScript build check, the Vite production build, the static grep assertions, and the manual visual checklist used to confirm each Migration phase.
- **Legacy_Token_Name**: Any custom-property name defined only in the Alias_Block.
- **Presentational_Edit**: An edit to a `.tsx` file limited to a `className` attribute value, a wrapper element that carries only styling or ARIA attributes, an `aria-*` attribute, or the substitution of a static color literal with a token hex value.

## Requirements

### Requirement 1: Removal of Glassmorphism

**User Story:** As a trader reading live numbers, I want opaque, unblurred surfaces, so that prices stay crisp and the interface reads as a professional trading terminal rather than a decorative demo.

#### Acceptance Criteria

1. THE Stylesheet SHALL contain zero occurrences of `backdrop-filter`, zero occurrences of `-webkit-backdrop-filter`, zero occurrences of `filter: blur(`, and zero occurrences of `conic-gradient`.
2. THE Stylesheet SHALL contain zero occurrences of `radial-gradient`.
3. THE Stylesheet SHALL restrict `linear-gradient` to the `.sk` skeleton shimmer rule set, yielding exactly one gradient consumer in the Stylesheet, and THE `.sk` gradient SHALL express its stops as opaque Surface_Token values in place of the current `rgba(255,255,255,0.04)` and `rgba(255,255,255,0.08)` stops.
4. THE `.topbar` selector SHALL declare an opaque `var(--surface-0)` background and a `1px solid var(--border)` bottom border.
5. THE `.modal-overlay` selector SHALL declare a solid `var(--scrim)` background and no filter declaration.
6. THE `body` selector SHALL declare a flat `var(--surface-0)` background and omit the `background-attachment` declaration.
7. THE `.brand-mark` selector SHALL declare a flat `var(--accent)` background, a white glyph color, and no `box-shadow`.
8. THE `.card` and `.detail-chart` selectors SHALL declare a flat `var(--surface-1)` background with no gradient overlay and no `::before` accent rule.
9. WHEN a pointer hovers a `.card`, a `.btn`, or a `.trade-card`, THE Calspread_UI SHALL change only the `background` and `border-color` of the hovered element, and THE hover rule set SHALL declare no `transform`, no `box-shadow`, no `filter`, and no `opacity`, holding the element's rendered position unchanged.
10. THE Stylesheet SHALL express every border color and row-stripe fill as an opaque token drawn from `var(--border-subtle)`, `var(--border)`, `var(--border-strong)`, or a Surface_Token.

### Requirement 2: Surface Elevation Model

**User Story:** As a trader scanning a dense board, I want depth communicated by solid layered fills and hairline borders, so that panels, rows, and overlays are distinguishable without translucency reducing text legibility.

#### Acceptance Criteria

1. THE Token_Block SHALL define exactly four Surface_Tokens covering the app background, the card and panel level, the table-row and input level, and the interaction level.
2. THE Stylesheet SHALL fill the background of every visible component with a single Surface_Token reference.
3. THE Stylesheet SHALL separate adjacent surfaces with a `1px solid` border token reference.
4. WHERE one component is nested inside another component whose surface index is below 3, THE nested component SHALL declare a Surface_Token whose surface index is greater than the surface index of the containing component.
5. THE Stylesheet SHALL apply an Elevation_Token only within the `.modal`, `.chart-tip`, and `.admin-card` rule sets.
6. THE `.card`, `.panel`, `.detail-chart`, and `.trade-card` selectors SHALL omit the `box-shadow` declaration.
7. THE `.row-spot` selector SHALL indicate the spot row with a `var(--accent-surface)` background and a 3px inset left marker rail in `var(--accent)`, using the same rail width as `.banner`.
8. THE `.banner` selector SHALL indicate severity with a 3px inset left rail, using `var(--neg)` for the error variant and `var(--accent)` for the info variant.
9. WHERE a component is nested inside a containing component that already declares `--surface-3`, THE nested component SHALL declare `--surface-3` and SHALL separate itself from the containing component with a `1px solid var(--border-strong)` border.

### Requirement 3: Token System as Single Source of Truth

**User Story:** As a developer maintaining the interface, I want every visual value to originate from one declared token, so that a change to the palette or scale propagates everywhere without hunting for ad-hoc literals.

#### Acceptance Criteria

1. THE Token_Block SHALL define tokens for surfaces, borders, text roles, accent roles, semantic state colors, data-visualization colors, font families, font sizes, font weights, line heights, letter spacing, spacing steps, radii, elevation, scrim, focus ring, and motion.
2. THE Stylesheet SHALL yield zero `#` hexadecimal literals, zero `rgb(` literals, zero `rgba(` literals, zero `hsl(` literals, and zero `hsla(` literals outside the Token_Block, permitting the keywords `transparent`, `inherit`, and `currentColor` in component rules.
3. WHERE a component rule requires a color, THE rule SHALL reference the color through a `var()` token reference.
4. THE Token_Block SHALL restrict alpha-channel color values to `--scrim`, `--ring`, `--shadow-popover`, and `--shadow-overlay`.
5. THE `index.html` file SHALL declare a `theme-color` value of `#0f1216`.
6. THE Stylesheet SHALL retain the existing Inter and JetBrains Mono font families and add no additional font family.
7. IF a `var()` reference in the Stylesheet resolves to no token declared in the Token_Block or the Alias_Block, THEN THE Migration SHALL add the missing token declaration or correct the reference before the phase reaches completion.

### Requirement 4: Bounded and Consistent Design Vocabulary

**User Story:** As a trader moving between the board, the detail page, and the modals, I want identical controls to look identical, so that the interface feels like one product instead of several screens built at different times.

#### Acceptance Criteria

1. THE Stylesheet SHALL express every `font-size` value as one of the seven scale tokens `--fs-1` through `--fs-7`, yielding at most 7 distinct font-size values and zero fractional pixel sizes.
2. THE Stylesheet SHALL express every `border-radius` value as one of `--r-sm`, `--r-md`, `--r-lg`, or `--r-pill`, yielding at most 4 distinct radius values.
3. THE Stylesheet SHALL express every padding, margin, and gap value as one of the eight 4px-based spacing tokens `--sp-1`, `--sp-2`, `--sp-3`, `--sp-4`, `--sp-5`, `--sp-6`, `--sp-8`, and `--sp-10`, whose names track the 4px multiple rather than a consecutive index.
4. THE Stylesheet SHALL define at most 3 distinct non-inset elevation `box-shadow` values, comprising `--shadow-popover`, `--shadow-overlay`, and at most one further value, and SHALL hold the inset marker rails of `.row-spot` and `.banner` and the `--ring` focus indicator outside that budget.
5. THE `.btn` selector SHALL render a 32px control height at `--fs-4` with `--r-md` and THE `.btn--sm` selector SHALL render a 26px control height at `--fs-3` above the 480px breakpoint, deferring to the minimum height of criterion 8.6 at 480px and below.
6. THE `.search`, `.rf`, and `.admin-input` selectors SHALL share one input tuple of `var(--surface-2)` fill, `1px solid var(--border)`, `--r-md` radius, 32px height, `--fs-4` font size, and left-aligned text.
7. THE `.chip` selector SHALL apply one geometry — `min-width: 60px`, `--sp-1` vertical and `--sp-2` horizontal padding, `--r-sm` radius, and semibold `--fs-3` in `var(--font-mono)` — that every state modifier of `.chip` retains.
8. THE Stylesheet SHALL apply `--tracking-caps` only to uppercase micro-label rules and SHALL declare no letter-spacing on body text and headings.
9. THE Stylesheet SHALL define exactly four button variants (`.btn--primary`, `.btn--trade`, `.btn--danger`, `.btn--danger-ghost`) over the shared `.btn` geometry.
10. WHILE an interactive element carries the `disabled` attribute or `aria-disabled="true"`, THE Calspread_UI SHALL render the element at 0.45 opacity with a default cursor and SHALL compute identical `background`, `border-color`, and `transform` values for the element whether or not a pointer hovers it.
11. THE `.chart-toggle` selector SHALL render a segmented control in which exactly one segment carries the active `var(--accent)` fill, at a 28px segment height above the 480px breakpoint and at the minimum height of criterion 8.6 at 480px and below.
12. IF a needed visual value is expressed by no token declared in the Token_Block, THEN THE Migration SHALL map the value to the nearest declared token or add a new token to the Token_Block.

### Requirement 5: Preservation of Color Semantics and Numeric Legibility

**User Story:** As a trader, I want premium-versus-discount and profit-versus-loss to stay visually separate, so that I never misread a discounted contract as a losing position.

#### Acceptance Criteria

1. THE Token_Block SHALL define `--pos`, `--neg`, `--prem`, and `--disc` as four distinct hues.
2. THE Stylesheet SHALL map the `.prem`, `.disc`, `.tag--prem`, `.tag--disc`, `.leg-tag`, and `.badge-index` selectors to the `--prem` and `--disc` token families only.
3. THE Stylesheet SHALL map the `.pos` and `.neg` selectors to the `--pos` and `--neg` token families only.
4. THE Stylesheet SHALL render every Numeric_Cell in `var(--font-mono)` with `font-variant-numeric: tabular-nums`, covering `.num`, `.card-price`, `.chip`, `.leg-cell`, `.trade-pnl`, and `.metric-value`.
5. THE Migration SHALL replace the current `StockDetail` series constants `LINE_COLORS = ["#4d8bff", "#22c55e", "#f59e0b"]` and `EXPIRED_COLOR = "#8d97ac"` with the `--series-1`, `--series-2`, and `--series-3` token values in near, next, far contract order and the `--series-expired` token value respectively.
6. THE Stylesheet SHALL render SVG chart furniture with `var(--chart-grid)`, `var(--chart-guide)`, and `var(--text-3)` at `--fs-1` for axis labels.
7. THE Stylesheet SHALL render banner text in `var(--neg)` for the error variant and `var(--accent-text)` for the info variant.
8. THE Calspread_UI SHALL accompany every premium-versus-discount value and every profit-versus-loss value with a sign character or a text label in addition to its hue, so that the distinction survives grayscale rendering and color-vision deficiency.

> Criterion 8 requires no logic change: `src/format.ts` already emits signed values (`+` / `−`) for percentages and money, so the redundant cue exists in the rendered text today and Requirement 10.1 keeps that file unchanged.

### Requirement 6: Extraction of Hardcoded Inline Styles

**User Story:** As a developer, I want the three components that style themselves inline to consume stylesheet classes, so that the token system actually governs the whole interface and future palette changes cannot drift.

#### Acceptance Criteria

1. THE Stylesheet SHALL define `.metric-panel`, `.metric-panel-title`, `.metric-list`, `.metric-row`, `.metric-label`, and `.metric-value`, and THE `StockDetail` spread-analytics block SHALL consume those classes in place of the inline border, background, radius, and margin declarations.
2. THE Stylesheet SHALL define `.confirm-hero`, `.confirm-hero-label`, and `.confirm-hero-value`, and THE `TradeConfirmModal` component SHALL consume those classes together with the `.metric-*` classes.
3. THE Stylesheet SHALL define `.token-field`, `.token-label`, `.token-value`, and `.token-note`, and THE `AccessTokenModal` component SHALL consume those classes.
4. WHERE an inline style value is computed from rendered data, THE component SHALL retain the inline declaration and SHALL substitute the color literal with the corresponding token hex value.
5. WHERE an inline style value is static, THE component SHALL delegate the declaration to a stylesheet class.
6. THE Stylesheet SHALL define `.modal--sm` at 440px and `.modal--md` at 520px, and THE `TradeConfirmModal` and `AccessTokenModal` components SHALL consume those classes in place of inline `maxWidth` declarations.
7. THE `Admin` brand-mark SVG SHALL declare `#ffffff` stroke and fill values, matching the topbar brand mark.
8. THE `AccessTokenModal` token value element SHALL retain `user-select: all` and THE copy control SHALL retain existing behavior.
9. WHEN the finalization phase reaches completion, THE Verification_Suite SHALL confirm that `StockDetail.tsx`, `TradeConfirmModal.tsx`, and `AccessTokenModal.tsx` each contain zero `rgba(` literals and zero hexadecimal color literals other than the token values permitted by criterion 6.4.

### Requirement 7: Class-Name Contract Preservation

**User Story:** As a developer, I want every existing class name to survive the redesign, so that no element silently renders unstyled while the stylesheet is rewritten rule by rule.

#### Acceptance Criteria

1. THE Migration SHALL retain a matching selector in the Stylesheet for every class name referenced by a `className` expression in `src/*.tsx`.
2. THE Migration SHALL introduce new class names additively, rewriting rule bodies rather than renaming selectors.
3. WHEN a Migration phase reaches completion, THE Verification_Suite SHALL resolve every `className` string literal in `src/*.tsx` against a Stylesheet selector.
4. IF a referenced class name resolves to no Stylesheet selector, THEN THE Migration SHALL add the missing selector before the phase reaches completion.

### Requirement 8: Accessibility

**User Story:** As a keyboard user, a low-vision user, or a phone user, I want readable contrast, a visible focus indicator, reachable tap targets, and respected motion preferences, so that the redesign is usable rather than merely attractive.

#### Acceptance Criteria

1. THE Stylesheet SHALL pair text and background tokens so that every pair reaches a contrast ratio of at least 4.5:1 below `--fs-5` and at least 3:1 at `--fs-5` or larger in bold weight.
2. THE Stylesheet SHALL use `--accent` as a fill token and SHALL render accent-colored text with `--accent-text`.
3. THE Token_Block SHALL derive each Semantic_Color surface tint as a dark mix over `--surface-1` so that the paired foreground reaches at least 4.5:1.
4. WHEN a `button`, `a`, `input`, or `[tabindex]` element receives keyboard focus, THE Calspread_UI SHALL render `var(--ring)` and a `var(--accent)` border through a `:focus-visible` rule.
5. WHERE a rule declares `outline: none`, THE rule SHALL supply a `:focus-visible` replacement indicator.
6. WHILE the viewport width is 480px or less, THE Calspread_UI SHALL compute a minimum height of at least 44px for every `button`, `a.btn`, `input`, and `.chart-toggle` segment.
7. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE Stylesheet SHALL neutralize every `animation` and `transition` declaration and SHALL render the skeleton as a static `var(--surface-2)` fill.
8. THE `.status--live` selector SHALL retain the `pulse` animation as a live-data affordance with a glow radius of at most 4px.
9. THE `.trade-card--closed` selector SHALL render at full opacity, using `var(--text-2)` values and a `.trade-closed-tag` badge to signal closed state.

### Requirement 9: Responsive Layout Consistency

**User Story:** As a trader who checks positions on a phone and manages them on a desktop, I want one coherent set of breakpoints, so that the board and the detail page reflow together rather than at unrelated widths.

#### Acceptance Criteria

1. THE Stylesheet SHALL define exactly four breakpoints at 1180px, 860px, 720px, and 480px.
2. WHILE the viewport width is 1181px or greater, THE Calspread_UI SHALL render the cards grid in 3 columns, the detail grid as `minmax(300px,380px) 1fr`, and shell padding of `--sp-6`.
3. WHILE the viewport width is between 861px and 1180px, THE Calspread_UI SHALL render the cards grid in 2 columns and the detail grid in 2 columns with shell padding of `--sp-6`.
4. WHILE the viewport width is between 721px and 860px, THE Calspread_UI SHALL render the cards grid in 2 columns, the detail grid in 1 column, and shell padding of `--sp-4`.
5. WHILE the viewport width is between 481px and 720px, THE Calspread_UI SHALL render one card column, a full-width search control at `order: 3`, and shell padding of `--sp-3`.
6. WHILE the viewport width is 480px or less, THE Calspread_UI SHALL render one card column, a fixed table layout, table text at `--fs-2`, and shell padding of `--sp-2`.
7. THE `.skeleton .card-table td` and `.card-table td` selectors SHALL share the same cell padding token pair so that replacing a skeleton with a loaded card shifts no layout.

### Requirement 10: Presentation-Only Scope Guardrail

**User Story:** As the owner of a live trading dashboard, I want the redesign to touch no behavior, so that a purely visual change carries no risk to order flow, data fetching, or state.

#### Acceptance Criteria

1. THE Migration SHALL leave `src/api.ts` and `src/format.ts` unchanged.
2. THE Migration SHALL leave the logic of `src/main.tsx` and `src/LineChart.tsx` unchanged.
3. THE Migration SHALL restrict every `.tsx` file change to a Presentational_Edit.
4. IF a proposed change adds, removes, or modifies a hook call, an event handler, a prop, an API call, or a conditional-rendering expression, THEN THE Migration SHALL reject the proposed change.
5. THE Verification_Suite SHALL confirm that no changed line in a `.tsx` file contains `useState`, `useEffect`, `useMemo`, `useRef`, `fetch`, `await`, or an `on[A-Z]` handler assignment.
6. THE Migration SHALL add no runtime dependency.

### Requirement 11: Phased Migration with a Continuously Working Build

**User Story:** As a developer executing a full-stylesheet rewrite, I want each phase to end with a working, viewable application, so that the redesign can be paused, reviewed, or reverted at any point.

#### Acceptance Criteria

1. WHEN Phase 1 executes, THE Migration SHALL add the Token_Block and the Alias_Block additively, leaving existing rules operational.
2. WHILE the Alias_Block is present, THE Stylesheet SHALL resolve every Legacy_Token_Name to a new token value.
3. THE Migration SHALL execute the phases in the order tokens, base, shell, board, detail, overlays, finalization.
4. WHEN a Migration phase reaches completion, THE Calspread_UI SHALL render every screen in a viewable, non-broken state.
5. WHEN the finalization phase begins, THE Verification_Suite SHALL search the Stylesheet for every Legacy_Token_Name before the Alias_Block is deleted.
6. IF a Legacy_Token_Name reference remains in the Stylesheet, THEN THE Migration SHALL retain the Alias_Block and migrate the referencing rule set before deleting the Alias_Block.
7. THE Migration SHALL confine `.tsx` edits to the detail, overlay, and finalization phases, after the target Stylesheet classes exist.

### Requirement 12: Verification

**User Story:** As a reviewer, I want a concrete pass or fail signal for each phase, so that "looks more professional" is checked against stated invariants rather than opinion.

#### Acceptance Criteria

1. WHEN a Migration phase reaches completion, THE Verification_Suite SHALL run `npx tsc -b` and SHALL require exit code 0.
2. WHEN a Migration phase reaches completion, THE Verification_Suite SHALL run `npx vite build` and SHALL require a successfully emitted bundle.
3. THE Verification_Suite SHALL apply static text assertions over the Stylesheet and the `.tsx` files covering glass removal, color-literal containment, class-name coverage, vocabulary bounds, semantic-color separation, focus-rule presence, and scope containment.
4. WHERE the project provides no test framework, THE Verification_Suite SHALL substitute a manual visual checklist executed at 1440px, 1024px, 768px, and 390px viewport widths.
5. THE manual visual checklist SHALL cover board reflow and hover behavior, topbar opacity during scroll, detail-page charts and segmented toggles, the trades modal scrim and nested elevation, admin-to-topbar brand consistency, skeleton-to-card stability, keyboard focus traversal, and reduced-motion behavior.
6. IF a verification check fails, THEN THE Migration SHALL resolve the failure before the phase reaches completion.
