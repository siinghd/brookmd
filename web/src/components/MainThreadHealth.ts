/**
 * Main-thread blocking + FPS monitor.
 *
 * - `blockedMs`: cumulative ms by which our 32ms interval ticks ran late.
 *   This is a proxy for total main-thread blocking from long tasks like
 *   markdown re-parsing, syntax highlighting, etc.
 * - `fps`: instantaneous frames-per-second from requestAnimationFrame.
 *
 * Both are sampled into a circular buffer so the UI can show recent windows.
 */

const INTERVAL_MS = 32;
const WINDOW = 60; // ~2 seconds of samples

class HealthMonitorImpl {
  blockedMs = 0;
  totalSamples = 0;
  fps = 60;

  blockedHistory: number[] = new Array(WINDOW).fill(0);
  fpsHistory: number[] = new Array(WINDOW).fill(60);
  private cursor = 0;

  private lastTick = performance.now();
  private rafCount = 0;
  private rafFpsTimer = performance.now();

  private listeners = new Set<() => void>();

  constructor() {
    setInterval(this.tickInterval, INTERVAL_MS);
    requestAnimationFrame(this.tickRaf);
  }

  reset() {
    this.blockedMs = 0;
    this.totalSamples = 0;
    this.blockedHistory.fill(0);
    this.fpsHistory.fill(60);
    this.cursor = 0;
    this.emit();
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this;

  private tickInterval = () => {
    const now = performance.now();
    const expected = this.lastTick + INTERVAL_MS;
    const overshoot = Math.max(0, now - expected);
    this.lastTick = now;
    this.blockedMs += overshoot;
    this.totalSamples += 1;
    this.blockedHistory[this.cursor] = overshoot;
    this.fpsHistory[this.cursor] = this.fps;
    this.cursor = (this.cursor + 1) % WINDOW;
    this.emit();
  };

  private tickRaf = (now: number) => {
    this.rafCount += 1;
    const elapsed = now - this.rafFpsTimer;
    if (elapsed >= 500) {
      this.fps = Math.round((this.rafCount * 1000) / elapsed);
      this.rafFpsTimer = now;
      this.rafCount = 0;
    }
    requestAnimationFrame(this.tickRaf);
  };

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

export const HealthMonitor = new HealthMonitorImpl();
export type HealthSnapshot = typeof HealthMonitor;
