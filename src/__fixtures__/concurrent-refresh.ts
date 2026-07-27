/**
 * One process that brings the index up to date, for the cross-process marker test in
 * cache.refresh.test.ts.
 *
 * The marker only means anything between separate processes: within one, `_lastRefreshAt`
 * already suppresses the redundant walk, so a simulated second "process" would prove
 * nothing. Two copies of this, run one after the other against one cache dir, are the
 * only way to see the marker do its job.
 *
 * Reads SESSIONS_CACHE_DIR and the source-root vars from the environment (set by the
 * test) and prints how many walks it started as JSON. Goes through searchSessions rather
 * than ensureIndexFresh directly, because that is a real entry point and ensureIndexFresh
 * is private.
 */
import { refreshAttempts, searchSessions } from '../cache';

await searchSessions(process.argv[2] ?? 'anything', { limit: 1 });

process.stdout.write(JSON.stringify({ attempts: refreshAttempts() }));
