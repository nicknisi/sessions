# Changelog

## [1.9.0](https://github.com/nicknisi/sessions/compare/v1.8.0...v1.9.0) (2026-06-25)


### Features

* **context:** repo-scoped context primer via MCP tool, CLI, and skill ([#19](https://github.com/nicknisi/sessions/issues/19)) ([1a2e69b](https://github.com/nicknisi/sessions/commit/1a2e69b468e6ca8c2b4e1f4d2a1547bfd1272e85))
* **report:** accurate LiteLLM-based cost pricing (matches ccusage within ~1%) ([#21](https://github.com/nicknisi/sessions/issues/21)) ([a2f156b](https://github.com/nicknisi/sessions/commit/a2f156bc2d07731953aaf9b053f6ea1fc8a55491))

## [1.8.0](https://github.com/nicknisi/sessions/compare/v1.7.0...v1.8.0) (2026-06-11)


### Features

* **report:** open HTML dashboard from a temp dir by default ([#17](https://github.com/nicknisi/sessions/issues/17)) ([ac658ca](https://github.com/nicknisi/sessions/commit/ac658ca0d830bde42e5443ea80c1bca740ef5159))

## [1.7.0](https://github.com/nicknisi/sessions/compare/v1.6.0...v1.7.0) (2026-06-10)


### Features

* add --here flag to scope `sessions report` to the current project ([#14](https://github.com/nicknisi/sessions/issues/14)) ([e337552](https://github.com/nicknisi/sessions/commit/e3375526d5c4dce8970cbfc0cda78fb9ee13ad8b))
* **report:** redesign HTML dashboard with themes and accent switcher ([#16](https://github.com/nicknisi/sessions/issues/16)) ([eb9b098](https://github.com/nicknisi/sessions/commit/eb9b0982d3409fda3ed14c1a01c5fe60ce4cd824))

## [1.6.0](https://github.com/nicknisi/sessions/compare/v1.5.1...v1.6.0) (2026-06-08)


### Features

* add `sessions report` (usage report — JSON + HTML dashboard) ([#12](https://github.com/nicknisi/sessions/issues/12)) ([f6ecb58](https://github.com/nicknisi/sessions/commit/f6ecb5859948b0cf8aef1570e73a8f6a77662c73))

## [1.5.1](https://github.com/nicknisi/sessions/compare/v1.5.0...v1.5.1) (2026-05-15)


### Bug Fixes

* embed plugin files in compiled binary ([#10](https://github.com/nicknisi/sessions/issues/10)) ([29907eb](https://github.com/nicknisi/sessions/commit/29907eb46f4492ba57da17882b2e9b16079d03d2))

## [1.5.0](https://github.com/nicknisi/sessions/compare/v1.4.0...v1.5.0) (2026-05-15)


### Features

* compact activity digest and session metrics ([#7](https://github.com/nicknisi/sessions/issues/7)) ([e5de75d](https://github.com/nicknisi/sessions/commit/e5de75dddc111caffe5a6614d11a9caedff2cba4))
* plugin with skills and `sessions setup` command ([#9](https://github.com/nicknisi/sessions/issues/9)) ([065c249](https://github.com/nicknisi/sessions/commit/065c2496d561da655e7c61ce550cd0f104f259a4))

## [1.4.0](https://github.com/nicknisi/sessions/compare/v1.3.0...v1.4.0) (2026-05-15)


### Features

* add custom titles, message counts, and subagent indexing ([#4](https://github.com/nicknisi/sessions/issues/4)) ([a499950](https://github.com/nicknisi/sessions/commit/a499950dff9c9bdae7d3ed1cb84c65b90745b1da))
* add get_activity_digest MCP tool ([#6](https://github.com/nicknisi/sessions/issues/6)) ([9a4982e](https://github.com/nicknisi/sessions/commit/9a4982e6df847d60b8cec84dc9d3116f009cb254))

## [1.3.0](https://github.com/nicknisi/sessions/compare/v1.2.0...v1.3.0) (2026-05-12)


### Features

* add MCP server with SQLite-indexed search ([f0163cf](https://github.com/nicknisi/sessions/commit/f0163cf7ecbcf5919e936352bf265fe2c75dcc9a))

## [1.2.0](https://github.com/nicknisi/sessions/compare/v1.1.0...v1.2.0) (2026-05-09)


### Features

* add oxlint and oxfmt for linting and formatting ([ca3d96b](https://github.com/nicknisi/sessions/commit/ca3d96b7f08c82becc0e9482a4cb15878a6b5ba7))


### Bug Fixes

* lowercase search query for case-insensitive matching ([144a31c](https://github.com/nicknisi/sessions/commit/144a31c1b30868815937d9846033a42a2ef8c669))

## [1.1.0](https://github.com/nicknisi/sessions/compare/v1.0.0...v1.1.0) (2026-05-09)


### Features

* rewrite sessions CLI in Bun TypeScript ([c069eb2](https://github.com/nicknisi/sessions/commit/c069eb26d351053c71edd581d3c621d41fbf17f2))
