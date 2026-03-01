import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VlmTeacher } from '../core/vlm_teacher.js';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function makeTeacher(opts = {}) {
  const t = new VlmTeacher();
  t.configure({
    model: 'openai/gpt-4o-mini',
    apiKey: opts.apiKey ?? null,
    apiUrl: 'https://example.test/v1/chat/completions',
    maxCallsPerDay: opts.maxCallsPerDay ?? 10,
    maxCallsPerSession: opts.maxCallsPerSession ?? 5
  });
  return t;
}

test('checkBudget blocks when API key is missing', () => {
  const teacher = makeTeacher({ apiKey: null });
  const budget = teacher._checkBudget();
  assert.equal(budget.allowed, false);
  assert.match(budget.reason, /No VLM API key configured/i);
});

test('learn returns blocked error when no API key', async () => {
  const teacher = makeTeacher({ apiKey: null });
  const result = await teacher.learn(Buffer.from('fake-image'), 'vscode');
  assert.equal(result.success, false);
  assert.match(result.error, /No VLM API key configured/i);
});

test('callVlm parses fenced JSON and increments session counters', async () => {
  const teacher = makeTeacher({ apiKey: 'sk-test' });
  teacher.session.lastCallDate = '1970-01-01';

  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{
        message: {
          content: '```json\n{"noButtonsFound":true,"reason":"No AI-generated changes visible","buttons":[]}\n```'
        }
      }]
    })
  });

  const result = await teacher._callVlm(Buffer.from('img'), 'prompt');
  assert.equal(result.success, true);
  assert.equal(result.noButtonsFound, true);
  assert.equal(Array.isArray(result.buttons), true);
  assert.equal(teacher.session.callsToday, 1);
  assert.equal(teacher.session.callsThisSession, 1);
  assert.equal(teacher.session.totalCalls, 1);
});

test('callVlm surfaces HTTP failures', async () => {
  const teacher = makeTeacher({ apiKey: 'sk-test' });

  global.fetch = async () => ({
    ok: false,
    status: 429,
    text: async () => 'rate limited'
  });

  const result = await teacher._callVlm(Buffer.from('img'), 'prompt');
  assert.equal(result.success, false);
  assert.match(result.error, /API 429/i);
});

test('relearn respects max session budget cap', async () => {
  const teacher = makeTeacher({ apiKey: 'sk-test', maxCallsPerSession: 1 });
  teacher.session.callsThisSession = 1;

  const result = await teacher.relearn(
    Buffer.from('img'),
    'vscode',
    { buttons: [{ label: 'Accept', region: { x: 0.5, y: 0.5, width: 0.1, height: 0.05 } }] }
  );

  assert.equal(result.success, false);
  assert.match(result.error, /Session VLM limit reached/i);
});

test('daily budget resets when date changes', () => {
  const teacher = makeTeacher({ apiKey: 'sk-test', maxCallsPerDay: 2 });
  teacher.session.lastCallDate = '1970-01-01';
  teacher.session.callsToday = 999;

  const budget = teacher._checkBudget();
  assert.equal(budget.allowed, true);
  assert.equal(teacher.session.callsToday, 0);
});
