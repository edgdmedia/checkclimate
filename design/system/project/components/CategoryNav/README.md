# CategoryNav

The full-width grey bar under the header listing the seven story categories, with the social links on the right.

- Bar: `surface-muted`, height `nav-height` (53px), gutter `space-2`.
- Items: `nav` style (15px / 500), `ink-muted`, padding 13px × 11px. Hover and current page turn `brand-forest` (the live site uses `leaf` on hover; `brand-forest` is used here for AA contrast on the grey).
- Categories, in this order: Agriculture, Aviation, Environment, Fact Check, Green Energy, News, Sustainability.
- Social links: Facebook, Twitter, YouTube. The site uses Font Awesome 5 brand icons; the preview shows plain letters in their place.
- On narrow screens the site collapses this into a hamburger (Elementor nav menu).
- Consumer provides: the category links and `aria-current` on the active one.
