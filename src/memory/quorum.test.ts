import { describe, test, expect } from 'bun:test';
import { meetsQuorum, quorum } from './quorum';
import type { MergedMemory } from './portable';

// The one distinction the metric exists to make: authors, not occurrences.
//
// Counting occurrences is what made raw volume unusable — one eval fixture prompt
// appeared 14 times byte-identical in the real corpus. These tests are built so the
// "obvious" implementation (`return memory.totalPhrasings`) fails loudly: every fixture
// below sets `totalPhrasings` to a value that disagrees with the author count.
//
// Nothing here touches a database or a clock. `quorum.ts` imports only a type, so this
// file needs no fixture harness at all.

function merged(authors: string[], totalPhrasings: number): MergedMemory {
  return {
    id: 'sha256:' + 'a'.repeat(64),
    text: 'Always run the full test suite before you tell me a change is finished',
    kind: 'instruction',
    scope: { type: 'workflow', key: '' },
    authors,
    totalPhrasings,
    firstSeen: '2026-01-01',
    lastSeen: '2026-02-01',
  };
}

describe('quorum', () => {
  test('counts distinct authors, not occurrences', () => {
    // The spec's experiment: identical totalPhrasings, different author counts.
    const verbose = merged(['ann@example.com'], 5);
    const agreed = merged(['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com'], 5);
    expect(quorum(verbose)).toBe(1);
    expect(quorum(agreed)).toBe(5);
  });

  test('a verbose individual cannot manufacture a quorum', () => {
    expect(quorum(merged(['ann@example.com'], 14))).toBe(1);
    expect(meetsQuorum(merged(['ann@example.com'], 14), 2)).toBe(false);
  });

  test('is 1 under the current single-author scope, which is expected', () => {
    // Constant until a second author's export is imported — the reason the metric
    // ships with the merge rather than earlier.
    expect(quorum(merged(['dev@example.com'], 1))).toBe(1);
  });

  test('is 0 for a memory with no contributors rather than throwing', () => {
    expect(quorum(merged([], 7))).toBe(0);
  });
});

describe('meetsQuorum', () => {
  const three = merged(['a@x.com', 'b@x.com', 'c@x.com'], 99);

  test('clears the bar at exactly the threshold', () => {
    expect(meetsQuorum(three, 3)).toBe(true);
    expect(meetsQuorum(three, 4)).toBe(false);
    expect(meetsQuorum(three, 2)).toBe(true);
  });

  test('ignores totalPhrasings entirely', () => {
    // 99 phrasings from one author still fails a threshold of 2.
    expect(meetsQuorum(merged(['ann@example.com'], 99), 2)).toBe(false);
    // 2 authors with 2 phrasings between them clears it.
    expect(meetsQuorum(merged(['ann@example.com', 'bob@example.com'], 2), 2)).toBe(true);
  });

  test('a threshold of 0 or 1 admits everything, the degenerate single-author case', () => {
    expect(meetsQuorum(merged(['ann@example.com'], 1), 1)).toBe(true);
    expect(meetsQuorum(merged([], 0), 0)).toBe(true);
  });
});
