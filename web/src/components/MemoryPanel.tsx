import { useState } from "react";
import { runMemoryTest, type MemoryResult } from "./MemoryTest";

interface Props {
  setMode: (m: "flux" | "streamdown") => void;
  resetAll: () => void;
  onClose: () => void;
}

const SIZES: Array<{ label: string; kb: number; chunk: number; interval: number }> = [
  { label: "Quick (20 KB · ~10s)", kb: 20, chunk: 32, interval: 4 },
  { label: "Standard (60 KB · ~25s)", kb: 60, chunk: 16, interval: 2 },
  { label: "Heavy (200 KB · ~90s)", kb: 200, chunk: 12, interval: 1 },
];

export function MemoryPanel({ setMode, resetAll, onClose }: Props) {
  const [running, setRunning] = useState(false);
  const [sizeIdx, setSizeIdx] = useState(0);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<MemoryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setRunning(true);
    setErr(null);
    setResult(null);
    try {
      const conf = SIZES[sizeIdx];
      const r = await runMemoryTest({
        corpusKB: conf.kb,
        chunkSize: conf.chunk,
        intervalMs: conf.interval,
        setMode,
        resetAll,
        onProgress: setProgress,
      });
      setResult(r);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress("");
    }
  };

  return (
    <div className="mem-panel">
      <div className="mem-panel-head">
        <strong>Memory A/B</strong>
        <button className="lab-btn lab-btn-icon" onClick={onClose} disabled={running}>×</button>
      </div>
      <p className="mem-panel-desc">
        Pushes the exact same markdown corpus through flux and then Streamdown.
        Measures peak heap during the run and retained heap after settle (with
        forced GC when available — launch Chrome with{" "}
        <code>--js-flags=--expose-gc --enable-precise-memory-info</code> for tightest numbers).
      </p>
      <div className="mem-panel-controls">
        <select
          className="lab-select"
          value={sizeIdx}
          disabled={running}
          onChange={(e) => setSizeIdx(parseInt(e.target.value, 10))}
        >
          {SIZES.map((s, i) => (
            <option key={i} value={i}>{s.label}</option>
          ))}
        </select>
        <button className="lab-btn lab-btn-primary" disabled={running} onClick={start}>
          {running ? "Measuring…" : "Run A/B"}
        </button>
      </div>
      {progress && <div className="mem-progress">{progress}</div>}
      {err && <div className="mem-err">Error: {err}</div>}
      {result && <MemoryResultView result={result} />}
    </div>
  );
}

function MemoryResultView({ result }: { result: MemoryResult }) {
  const better = result.ratioPeak >= 1 ? "flux" : "streamdown";
  return (
    <div className="mem-result">
      <table>
        <thead>
          <tr>
            <th></th>
            <th className="hcol-flux">flux</th>
            <th className="hcol-sd">streamdown</th>
            <th>ratio</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>peak Δ</td>
            <td>{result.flux.peakDeltaMB.toFixed(2)} MB</td>
            <td>{result.streamdown.peakDeltaMB.toFixed(2)} MB</td>
            <td className={better === "flux" ? "win" : "loss"}>
              {result.ratioPeak.toFixed(2)}×
            </td>
          </tr>
          <tr>
            <td>settled Δ</td>
            <td>{result.flux.settledDeltaMB.toFixed(2)} MB</td>
            <td>{result.streamdown.settledDeltaMB.toFixed(2)} MB</td>
            <td className={result.ratioSettled > 1 ? "win" : "loss"}>
              {result.ratioSettled.toFixed(2)}×
            </td>
          </tr>
          <tr>
            <td>replay time</td>
            <td>{(result.flux.replayMs / 1000).toFixed(1)}s</td>
            <td>{(result.streamdown.replayMs / 1000).toFixed(1)}s</td>
            <td className={result.streamdown.replayMs > result.flux.replayMs ? "win" : "loss"}>
              {(result.streamdown.replayMs / Math.max(1, result.flux.replayMs)).toFixed(2)}×
            </td>
          </tr>
          <tr>
            <td>bytes pushed</td>
            <td colSpan={2} className="mem-center">
              {(result.corpusBytes / 1024).toFixed(1)} KB (identical both modes)
            </td>
            <td></td>
          </tr>
        </tbody>
      </table>
      <div className="mem-summary">
        {result.ratioPeak >= 1.5 ? (
          <span className="mem-good">
            flux uses {result.ratioPeak.toFixed(1)}× less peak memory and retains{" "}
            {result.ratioSettled.toFixed(1)}× less after settle.
          </span>
        ) : (
          <span>Results are close on this corpus — try a larger one.</span>
        )}
      </div>
    </div>
  );
}
