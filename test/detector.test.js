import { test } from "node:test";
import assert from "node:assert/strict";
import { JumpDetector } from "../detector.js";
import { pose, hops, run } from "./poses.js";

const still = () => pose();

test("a person standing still never counts", () => {
  assert.equal(run(new JumpDetector(), still, 10_000).length, 0);
});

test("a steady run of jumps counts every jump", () => {
  const h = hops({ n: 10, period: 500, height: 0.05 });
  const counted = run(new JumpDetector(), (t) => pose({ lift: h(t) }), 9000);
  assert.equal(counted.length, 10);
  // retroactive credit keeps the jumps in time order
  assert.deepEqual(counted, [...counted].sort((a, b) => a - b));
});

test("fast low skips (200/min) are all counted", () => {
  const h = hops({ n: 20, period: 300, height: 0.03 });
  assert.equal(run(new JumpDetector(), (t) => pose({ lift: h(t) }), 10_000).length, 20);
});

test("one or two stray jumps don't confirm a run", () => {
  for (const n of [1, 2]) {
    const h = hops({ n, period: 500, height: 0.05 });
    assert.equal(run(new JumpDetector(), (t) => pose({ lift: h(t) }), 6000).length, 0, `n=${n}`);
  }
});

test("three jumps in a row confirm a run and all three count", () => {
  const h = hops({ n: 3, period: 500, height: 0.05 });
  assert.equal(run(new JumpDetector(), (t) => pose({ lift: h(t) }), 6000).length, 3);
});

test("jumps spaced more than 2 s apart never form a run", () => {
  const h = hops({ n: 6, period: 2600, height: 0.05, air: 0.1 });
  assert.equal(run(new JumpDetector(), (t) => pose({ lift: h(t) }), 20_000).length, 0);
});

test("tiny bobbing below the swing threshold doesn't count", () => {
  const h = hops({ n: 10, period: 500, height: 0.005 });
  assert.equal(run(new JumpDetector(), (t) => pose({ lift: h(t) }), 9000).length, 0);
});

test("hops with both hands held overhead are vetoed", () => {
  const h = hops({ n: 10, period: 500, height: 0.05 });
  const frame = (t) => pose({ lift: h(t), wristY: 0.2 });
  assert.equal(run(new JumpDetector(), frame, 9000).length, 0);
});

test("walking sideways across the frame doesn't count", () => {
  // stride bob while drifting ~a torso length per second
  const h = hops({ n: 10, period: 500, height: 0.05 });
  const frame = (t) => pose({ lift: h(t), dx: Math.max(0, t - 1000) * 0.0002 });
  assert.equal(run(new JumpDetector(), frame, 6000).length, 0);
});

test("sensitivity scales the minimum jump height", () => {
  const h = hops({ n: 10, period: 500, height: 0.012 });
  const frame = (t) => pose({ lift: h(t) });
  assert.equal(run(new JumpDetector(() => "high"), frame, 9000).length, 10);
  assert.equal(run(new JumpDetector(() => "low"), frame, 9000).length, 0);
});

test("reset() forgets held candidates and the running rhythm", () => {
  const d = new JumpDetector();
  const two = hops({ n: 2, period: 500, height: 0.05 });
  run(d, (t) => pose({ lift: two(t) }), 1900);
  assert.equal(d.pending.length, 2);
  d.reset();
  assert.equal(d.pending.length, 0);
  // after the reset a single jump is again just one uncounted candidate
  const one = hops({ n: 1, period: 500, height: 0.05 });
  assert.equal(run(d, (t) => pose({ lift: one(t) }), 3000).length, 0);
});

test("frames without a measurable torso are ignored", () => {
  const d = new JumpDetector();
  const flat = pose();
  for (const i of [11, 12, 23, 24]) flat[i] = { ...flat[i], x: 0.5, y: 0.5 };
  assert.doesNotThrow(() => d.update(flat, 0));
  assert.equal(d.ready, false);
});
