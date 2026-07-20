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
 *      package's in-process pool (WorkerCore) and renders RN primitives — proving
 *      the full JS<->native integration mounts and renders on device.
 *
 * On success it logs `BROOK_E2E_OK`; on any mismatch/exception `BROOK_E2E_FAIL:
 * <detail>`. CI polls the device log for these markers.
 */
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

// The renderer + public client surface. Importing the package entry also wires
// the native parser factory into the shared pool (registerNativeParser).
import { BrookMarkdown } from 'brookmd-react-native';
// The on-device native parser factory (the module the package entry itself uses
// to back the pool). Reaching it directly lets us read the RAW wire strings and
// compare them to the goldens byte-for-byte.
import { makeNativeParser } from 'brookmd-react-native/src/native-session';
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

/** Stream the goldens through a fresh native session and compare every patch. */
function runNativeWireCheck(): CheckResult {
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

function App() {
  const [status, setStatus] = useState('running…');

  useEffect(() => {
    let result: CheckResult;
    try {
      result = runNativeWireCheck();
    } catch (e) {
      const msg = e instanceof Error ? e.stack ?? e.message : String(e);
      result = { ok: false, detail: `native check threw: ${msg}` };
    }
    if (result.ok) {
      setStatus('OK');
      // eslint-disable-next-line no-console
      console.log('BROOK_E2E_OK');
    } else {
      setStatus('FAIL');
      // eslint-disable-next-line no-console
      console.log('BROOK_E2E_FAIL: ' + result.detail);
    }
  }, []);

  return (
    <View style={styles.root}>
      <Text testID="status" style={styles.status}>
        brook e2e: {status}
      </Text>
      {/* Renderer path: drives the same native parser through the pool. */}
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <BrookMarkdown content={DOC} />
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
