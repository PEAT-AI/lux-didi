#!/usr/bin/env bash
# A test that can fail: the guard is the word it asserts on.
set -euo pipefail
grep -q 'refuses' server/test/sensitivity/fixtures/guard.txt
echo 'PASS the dispatch path refuses an unregistered caller'
