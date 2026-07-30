import { describe, test, expect } from 'bun:test';
import { renderMarkdown } from '../context';
import type { ContextPrimer, PrimerMemory } from '../types';

// The primer's memory tier — the only GUARANTEED delivery of an approved memory.
//
// `get_memory` is topic-conditional and an agent has to choose to call it. That is the
// same "only fires when the model decides to" dependency that left the previous lesson
// store at one row for months, and it was observably live: a store with 9 approved
// memories put none of them in the primer, because the primer had no memory tier at all.

function primer(memory: PrimerMemory[], memoryTotal = memory.length): ContextPrimer {
  return { repoLabel: 'app', toolFilter: '', recent: [], headlines: [], memory, memoryTotal, isEmpty: false };
}

const fact = (text: string, over: Partial<PrimerMemory> = {}): PrimerMemory => ({
  text,
  kind: 'instruction',
  scope: 'repo',
  alwaysOn: false,
  ...over,
});

describe('the primer carries approved memory unconditionally', () => {
  test('memory comes before what merely happened, so a truncated read still sees it', () => {
    const md = renderMarkdown(primer([fact('Use bun, never npm.')]), false);
    expect(md.indexOf('## Memory')).toBeGreaterThan(-1);
    expect(md.indexOf('## Memory')).toBeLessThan(md.indexOf('## Recent'));
  });

  test('a standing constraint is marked, because it is read differently from a fact', () => {
    const md = renderMarkdown(primer([fact('Never force-push to main.', { alwaysOn: true })]), false);
    expect(md).toContain('Never force-push to main. _(standing)_');
  });

  test('a repo-scoped fact carries no scope noise; a wider one says so', () => {
    const md = renderMarkdown(primer([fact('Repo thing.'), fact('Workflow thing.', { scope: 'workflow' })]), false);
    expect(md).toContain('- Repo thing.\n');
    expect(md).toContain('Workflow thing. _(workflow)_');
  });

  test('a capped list says what it left out instead of reading as the whole set', () => {
    const md = renderMarkdown(primer([fact('One.'), fact('Two.')], 40), false);
    expect(md).toContain('+38 more');
    expect(md).toContain('get_memory');
  });

  test('an exact list adds no overflow line', () => {
    expect(renderMarkdown(primer([fact('Only one.')]), false)).not.toContain('more —');
  });

  test('no memory means no section at all, not an empty heading', () => {
    expect(renderMarkdown(primer([]), false)).not.toContain('## Memory');
  });
});
