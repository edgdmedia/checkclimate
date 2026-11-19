# SiteHeader

The top band of every page: the logo with the strapline "Disseminating Critical Climate Information" on the left and the live weather widget on the right.

- Background `surface-raised`; side gutter `space-2`.
- Logo: `assets/Logos/check-climate-lockup.png` at 40px tall (120 × 40), linking home, with `alt="Check Climate"`. In dark mode, swap in `check-climate-lockup-reverse.png`. Put both images in the markup with `.cc-logo-light` and `.cc-logo-dark`; the stylesheet shows the one that matches the theme.
- Strapline: `tagline` style (10px), `ink`, directly under the logo.
- Right side: a [WeatherCard](../WeatherCard/README.md).
- Consumer provides: the link to home and the weather data.
