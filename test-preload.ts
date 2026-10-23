// Hermetic test environment. A developer's shell may export SESSIONS_EMBED_*, and
// with a provider set every suite that reaches the semantic lane would try the
// network. Delete them here, before any test file loads, so `bun test` never
// contacts a remote endpoint by accident; suites that exercise a provider set the
// variables inside their own bodies.
for (const key of [
  'SESSIONS_EMBED_PROVIDER',
  'SESSIONS_EMBED_URL',
  'SESSIONS_EMBED_MODEL',
  'SESSIONS_EMBED_API_KEY',
  'SESSIONS_EMBED_THRESHOLD',
]) {
  delete process.env[key];
}
