import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { WorkflowEventBus, EVENT_TYPES } from '../core/event_bus.js';

test('publish stores events with workflowId default null', () => {
  const bus = new WorkflowEventBus({ logToConsole: false });
  bus.publish(EVENT_TYPES.SYSTEM_INFO, { message: 'booted' });

  const events = bus.getRecentEvents(1);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, EVENT_TYPES.SYSTEM_INFO);
  assert.equal(events[0].workflowId, null);
  assert.equal(events[0].message, 'booted');
});

test('history is capped at maxEvents', () => {
  const bus = new WorkflowEventBus({ logToConsole: false, maxEvents: 3 });
  bus.publish('e1');
  bus.publish('e2');
  bus.publish('e3');
  bus.publish('e4');

  const events = bus.getRecentEvents(10);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((e) => e.type), ['e4', 'e3', 'e2']);
});

test('subscribe returns unsubscribe function', () => {
  const bus = new WorkflowEventBus({ logToConsole: false });
  const seen = [];
  const unsubscribe = bus.subscribe((e) => seen.push(e.type));

  bus.publish('first');
  unsubscribe();
  bus.publish('second');

  assert.deepEqual(seen, ['first']);
});

test('subscriber exceptions are isolated', () => {
  const bus = new WorkflowEventBus({ logToConsole: false });
  let hit = false;

  bus.subscribe(() => { throw new Error('boom'); });
  bus.subscribe(() => { hit = true; });

  assert.doesNotThrow(() => bus.publish('x'));
  assert.equal(hit, true);
});

test('attachBudgetController re-emits budget events', async () => {
  const bus = new WorkflowEventBus({ logToConsole: false });
  const controller = new EventEmitter();

  bus.attachBudgetController(controller);

  const eventPromise = new Promise((resolve) => {
    bus.once(EVENT_TYPES.BUDGET_EXCEEDED, resolve);
  });

  controller.emit('workflow_budget_exceeded', { workflowId: 'wf-1', spentUsd: 12.5 });
  const evt = await eventPromise;

  assert.equal(evt.type, EVENT_TYPES.BUDGET_EXCEEDED);
  assert.equal(evt.workflowId, 'wf-1');
  assert.equal(evt.spentUsd, 12.5);
});
