import { describe, test, expect } from 'bun:test';
import {
  significanceScore,
  isTrivia,
  blendedScore,
  hasArtifact,
  ARTIFACT_BONUS,
  type ScorableSession,
} from './significance';

const base: ScorableSession = { messageCount: 5, filesTouchedCount: 0, closingText: '', createdAt: '2026-06-23' };

describe('trivia', () => {
  test('a 1-message, no-files, no-artifact session is trivia', () => {
    expect(isTrivia({ ...base, messageCount: 1 })).toBe(true);
  });
  test('not trivia when messages > 2, or files > 0, or an artifact is present', () => {
    expect(isTrivia({ ...base, messageCount: 5 })).toBe(false);
    expect(isTrivia({ ...base, messageCount: 1, filesTouchedCount: 2 })).toBe(false);
    expect(isTrivia({ ...base, messageCount: 1, closingText: 'PR is up: x/pull/16' })).toBe(false);
  });
});

describe('score', () => {
  test('substantive outranks trivial', () => {
    const trivial = { ...base, messageCount: 1 };
    const substantive = { ...base, messageCount: 80, filesTouchedCount: 8 };
    expect(significanceScore(substantive)).toBeGreaterThan(significanceScore(trivial));
  });
  test('artifact bonus applies to a concrete PR URL or backticked SHA, not to intent', () => {
    const noArtifact = significanceScore(base);
    expect(significanceScore({ ...base, closingText: 'PR is up: https://github.com/x/y/pull/16' })).toBeCloseTo(
      noArtifact + ARTIFACT_BONUS,
    );
    expect(significanceScore({ ...base, closingText: 'shipped in `0f459d3`' })).toBeCloseTo(noArtifact + ARTIFACT_BONUS);
    expect(significanceScore({ ...base, closingText: "I'll open a PR next" })).toBeCloseTo(noArtifact);
    expect(hasArtifact("I'll open a PR next")).toBe(false);
  });
});

describe('blended', () => {
  test('a recent moderate session outranks an older bigger one at the default half-life', () => {
    const now = Date.parse('2026-06-23');
    const recentModerate = { ...base, messageCount: 20, filesTouchedCount: 3, createdAt: '2026-06-22' };
    const olderBigger = { ...base, messageCount: 80, filesTouchedCount: 8, createdAt: '2026-06-10' };
    expect(blendedScore(recentModerate, now)).toBeGreaterThan(blendedScore(olderBigger, now));
  });
  test('an undated session sinks instead of producing NaN or floating to the top', () => {
    const now = Date.parse('2026-06-23');
    const score = blendedScore({ ...base, messageCount: 50, filesTouchedCount: 5, createdAt: '?' }, now);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThan(0.01);
  });
});
