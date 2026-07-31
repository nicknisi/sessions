# Design

The visual world of `sessions` was not invented for the website. It already
exists in code, in the two HTML artifacts the CLI writes:

- `src/report/html.ts` — the usage dashboard (dark + light, four accents)
- `src/wrapped/html.ts` — the year-in-review deck (dark only, six accents)

This file documents that world and extends it to a third surface,
`sessions.engineering`. The rule that follows from that ordering: **when this
file and the report disagree, the report wins and this file is wrong.** The site
is the newcomer.

`ideation.engineering` deliberately wears a different world. These two are
siblings, not twins; do not import anything from it.

## Color

### Accents are derived, never hand-picked

Four accents, each stored as a hue and a chroma only. Every other value is
computed from that pair, in OKLCH, so all four stay at matched visual value.

| name    | hue | chroma |
| ------- | --- | ------ |
| violet  | 288 | 0.20   |
| cyan    | 212 | 0.14   |
| magenta | 348 | 0.21   |
| mono    | 265 | 0.022  |

Order is `violet, cyan, magenta, mono`; the default is **violet**. That order is
the picker's order in the report and must not be re-sorted.

The two derivations the site needs, matching `palette()` exactly:

```
dark   accent = oklch(82% c h)        accent-ink = oklch(17% 0.05 h)
light  accent = oklch(48% (c*0.92) h) accent-ink = oklch(98% 0.02 h)
```

Express these in CSS with `--accent-h` / `--accent-c` custom properties and let
`oklch()` do the arithmetic. Switching accent then sets two numbers, and every
derived value follows — the same single-source property the report has.

**The accent is user-switchable, so it can never be the only carrier of
meaning.** Anything the accent marks must also be marked by weight, position,
shape, or a label.

### Grounds

Three depths, not two. The report nests them: page → shell → surface.

|           | dark                     | light                   |
| --------- | ------------------------ | ----------------------- |
| `bg`      | `oklch(10.5% 0.012 265)` | `oklch(95.5% 0.004 95)` |
| `shell`   | `oklch(13.5% 0.014 265)` | `oklch(92.5% 0.005 95)` |
| `surface` | `oklch(17% 0.018 265)`   | `oklch(99.5% 0.002 95)` |
| `line`    | `oklch(26% 0.02 265)`    | `oklch(87% 0.008 95)`   |
| `ink`     | `oklch(95% 0.005 265)`   | `oklch(21% 0.01 265)`   |
| `ink-2`   | `oklch(66% 0.02 265)`    | `oklch(44% 0.015 265)`  |
| `ink-3`   | `oklch(57% 0.02 265)`    | `oklch(52% 0.015 265)`  |

Note the hue flip: the dark ground is cool (265), the light ground is warm (95).
That is deliberate and it is why light mode reads as paper rather than as an
inverted screen. Keep it.

**Dark is the default.** The physical scene decides it: this is read next to a
terminal, and the artifact it is selling opens on a dark ground. Light is
offered, never assumed.

## Type

Two faces, latin subset.

- **Space Grotesk** — display and body.
- **JetBrains Mono** — labels, figures, code, anything countable.

These are pinned by the incumbent implementation. They are not open for
reselection on the website; a third surface in a different face would break the
one thing this site is for. A saturated-pattern check will flag Space Grotesk as
an overused face, and it is right in general and wrong here: this is a brand
commitment inherited from a shipped artifact, not a fresh pick.

One deliberate divergence: **the report loads these two faces from Google Fonts;
the site self-hosts them.** The report is a local file a person opens once, and a
CDN link keeps it small. The site is a public page with a `default-src 'self'`
CSP and a standing rule of zero external requests, so it vendors the five woff2
faces into `site/public/fonts/` instead. Same faces, different delivery, on
purpose — do not "fix" the site to match the report here.

The division of labor is strict and is the world's most recognizable trait:

- **Numbers are always mono, always `font-variant-numeric: tabular-nums`.** A
  figure that shifts width while animating is a bug.
- **Section headings are mono**, 11px, weight 700, `letter-spacing: .18em`,
  uppercase, accent-colored. Not Space Grotesk. This is the report's `h2` and it
  is the strongest signal that the site and the product are one thing.
- **The wordmark is mono**, 12px, weight 700, `letter-spacing: .24em`,
  uppercase, accent-colored — the report's `.brand`.
- **Display type is Space Grotesk**, heavy, tight (`letter-spacing: -.03em`),
  and it is allowed to be enormous. The wrapped deck runs `clamp(3rem, 9vw,
5.6rem)` at weight 900.
- The wordmark in prose is lowercase: `sessions`.

## Shape and depth

Everything is rounded. Radii are a small fixed set, and they encode nesting
depth rather than taste:

| radius  | used for                 |
| ------- | ------------------------ |
| `20px`  | the page shell           |
| `16px`  | cards, panels, hero      |
| `10px`  | popovers and menus       |
| `8px`   | buttons, toggles, inputs |
| `6px`   | menu items, small chips  |
| `999px` | pills and badges         |

Depth comes from the ground stepping lighter (dark) or whiter (light) plus one
hairline `--line` border. Glow is reserved: only the dark theme has it, only on
the accent, and only as the hero's `0 0 60px accent/.32`.

## Motion

The report's vocabulary, and the ceiling for the site: `.15s`–`.18s ease-out` on
color, border, and background. Nothing bounces.

The site adds scroll-driven reveal along the spine, which the report has no need
for. Two hard rules, inherited from the ideation build's scars:

- Scroll handlers may not read layout. Cache geometry on load and resize; run off
  `scrollY` alone. One `getBoundingClientRect()` per frame under a sticky
  `backdrop-filter` header is a dropped frame.
- `prefers-reduced-motion: reduce` kills every animation and transition, and
  content is visible by default without JavaScript.

## Honesty rules

These are not stylistic. The product enforces them in its own output and the
site inherits them:

- **Cost is an estimate.** Never render a dollar figure without the word
  "estimated" reachable — the report puts it in a hover glossary; the site must
  put it in view.
- **Demonstration data is labeled synthetic.** Every number in the site's report
  and wrapped specimens is invented. Say so, in the panel, not in a footnote.
- **Generated content is stamped.** The product stamps roast slides "improvised
  by \<tool\>" so a model's line can never pass for a counted one. Any place the
  site depicts one, the stamp comes with it.
- **No fabricated proof.** No user counts, no downloads, no testimonials, no
  logos. They do not exist yet, and inventing them would violate the one thing
  the product is careful about.

## Build rules

- **Static, self-contained, zero external requests.** Fonts self-hosted, CSS
  inlined, charts as inline SVG, no analytics, no CDN. The CSP in
  `public/_headers` is essentially `self`, and it stays that way.
- **Facts are derived from source at build time and fail the build on drift.**
  Version from `package.json`, MCP tool names from `src/mcp.ts`, skills from
  `plugin/skills/*/SKILL.md`, help text from `src/cli.ts`. Editorial judgement —
  ordering, the one-line "what it's for" — is authored in `site/src/data/` and
  joined against the derived set. An authored entry naming a tool that no longer
  ships must throw, not render.
- Tailwind's default palette is cleared (`--color-*: initial`) so `bg-blue-500`
  is unreachable. The only colors that exist are this system's.
