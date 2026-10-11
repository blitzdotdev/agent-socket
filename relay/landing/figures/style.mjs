// Page-specific tokens for the figures, on top of the kit's ISO_CSS. The one
// accent is the extension's own pink: the lit plug's lamp, a call in flight
// and the in-page bar on the laptop screen.
export const FIGURE_CSS = `
.iso{--as-accent:#e6195e;--as-accent-soft:#fbd3e1;--anatomy-mono:var(--sans,Inter,ui-sans-serif,system-ui,sans-serif)}
.as-face{fill:var(--anatomy-face);stroke:none}
.as-hole{fill:var(--anatomy-shade-0);stroke:var(--anatomy-mid);stroke-width:var(--anatomy-weight)}
.as-window{fill:var(--anatomy-shade-1);stroke:none}
.as-glass{fill:#f3f4f6;stroke:none}
.as-digits{fill:var(--anatomy-hi);font-family:var(--anatomy-mono);font-weight:500;font-variant-numeric:tabular-nums;letter-spacing:.06em}
.as-lamp{fill:var(--anatomy-shade-1);stroke:none;transition:fill .4s var(--anatomy-ease)}
.as-lamp[data-on]{fill:var(--as-accent)}
.as-accent-line{stroke:var(--as-accent)}
.as-bead{fill:var(--as-accent);stroke:var(--anatomy-paper);stroke-width:.8}
.as-chrome{fill:#e9eaed;stroke:none}
.as-tab{fill:#f7f7f8;stroke:none}
.as-field{fill:#ffffff;stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight)}
.as-ext{fill:var(--anatomy-shade-1);stroke:var(--anatomy-mid);stroke-width:var(--anatomy-weight)}
.as-ext[data-on]{fill:var(--as-accent);stroke:none}
.as-dot{fill:var(--anatomy-lo)}
.as-led{fill:var(--anatomy-lo);transition:fill .2s}
.as-led[data-on]{fill:var(--as-accent)}
.as-row-hit{fill:transparent;stroke:none;transition:fill .3s}
.as-row-hit[data-on]{fill:var(--as-accent-soft)}
.as-card{fill:#fff;stroke:var(--anatomy-lo);stroke-width:var(--anatomy-weight);transition:fill .3s,stroke .3s}
.as-card[data-on]{fill:var(--as-accent-soft);stroke:var(--as-accent)}
.as-pill{fill:#16161a;stroke:var(--as-accent);stroke-width:.5}
.as-pill-dot{fill:var(--as-accent)}
.as-pill-text{stroke:#f2f2f5;stroke-width:.7;stroke-linecap:round;opacity:.75}
.as-pill-btn{fill:var(--as-accent)}
.as-hold-arc{fill:none;stroke:var(--as-accent);stroke-width:2.2;stroke-linecap:butt;opacity:.55}
.as-bead-turned{fill:var(--anatomy-paper);stroke:var(--as-accent);stroke-width:1.2}
.as-hit{fill:transparent;stroke:none;cursor:pointer;pointer-events:all}
[data-hero]:focus-visible{outline:2px solid var(--as-accent);outline-offset:6px}
`
