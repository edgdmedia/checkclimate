# StoryList

A compact vertical list of stories, each with a square thumbnail, category and short headline. Used beside a HeroStory and in the Latest Factchecks block.

- Row: 100px thumbnail (radius `radius`) + text, gap `space-4`, separated by 1px `border` hairlines.
- Headline: `list-title` style (18px / 700), `ink`.
- Newsroom prefixes ("FACT CHECK:", "ALERT:") are part of the headline. Wrap them in `.cc-kicker` to set them in `brand-forest` (light) or `brand-amber` (dark). This tint is a suggestion from this system; the live site sets the prefix in the headline colour.
- Consumer provides: thumbnails, links and headlines.
