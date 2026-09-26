// Pure session / stats math used by app.js. No DOM access here, so the
// numbers the app shows can be checked by the unit tests (npm test).

// a gap longer than this between two jumps ends a streak
export const STREAK_BREAK_MS = 2500;

// jumps in the last 10s, scaled to per-minute
export function currentPace(jumpTimes, now) {
  const cutoff = now - 10_000;
  let n = 0;
  for (let i = jumpTimes.length - 1; i >= 0; i--) {
    if (jumpTimes[i] < cutoff) break;
    n++;
  }
  return n * 6;
}

export function metForPace(pace) {
  // Compendium of Physical Activities: skipping rope
  if (pace <= 0) return 0;
  if (pace < 100) return 8.8;
  if (pace <= 120) return 11.8;
  return 12.3;
}

// Streak length after a jump at `t`, given the previous jump time (or
// undefined for the first jump). Decided per jump rather than by a wall-clock
// timer, because the detector credits a run's first jumps retroactively —
// a timer would see a pause that the jumps themselves never had.
export function nextStreak(cur, prevT, t) {
  return prevT !== undefined && t - prevT <= STREAK_BREAK_MS ? cur + 1 : 1;
}

export function fmtTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// "2分 5秒" / "45秒" for the share card; floors like fmtTime so the card
// matches the summary screen and never shows "60秒"
export function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const mins = Math.floor(s / 60), secs = s % 60;
  return mins > 0 ? `${mins}分 ${secs}秒` : `${secs}秒`;
}

export const dayKey = (d) => d.toLocaleDateString("en-CA"); // local YYYY-MM-DD

// consecutive training days ending today — or yesterday, since today isn't
// counted against you until it's over
export function dayStreak(sessions, today = new Date()) {
  const trained = new Set(sessions.map((s) => dayKey(new Date(s.date))));
  let streak = 0;
  const cursor = new Date(today);
  if (!trained.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  while (trained.has(dayKey(cursor))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// rolling last 7 days vs the 7 days before that
export function weekTotals(sessions, now = Date.now()) {
  const WEEK = 7 * 86_400_000;
  const thisWk = { jumps: 0, sec: 0, kcal: 0 };
  const lastWk = { jumps: 0, sec: 0, kcal: 0 };
  for (const s of sessions) {
    const age = now - new Date(s.date).getTime();
    const bucket = age < WEEK ? thisWk : age < 2 * WEEK ? lastWk : null;
    if (!bucket) continue;
    bucket.jumps += s.jumps;
    bucket.sec += s.seconds;
    bucket.kcal += s.kcal;
  }
  return { thisWk, lastWk };
}

// Stored JSON, or `fallback` when it's missing, corrupt, or storage itself
// is unavailable (blocked site data makes even touching localStorage throw).
export function readJSON(key, fallback) {
  try {
    const raw = globalThis.localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

// Best-effort save: a full or blocked storage must never break the app.
export function writeJSON(key, value) {
  try {
    globalThis.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
