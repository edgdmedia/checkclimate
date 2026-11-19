# CategoryTabs

A row of tab buttons that filters the Top Stories block by category (Agriculture, Environment, Green Energy, Aviation).

- Button: height `tab-height` (46px), padding 0 × `space-3`, radius `radius-small`, 18px / 700.
- Selected: `surface-raised` with `shadow-primary`, text `ink`. In dark mode the selected tab fills `border-strong` (#050505) with no shadow, as the theme does.
- Unselected: transparent, text `ink-muted`. (Assumed from the Blogar theme; only the selected state was measured on the live page.)
- Use `role="tablist"` / `role="tab"` and `aria-selected`.
- Consumer provides: the categories, selected state and the panel it controls.
