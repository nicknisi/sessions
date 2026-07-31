#!/usr/bin/env bash
#
# Reject commit messages release-please cannot parse.
#
# release-please (action v4) parses each commit with @conventional-commits/parser,
# whose PEG grammar treats the start of every body line as a possible footer token
# `token(scope):`. So a LINE-INITIAL token containing NESTED parens makes the first
# `(` open a scope and the parser demand `)`; the inner `(` throws
#
#     unexpected token '(' at L:C, valid tokens [)]
#
# The failure is silent. release-please logs the error, DROPS the commit, and still
# exits 0 — the run is green, `Considering: 0 commits`, and no release PR is created.
# The commit's work is then absent from the changelog permanently, because that
# message will never parse on any later run.
#
# This has cost two releases in this repo:
#   c216a1d (#50)  L165  `fingerprint(normalizeText(text))`. …
#   89f15bd (#61)  L65   summarizeMessages(extractMessages(...)).
#
# Note both are ordinary prose. Backticks do not shield the pattern, and a single
# paren group at line start is fine — only nesting breaks. Neither author chose to
# start a line that way; the paragraph simply wrapped there. That is why this is a
# check and not a guideline.
#
# Squash merges compose the body from every commit message in the PR, so one bad
# line anywhere in the branch sinks the release.
#
# Usage:
#   scripts/check-commit-messages.sh <base-ref> <head-ref>
#   scripts/check-commit-messages.sh --selftest
set -euo pipefail

# Prints offending lines as "L<line>:<col>  <text>". Exit 1 if any were found.
# RSTART+RLENGTH-1 is the position of the inner `(` — the column release-please reports.
scan() {
  awk 'match($0, /^[^ \t]*\([^)]*\(/) { printf "  L%d:%d  %s\n", NR, RSTART + RLENGTH - 1, $0; f = 1 }
       END { exit f ? 1 : 0 }'
}

selftest() {
  local failures=0

  expect_bad() {
    if printf '%s\n' "$1" | scan >/dev/null; then
      echo "selftest FAIL: should have been rejected: $1" >&2
      failures=$((failures + 1))
    fi
  }
  expect_ok() {
    if ! printf '%s\n' "$1" | scan >/dev/null; then
      echo "selftest FAIL: should have been accepted: $1" >&2
      failures=$((failures + 1))
    fi
  }

  # The two real regressions.
  expect_bad 'summarizeMessages(extractMessages(...)).'
  expect_bad '`fingerprint(normalizeText(text))`. Import is also the one unbounded path'
  # Nesting at line start, in other shapes.
  expect_bad 'foo(bar(baz))'
  expect_bad 'localHour(new Date(iso)) is the conversion'

  # A single paren group at line start parses fine.
  expect_ok 'summarizeMessages(messages) builds the columns'
  expect_ok 'getDataDir() resolves lazily'
  # Nesting is fine once anything precedes it — this is the documented fix.
  expect_ok 'It is built from summarizeMessages(extractMessages(lines)).'
  expect_ok 'Uses fingerprint(normalizeText(text)) to dedupe.'
  # Ordinary prose and conventional-commit syntax.
  expect_ok 'fix(parser): extract messages from Codex rollouts'
  expect_ok 'A sentence (with a parenthetical) that starts plainly.'
  expect_ok ''

  if [ "$failures" -ne 0 ]; then
    echo "selftest: $failures case(s) failed" >&2
    return 1
  fi
  echo "selftest: all cases pass"
}

if [ "${1:-}" = "--selftest" ]; then
  selftest
  exit 0
fi

base=${1:?usage: check-commit-messages.sh <base-ref> <head-ref>}
head=${2:?usage: check-commit-messages.sh <base-ref> <head-ref>}

bad=0
while read -r sha; do
  [ -n "$sha" ] || continue
  if ! output=$(git log -1 --format=%B "$sha" | scan); then
    echo "✗ $(git log -1 --format='%h %s' "$sha")"
    echo "$output"
    bad=$((bad + 1))
  fi
done <<EOF
$(git rev-list "$base..$head")
EOF

if [ "$bad" -ne 0 ]; then
  cat >&2 <<'MSG'

release-please would silently drop the commit(s) above and skip the release PR,
while every check stayed green.

Fix: reflow so a word precedes the token, or unnest it.

    summarizeMessages(extractMessages(...)).          <- dropped
    It is built from summarizeMessages(extractMessages(...)).   <- fine

Then amend or rebase. Squash merges concatenate every commit message in the
branch, so one bad line anywhere sinks the release.
MSG
  exit 1
fi

echo "commit messages are parseable by release-please"
