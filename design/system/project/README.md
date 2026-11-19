# Check Climate Africa

Check Climate Africa publishes Africa-centred climate news and fact checks. It exposes climate misinformation and amplifies local voices. Its strapline is **"Disseminating Critical Climate Information."**

This system is built from the live site, [checkclimate.africa](https://www.checkclimate.africa/), as of 16 November 2026. The site runs WordPress with the Blogar theme and Elementor. The values come from the theme's CSS variables, the Elementor kit globals, computed styles on the homepage, and colours sampled from the logo file. Anything assumed rather than measured is marked as assumed.

## Content fundamentals

**Voice.** A newsroom that verifies. It is direct, factual and calm, never alarmist and never preachy. Its job is to say what is true, what is not, and why it matters to people in Africa.

- **Headline prefixes do real work.** Verification pieces open with `FACT CHECK:`. Urgent public notices open with `ALERT:`. Both are in capitals and end with a colon, and the rest of the headline is in sentence case: "FACT CHECK: No, snow did not fall in Nigeria."
- **Lead with the claim and the answer.** Fact-check headlines either answer the claim ("No, …") or ask it plainly ("Does cold snap mean global warming is over?").
- **Africa first, named precisely.** Name the country, state or city (Lagos, Ilorin, Kenya, South Sudan), not just "Africa."
- **Sentence case** for headlines. **Title Case** for navigation and section titles (Top Stories, Latest Factchecks, Green Energy).
- **Categories** are fixed: Agriculture, Aviation, Environment, Fact Check, Green Energy, News, Sustainability. Tags such as "Climate disinformation", "Climate Action" and "Africa" refine them.
- **Readers are sources.** The footer invites readers to send in climate claims for checking. Keep that invitation wherever there is contact copy.
- Bylines read "Check Climate" for staff pieces. Show reading time as "2 min read."

## Visual foundations

**Colour.** The brand is two logo inks, **forest green** (`brand-forest`, #2C572A) and **sun amber** (`brand-amber`, #FFB600), on a clean white page. A brighter **leaf green** (`leaf`, #5CA024) marks interactive accents. **Deep green** (`brand-deep`, #003C25) and the **weather green** (`weather-surface`) are for dark fills. Everything else is neutral greys.

| Use | Token |
| --- | --- |
| Page / header and cards | `surface-page` / `surface-raised` |
| Category bar | `surface-muted` (#F0F2F5) |
| Footer band | `surface-footer` (#E7E7E7) |
| Headlines / body text | `ink` / `ink-body` |
| Nav and tab labels | `ink-muted` |
| Reading time, dates | `ink-meta` |
| Hairlines | `border` |
| Text on green or on photos | `on-brand`, `on-image` |

Rules:
- **Amber is a fill, never text on white** (1.8:1). Put black on amber, not white.
- **Small green text uses `brand-forest`** (8.4:1). `leaf` is 3.2:1 on white, so it is only for fills, icons, hover states and text at 24px or larger. The live site uses `leaf` for "See All" and the Light/Dark toggle; this system flags both.
- `amber-soft` (#E8BE43) is the hover colour for category and author links.
- `success`, `warning`, `danger` and `info` come from the theme and are signals only. Always pair them with a word.

**Dark mode** is a first-class theme. Readers switch it with the Light/Dark toggle. The page turns `#212121` and cards `#1A1A1A`, headlines go white and body text goes `#C7C5C5`. The brand greens and amber do not change.

**Type.** One family: **Red Hat Display**, a geometric grotesque from Google Fonts, used at 400, 500, 700 and 900. Body copy is large and airy (18px on a 30px line). Headlines are bold and tight: section titles 36px, hero headlines 30px, card headlines 24px, list headlines 18px. Labels and navigation use 500. (The Elementor kit also lists Roboto and Roboto Slab, but the theme overrides them everywhere, so they are not part of the system.)

**Shape.** Soft and consistent: 10px corners (`radius`) on every photo, card and panel, 6px on tabs, 8px on the weather widget, and full pills for the toggle and back-to-top button.

**Depth.** Flat. There is one shadow, `shadow-primary` (`0 4px 10px rgba(37,47,63,.1)`), used to lift the selected tab. Elsewhere, separate things with surface tints and 1px `border` hairlines, not shadows.

**Imagery.** Photography leads. Use real reportage of African places, people, farms, floods and energy projects, cropped edge to edge with 10px corners. Over photos, text is white with a dark fade behind it. Do not use stock illustrations or decorative gradients.

**Spacing.** A tight 10px gutter on bands (`space-2`), 20px inside panels (`space-4`), and 30px between story rows (`space-5`).

## Iconography

- **Font Awesome 5** (Pro and Brands) for the interface: social links, search, share buttons, meta icons. Use solid or regular weights at text size, in the text colour.
- **Weather Icons 2.0** for the header weather widget (sun, humidity, wind, sunrise, sunset), in white on `weather-surface`.
- Share buttons for Facebook, Twitter and LinkedIn use their network colours (`social-*` tokens).
- These icon fonts are licensed separately and are not bundled here. The previews show text or simple strokes in their place.

## Logo

The logo is a sun with hand-drawn rays around a ring, with a check mark over an amber disc. Beside it sits the stacked wordmark **CHECK** (forest) **CLIMATE** (amber). Six files are in **Assets › Logos**: the primary lockup, a reverse lockup, the mark on transparent, white and forest grounds, and a simplified mark without rays for small sizes. That group's README says which file goes where.

- The header uses `check-climate-lockup.png` at 40px tall, with the strapline under it in 10px black.
- Use only the supplied files. Never redraw or recolour the mark, and never set the wordmark in Red Hat Display.
- Dark mode swaps in `check-climate-lockup-reverse.png` for the lockup and `check-climate-mark-simple.png` for the icon.

## Components

The components mirror the homepage: SiteHeader, CategoryNav, WeatherCard, ThemeToggle, SectionHeading, CategoryTabs, HeroStory, StoryCard, StoryList, BackToTop and SiteFooter. They are CSS classes in `components/bundle.css` (prefix `cc-`, wrapped in a `.cc` root) with no JavaScript, to match a WordPress/Elementor build. Each component has a README listing the tokens it uses and what you have to supply.
