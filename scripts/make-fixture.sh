#!/usr/bin/env bash
# Generate a known-good 16 kHz mono PCM16 WAV for the T1 smoke test.
#
# Uses macOS built-ins only (say, afconvert) so T1 needs no new dependency and
# no recording session. This proves the PLUMBING — key, region, tier, format,
# response shape. It is not a test of scoring quality: synthetic speech is not
# accented learner speech, and the fixture in PRD.md §8 must be real speakers.
set -euo pipefail

PHRASE="${1:-Would you like something to drink}"
OUT="${2:-fixtures/sample.wav}"

if ! command -v say >/dev/null || ! command -v afconvert >/dev/null; then
  echo "Needs macOS 'say' and 'afconvert'. On another platform, supply your own" >&2
  echo "16 kHz mono PCM16 WAV and pass its path to scripts/smoke-azure.mjs." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -t fixture).aiff"
trap 'rm -f "$TMP"' EXIT

say "$PHRASE" -o "$TMP"
# LEI16@16000 = little-endian signed 16-bit at 16 kHz; -c 1 = mono. R7.
afconvert -f WAVE -d LEI16@16000 -c 1 "$TMP" "$OUT"

echo "wrote $OUT"
echo "phrase: \"$PHRASE\""
