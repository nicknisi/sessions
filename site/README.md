# sessions.engineering

The public site. Two pages, one deploy:

| Route        | Source                        | What it is                                                              |
| ------------ | ----------------------------- | ----------------------------------------------------------------------- |
| `/`          | `src/pages/index.astro`       | The overview: MCP, the report, and wrapped, plus install and constraints. |
| `/reference` | `src/pages/reference.astro`   | Every flag, MCP tool, and skill — generated from the repo.               |
| `/404`       | `src/pages/404.astro`         | Served by Cloudflare for unknown paths.                                  |

## Local

```sh
bun install
bun run fonts     # vendor the 5 woff2 faces out of @fontsource (already committed)
bun run dev       # http://localhost:4321
bun run build     # → dist/
bun run check     # astro check
bun run deploy:check      # validate the root wrangler.jsonc, no credentials needed
bunx wrangler dev         # serve dist/ through the Workers runtime, with _headers
```

The repo root delegates: `bun run site:dev`, `site:build`, `site:check`, and
`site:deploy` all work from one directory up.

Two environment notes that cost time once:

- `astro dev` binds **IPv6 only** by default here, and browsers that resolve
  `localhost` to `127.0.0.1` get `ERR_CONNECTION_REFUSED`. Use
  `bun run dev --host 127.0.0.1` when you need to point something at it.
- `astro check` needs TypeScript **6.x**. TypeScript 7's native compiler does not
  expose the programmatic API the language server uses, so the devDependency is
  pinned to `^6` on purpose. Do not bump it to 7 until
  [withastro/roadmap#1321](https://github.com/withastro/roadmap/discussions/1321)
  lands.

## Deploying

Config is in the repo-root `wrangler.jsonc` rather than dashboard state, so it is reviewable and
can be validated locally. It lives at the root, not here, because Cloudflare Workers Builds
runs its deploy command from the repository root — a config in `site/` is invisible to it.
There is no `main` worker script — this is a static
assets deploy, and Astro needs no Cloudflare adapter for it.

```sh
bun run deploy    # astro build && wrangler deploy
```

`not_found_handling: "404-page"` serves `dist/404.html` for unknown paths.
`public/_headers` is copied to the output root and applies a CSP plus the usual
hardening; both Pages and Workers static assets honour it.

Verified through the Workers runtime rather than assumed: `/` and `/reference/`
return 200, `/nope` returns 404 and renders the custom page, all five headers
arrive, fonts are served immutable, and the CSP does not break the inline styles
and scripts every page here depends on.

## Why the build is also a test

The site does not restate the product's behaviour from memory. It reads:

- **`package.json`** for the released version in the header badge.
- **`src/mcp.ts`** for the MCP tool names and titles, out of the
  `server.registerTool(...)` calls themselves.
- **`plugin/skills/*/SKILL.md`** frontmatter for every skill name, argument hint,
  and the trigger phrases quoted on the page — those are pulled out of each
  skill's own description, so they are literally the text an agent matches
  against.
- **`src/cli.ts`** for the help text on `/reference`, lifted out of the `usage()`
  template literal. The page prints what the binary prints.

Only editorial judgement is authored, in `src/data/`: the grouping, the ordering,
and the one-line human summary of each tool and skill. The model-facing
descriptions in `mcp.ts` run to several hundred words of "call this proactively
when…", which is the right register for an agent and the wrong one for a person
skimming.

The join throws rather than rendering something false:

- an entry naming a tool `src/mcp.ts` no longer registers fails the build
- a tool that ships with no entry in `src/data/mcp.ts` fails the build
- the same two rules for skills, against `plugin/skills/`
- a skill whose frontmatter `name` disagrees with its directory fails the build,
  because the directory is what the slash command actually is
- a `usage()` that moves out of `src/cli.ts` fails the build

All of that matters because both pages state counts in prose — "eight tools",
"six skills". A silent omission would not look broken; it would look correct and
be wrong. CI should run `bun run site:build` for exactly this reason.

## Design

The site wears the **product's own visual world**, not a new one. It already
existed in `src/report/html.ts` and `src/wrapped/html.ts`, the two HTML artifacts
the CLI writes, and `DESIGN.md` at the repo root documents it. When this site and
the report disagree, the report is right and the site is wrong.

The mechanism worth knowing before editing `src/styles/sessions.css`: **each
accent is stored as a hue and a chroma and nothing else.** Every other colour is
computed from that pair in OKLCH, reproducing `palette()` in the report exactly:

```
dark   accent = oklch(82% c h)
light  accent = oklch(48% (c*0.92) h)
```

So the accent picker sets two custom properties and about fourteen derived
colours follow, including the five-step heatmap ramp. Add a hardcoded colour and
you have created the drift this arrangement exists to prevent.

Three other things that will bite:

- **Tailwind's default palette is cleared** (`--color-*: initial`). `bg-blue-500`
  does not exist. The only colours are the system's own.
- **The accent is user-switchable, so nothing may encode meaning in colour
  alone.** The spine's session ticks and pillar marks differ in shape and size as
  well as colour, on purpose.
- **The wrapped card strip stays dark in light mode.** That is not a bug — the
  real wrapped deck has no light theme, and rendering the specimen light would
  misrepresent the artifact.

Fonts are self-hosted in `public/fonts/` (latin subset, 5 faces, ~81 KB) and
committed, so a build needs no `@fontsource` install. The site makes **zero**
external requests; the report reaches Google Fonts for the same two faces, and
the site deliberately does not.

`sessions --help` output, the spine's session rows, the report specimen's charts,
and the wrapped cards all carry invented data. Every one of them says so on the
page. Cost figures are labelled estimates because the product treats them that
way, and it would be strange for the marketing page to be less careful than the
tool.
