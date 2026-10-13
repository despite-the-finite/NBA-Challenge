#!/usr/bin/env sh
# The edge function needs its own copy of the scoring engine (Supabase only bundles
# files under supabase/functions). This keeps the two copies identical.
set -e
cd "$(dirname "$0")/.."
if ! cmp -s js/scoring.js supabase/functions/_shared/scoring.js; then
  echo "scoring.js copies differ; syncing js/scoring.js -> supabase/functions/_shared/scoring.js"
  cp js/scoring.js supabase/functions/_shared/scoring.js
fi
echo "ok: scoring engine in sync"
