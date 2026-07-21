/**
 * brookmd-react-native app-level e2e fixture.
 *
 * On mount this app exercises the package TWO ways against a real device build:
 *
 *   1. The NATIVE parser directly. `makeNativeParser` (from the package's
 *      native-session module) creates an on-device `BrookSession` over JSI/uniffi,
 *      streams the wire-golden CHUNKS through it, and asserts every patch equals
 *      the byte-identical golden captured from the Rust core (golden.ts). This
 *      proves the compiled Rust library loaded and produces the exact wire.
 *
 *   2. The RENDERER. `<BrookMarkdown>` drives the SAME native parser through the
 *      package's in-process pool (WorkerCore) and renders RN primitives.
 *
 * Result transport is an HTTP beacon to a host-side CI listener (deterministic;
 * os_log/logcat proved unreliable), plus console.log markers as a secondary/local
 * channel. Success => BROOK_E2E_OK, any mismatch/exception => BROOK_E2E_FAIL:<detail>.
 *
 * ROBUSTNESS: this file's only STATIC imports are react / react-native / golden, so
 * the component always mounts and the effect always runs. The package (and the
 * native module it touches) is loaded with dynamic import() INSIDE the effect's
 * try/catch, so ANY load/init failure still beacons BROOK_E2E_FAIL rather than
 * silently killing the app before it can report.
 */
import { useEffect, useState, type ComponentType } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { ParserConfig } from 'brookmd/types';
import { CHUNKS, EXPECTED } from './golden';

// Every setter at StreamParser's library default (autolinks/alerts OFF, block
// data OFF) — reproducing the exact parser the OFF_* goldens were captured
// against, so the native output is byte-identical to golden.ts.
const NATIVE_OFF_CONFIG: ParserConfig = {
  gfmAutolinks: false,
  gfmAlerts: false,
  gfmTagfilter: false,
  gfmFootnotes: false,
  gfmMath: false,
  dirAuto: false,
  a11y: false,
  unsafeHtml: false,
  blockData: false,
};

type CheckResult = { ok: true } | { ok: false; detail: string };
type NativeParser = { append(chunk: string): string; finalize(): string; free(): void };
type MakeParser = (config: ParserConfig | undefined) => NativeParser;

/** Stream the goldens through a fresh native session and compare every patch. */
function runNativeWireCheck(makeNativeParser: MakeParser): CheckResult {
  const parser = makeNativeParser(NATIVE_OFF_CONFIG);
  try {
    const got: string[] = [];
    for (const chunk of CHUNKS) got.push(parser.append(chunk));
    got.push(parser.finalize());
    for (let i = 0; i < EXPECTED.length; i++) {
      if (got[i] !== EXPECTED[i]) {
        return {
          ok: false,
          detail: `native patch[${i}] drifted\n  got:  ${got[i]}\n  want: ${EXPECTED[i]}`,
        };
      }
    }
    return { ok: true };
  } finally {
    parser.free();
  }
}

const DOC = CHUNKS.join('');

// Deterministic result channel for CI: an HTTP beacon to a listener on the host.
// os_log/logcat capture proved flaky, so the beacon is the PRIMARY signal (the
// console.log markers stay as a secondary/local-dev channel). Android emulator ->
// host via the 10.0.2.2 loopback alias; the iOS simulator shares the host network
// (127.0.0.1). Fire-and-forget: a beacon failure must never crash the app.
const BEACON_HOST = Platform.OS === 'android' ? '10.0.2.2' : '127.0.0.1';
const BEACON_URL = `http://${BEACON_HOST}:8973`;

function sendBeacon(path: string): void {
  fetch(`${BEACON_URL}/${path}`).catch((e) => {
    // eslint-disable-next-line no-console
    console.log('BROOK_E2E beacon post failed: ' + String(e));
  });
}

function report(result: CheckResult): void {
  if (result.ok) {
    // eslint-disable-next-line no-console
    console.log('BROOK_E2E_OK');
    sendBeacon('BROOK_E2E_OK');
  } else {
    // eslint-disable-next-line no-console
    console.log('BROOK_E2E_FAIL: ' + result.detail);
    sendBeacon('BROOK_E2E_FAIL?d=' + encodeURIComponent(result.detail));
  }
}

function App() {
  const [status, setStatus] = useState('running…');
  const [Markdown, setMarkdown] = useState<ComponentType<{ content?: string }> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let result: CheckResult;
      try {
        // Dynamic import INSIDE the try: a load/init failure of the package or its
        // native module is caught here and still beacons FAIL (rather than throwing
        // at module load and killing the app before it can report).
        const { makeNativeParser } = await import('brookmd-react-native/src/native-session');
        result = runNativeWireCheck(makeNativeParser as MakeParser);
      } catch (e) {
        const msg = e instanceof Error ? e.stack ?? e.message : String(e);
        result = { ok: false, detail: 'native load/init failed: ' + msg };
      }
      if (cancelled) return;
      setStatus(result.ok ? 'OK' : 'FAIL');
      report(result);

      // The renderer is a best-effort visual only; its failure must NOT change the
      // already-reported native-path result, so it never beacons.
      try {
        const mod = await import('brookmd-react-native');
        if (!cancelled) setMarkdown(() => mod.BrookMarkdown as ComponentType<{ content?: string }>);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.log('BROOK_E2E renderer load failed (non-fatal): ' + String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <View style={styles.root}>
      <Text testID="status" style={styles.status}>
        brook e2e: {status}
      </Text>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        {Markdown ? <Markdown content={DOC} /> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 16, paddingTop: 48 },
  status: { fontSize: 20, fontWeight: '700', marginBottom: 16 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
});

export default App;
