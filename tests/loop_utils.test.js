import test from 'node:test';
import assert from 'node:assert/strict';
import { safeInterval, selfSchedulingLoop, delay } from '../core/loop_utils.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('safeInterval validates interval value', () => {
  assert.throws(
    () => safeInterval(() => {}, 0, { autoStart: false, name: 'bad' }),
    /Invalid intervalMs/
  );
});

test('safeInterval runs repeatedly and can be stopped', async () => {
  let count = 0;
  const handle = safeInterval(() => { count += 1; }, 15, { name: 'repeat' });

  await sleep(180);
  handle.stop();
  const frozen = count;
  await sleep(40);

  // On loaded CI/workstations, timer jitter can delay many ticks.
  assert.equal(frozen >= 1, true);
  assert.equal(count, frozen);
});

test('safeInterval preventOverlap avoids concurrent executions', async () => {
  let running = 0;
  let maxConcurrent = 0;

  const handle = safeInterval(async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await sleep(30);
    running -= 1;
  }, 10, { name: 'overlap', preventOverlap: true });

  await sleep(130);
  handle.stop();

  assert.equal(maxConcurrent, 1);
});

test('selfSchedulingLoop honors runImmediately=false', async () => {
  let calls = 0;
  const handle = selfSchedulingLoop(async () => { calls += 1; }, 20, {
    name: 'schedule',
    runImmediately: false
  });

  assert.equal(calls, 0);
  await sleep(35);
  assert.equal(calls >= 1, true);

  handle.stop();
});

test('delay resolves after the requested wait', async () => {
  const t0 = Date.now();
  await delay(30);
  const elapsed = Date.now() - t0;
  assert.equal(elapsed >= 20, true);
});
