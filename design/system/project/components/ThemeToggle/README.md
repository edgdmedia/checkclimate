# ThemeToggle

A two-segment pill that switches the site between Light and Dark mode.

- Outline 1px `leaf`, radius `radius-pill`. The selected half fills `leaf` with `on-brand` text; the other half is `leaf` text on the page.
- Labels: `label` style (14px / 500).
- Accessibility: `leaf` with white, and `leaf` on white, are 3.2:1 — below AA for 14px text. This matches the live site and is flagged, not fixed. To fix, move the fill to `brand-forest` (8.4:1).
- On the live site this sits as a fixed tab on the right edge of the screen.
- Consumer provides: the state and the handler that sets `data-theme` (the site toggles `body.active-dark-mode`).
