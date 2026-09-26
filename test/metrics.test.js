import { test } from "node:test";
import assert from "node:assert/strict";
import {
  currentPace, metForPace, nextStreak, fmtTime, fmtDuration,
  dayKey, dayStreak, weekTotals, readJSON, writeJSON,
} from "../metrics.js";

test("pace counts jumps in the trailing 10 s, per minute", () => {
  assert.equal(currentPace([], 5000), 0);
  const times = [0, 1000, 5000, 9000, 14_000, 15_000];
  // at t=15s the window is [5s, 15s]: 4 jumps → 24/min
  assert.equal(currentPace(times, 15_000), 24);
  assert.equal(currentPace(times, 60_000), 0);
});

test("MET value steps up with cadence", () => {
  assert.equal(metForPace(0), 0);
  assert.equal(metForPace(60), 8.8);
  assert.equal(metForPace(100), 11.8);
  assert.equal(metForPace(120), 11.8);
  assert.equal(metForPace(121), 12.3);
});

test("streak grows while gaps stay within 2.5 s, restarts after", () => {
  assert.equal(nextStreak(0, undefined, 1000), 1);
  assert.equal(nextStreak(4, 1000, 3500), 5);
  assert.equal(nextStreak(4, 1000, 3501), 1);
});

test("streak survives a run whose first jumps were credited late", () => {
  // The detector holds a new run's first jumps until the third confirms,
  // then emits them all at once. Replaying that: a 2.2 s pause, then three
  // jumps delivered only after the pause already exceeded 2.5 s of wall time.
  const times = [0, 400, 800, 3000, 3400, 3800];
  let cur = 0, best = 0, prev;
  for (const t of times) {
    cur = nextStreak(cur, prev, t);
    best = Math.max(best, cur);
    prev = t;
  }
  assert.equal(best, 6);
});

test("clock formatting floors to whole seconds", () => {
  assert.equal(fmtTime(0), "0:00");
  assert.equal(fmtTime(59_999), "0:59");
  assert.equal(fmtTime(61_000), "1:01");
  assert.equal(fmtTime(3_600_000), "60:00");
});

test("share-card duration never shows 60 seconds", () => {
  assert.equal(fmtDuration(45_000), "45秒");
  assert.equal(fmtDuration(59_600), "59秒");
  assert.equal(fmtDuration(119_700), "1分 59秒");
  assert.equal(fmtDuration(120_000), "2分 0秒");
  // matches the summary clock
  assert.equal(fmtDuration(125_900), "2分 5秒");
  assert.equal(fmtTime(125_900), "2:05");
});

const at = (y, m, d, h = 12) => ({ date: new Date(y, m - 1, d, h).toISOString() });

test("day key is the local calendar date", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});

test("day streak counts consecutive days back from today", () => {
  const today = new Date(2026, 2, 10, 18);
  assert.equal(dayStreak([], today), 0);
  const s = [at(2026, 3, 10), at(2026, 3, 9), at(2026, 3, 9, 7), at(2026, 3, 8), at(2026, 3, 6)];
  assert.equal(dayStreak(s, today), 3);
});

test("day streak isn't broken by not having jumped yet today", () => {
  const today = new Date(2026, 2, 10, 8);
  assert.equal(dayStreak([at(2026, 3, 9), at(2026, 3, 8)], today), 2);
  assert.equal(dayStreak([at(2026, 3, 8)], today), 0);
});

test("day streak crosses month boundaries", () => {
  const today = new Date(2026, 2, 1, 9);
  assert.equal(dayStreak([at(2026, 3, 1), at(2026, 2, 28), at(2026, 2, 27)], today), 3);
});

test("week totals split sessions into this week and the one before", () => {
  const now = new Date(2026, 2, 15, 12).getTime();
  const day = 86_400_000;
  const s = (ago, jumps) => ({
    date: new Date(now - ago * day).toISOString(), jumps, seconds: 60, kcal: 10,
  });
  const { thisWk, lastWk } = weekTotals([s(0, 100), s(6.9, 50), s(7.1, 30), s(13, 20), s(15, 999)], now);
  assert.deepEqual(thisWk, { jumps: 150, sec: 120, kcal: 20 });
  assert.deepEqual(lastWk, { jumps: 50, sec: 120, kcal: 20 });
});

test("storage helpers survive corrupt, missing, and blocked storage", (t) => {
  const store = new Map();
  const fake = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  const orig = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  t.after(() => {
    if (orig) Object.defineProperty(globalThis, "localStorage", orig);
    else delete globalThis.localStorage;
  });
  Object.defineProperty(globalThis, "localStorage", { value: fake, configurable: true });

  assert.deepEqual(readJSON("k", []), []);
  assert.equal(writeJSON("k", [{ jumps: 3 }]), true);
  assert.deepEqual(readJSON("k", []), [{ jumps: 3 }]);
  store.set("k", "{not json");
  assert.deepEqual(readJSON("k", { a: 1 }), { a: 1 });

  // Safari with site data blocked: touching localStorage throws
  Object.defineProperty(globalThis, "localStorage", {
    get() { throw new DOMException("denied", "SecurityError"); },
    configurable: true,
  });
  assert.deepEqual(readJSON("k", []), []);
  assert.equal(writeJSON("k", []), false);
});
