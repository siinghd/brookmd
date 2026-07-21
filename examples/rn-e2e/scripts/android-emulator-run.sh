#!/usr/bin/env bash
#
# Runs inside reactivecircus/android-emulator-runner (host side, emulator already
# booted, adb on PATH). That action executes each `script:` LINE as its OWN
# `/usr/bin/sh -c`, so shell variables (APK=…, BEACON_PID=…) set on one line are
# empty on the next. This whole flow therefore lives in one checked-in script that
# the workflow invokes with a single-line `script:`.
#
# Installs the standalone release APK, launches it, and waits for the app's HTTP
# result beacon (the app POSTs to 10.0.2.2:8973 — the emulator's alias for the
# host loopback). logcat is captured as diagnostics only.
set -euo pipefail

APK="examples/rn-e2e/android/app/build/outputs/apk/release/app-release.apk"
BEACON_LOG="/tmp/beacon.log"
LOGCAT_FULL="/tmp/logcat-full.txt"
TIMEOUT_SECS=120

[ -f "$APK" ] || { echo "APK not found: $APK"; exit 1; }

# Host-side beacon listener (the app reaches it at 10.0.2.2:8973). http.server logs
# each request line (path included) to stderr, which we poll below.
python3 -m http.server 8973 --bind 0.0.0.0 > "$BEACON_LOG" 2>&1 &
BEACON_PID=$!
trap 'kill "$BEACON_PID" 2>/dev/null || true' EXIT

adb install -r "$APK"
adb logcat -c
adb shell am start -n com.brooke2e/.MainActivity

echo "waiting up to ${TIMEOUT_SECS}s for the BROOK_E2E beacon…"
result=""
deadline=$((SECONDS + TIMEOUT_SECS))
while [ "$SECONDS" -lt "$deadline" ]; do
  if grep -q "BROOK_E2E_OK" "$BEACON_LOG" 2>/dev/null; then result=OK; break; fi
  if grep -q "BROOK_E2E_FAIL" "$BEACON_LOG" 2>/dev/null; then result=FAIL; break; fi
  sleep 2
done

adb logcat -d > "$LOGCAT_FULL" 2>/dev/null || true
echo "=== beacon.log ==="; cat "$BEACON_LOG" || true
echo "=== BROOK_E2E logcat lines (diagnostics) ==="; grep -E "BROOK_E2E" "$LOGCAT_FULL" || true

if [ "$result" = OK ]; then
  echo "PASS: native parser produced byte-identical wire and the renderer mounted."
elif [ "$result" = FAIL ]; then
  echo "FAIL: app beaconed BROOK_E2E_FAIL"
  grep "BROOK_E2E_FAIL" "$BEACON_LOG" || true
  echo "--- last 200 logcat lines ---"; tail -200 "$LOGCAT_FULL" || true
  exit 1
else
  echo "TIMEOUT: no BROOK_E2E beacon within ${TIMEOUT_SECS}s"
  echo "--- last 200 logcat lines ---"; tail -200 "$LOGCAT_FULL" || true
  exit 1
fi
