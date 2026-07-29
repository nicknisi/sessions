// Where sessions keeps durable, non-cache state on disk.
//
// This is deliberately a neutral module rather than part of src/shards/store.ts:
// the installer (src/setup.ts) and the shard store both own things inside the data
// dir, and having the installer import a path from a feature module inverts the
// dependency and drags bun:sqlite into the setup/uninstall path. Path resolution
// living beside its consumers is the same shape as getCacheDir/getDbPath in
// src/cache.ts — this file is that, for the durable directory.

import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The durable data directory. Honors SESSIONS_DATA_DIR and is resolved lazily —
 * never frozen at import — for the same reason as src/cache.ts:41-45: the module
 * instance is shared across a `bun test` run, so a test that mutates the env on an
 * already-imported module must still be honored.
 */
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(homedir(), '.local', 'share', 'sessions');
}

/** The shard store. Deliberately outside the cache dir — see src/shards/store.ts. */
export function getShardsDbPath(): string {
  return join(getDataDir(), 'shards.db');
}
