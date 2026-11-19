# WeatherCard

A compact green panel in the header showing the reader's local temperature, place, time, humidity, visibility, sunrise and sunset.

- Panel: `weather-surface`, radius `radius-widget` (8px), padding `space-4` (20px). Text `on-brand` (white, AA on the green).
- Temperature: `weather-temp` style (30px / 500). Other readings: 12px.
- Three columns: temperature and place, then two pairs of readings. The site adds Weather Icons glyphs (sun, humidity, wind, sunrise, sunset) before each reading.
- Data comes from the site's own `edgd-weather` plugin.
- Consumer provides: the readings and the icons.
