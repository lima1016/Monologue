/* 설정 > 기록 지우기: the confirm dialog shows what goes, with real counts,
 * and only a press on its destructive button deletes anything.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './dom-shim.js';
import { $ } from './api.js';
import { resetDom, stubFetch, jsonResponse } from './dom-shim.js';
import { cancelReset, confirmReset, initResetPrefs, openResetConfirm, resetAftermath, resetCountsLine,
         resetScope, setResetScope } from './settings.js';

beforeEach(() => resetDom());

const COUNTS = { sessions: 71, reports: 60, reviews: 16, timed_rounds: 0, level_tests: 2,
                 coach_notes: 1, recordings: 0 };
const ZERO = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, 0]));

/* Answers the summary with `counts` (or `summary()` if given) and the reset
   with `reset()` if given; records every call. */
function install({ counts = COUNTS, summary, reset } = {}) {
  const calls = [];
  stubFetch(async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url.startsWith('/api/history/summary')) {
      return summary ? summary() : jsonResponse({ counts });
    }
    if (url === '/api/history/reset') {
      return reset ? reset() : jsonResponse({ deleted: counts });
    }
    return jsonResponse({});
  });
  return calls;
}

function pickScope(scope) {
  for (const s of ['en', 'ja', 'all']) $(`reset-scope-${s}`).checked = s === scope;
}

const posts = (calls) => calls.filter((c) => c.method === 'POST');

test('the scope starts at the current language and reads back what is picked', () => {
  setResetScope('ja');
  assert.equal($('reset-scope-ja').checked, true);
  assert.equal($('reset-scope-en').checked, false);
  assert.equal($('reset-scope-all').checked, false);
  assert.equal(resetScope(), 'ja');
  pickScope('all');
  assert.equal(resetScope(), 'all');
});

test('the count line names only what there is, joined by dots', () => {
  assert.equal(resetCountsLine(COUNTS), '세션 71개 · 리포트 60개 · 복습 카드 16개 · 레벨 테스트 2개');
  assert.equal(resetCountsLine({ ...COUNTS, timed_rounds: 3, recordings: 5 }),
    '세션 71개 · 리포트 60개 · 복습 카드 16개 · 1분 말하기 3회 · 레벨 테스트 2개 · 내 녹음 5개');
  assert.equal(resetCountsLine(ZERO), '');
});

test('opening the confirm says it is counting, then shows the real counts for the chosen scope', async () => {
  let answer;
  const calls = install({ summary: () => new Promise((r) => { answer = r; }) });
  pickScope('ja');

  const opened = openResetConfirm();
  assert.equal($('reset-confirm').open, true);
  assert.equal($('reset-title').textContent, '日本語 기록을 지울까요?');
  assert.equal($('reset-counts').textContent, '개수를 세는 중이에요');
  assert.equal($('btn-reset-confirm').disabled, true);

  answer(jsonResponse({ counts: COUNTS }));
  await opened;
  assert.equal(calls[0].url, '/api/history/summary?language=ja');
  assert.equal($('reset-counts').textContent, '세션 71개 · 리포트 60개 · 복습 카드 16개 · 레벨 테스트 2개');
  assert.equal($('btn-reset-confirm').disabled, false);
  assert.deepEqual(posts(calls), []);
});

test('with nothing to delete, the confirm says so and the button stays off', async () => {
  install({ counts: ZERO });
  pickScope('all');
  await openResetConfirm();
  assert.equal($('reset-title').textContent, '모든 기록을 지울까요?');
  assert.equal($('reset-counts').textContent, '지울 기록이 없어요');
  assert.equal($('btn-reset-confirm').disabled, true);
});

test('cancel closes only the confirm and deletes nothing', async () => {
  const calls = install();
  pickScope('en');
  $('settings').showModal();
  await openResetConfirm();
  cancelReset();
  assert.equal($('reset-confirm').open, false);
  assert.equal($('settings').open, true);
  assert.deepEqual(posts(calls), []);
});

test('a count that lands after cancel does not arm the button', async () => {
  let answer;
  install({ summary: () => new Promise((r) => { answer = r; }) });
  const opened = openResetConfirm();
  cancelReset();
  answer(jsonResponse({ counts: COUNTS }));
  await opened;
  assert.equal($('btn-reset-confirm').disabled, true);
});

test('confirming posts the scope, closes both dialogs, notifies and reloads', async () => {
  const calls = install();
  pickScope('en');
  $('settings').showModal();
  await openResetConfirm();
  const reloaded = [];
  await confirmReset((scope) => reloaded.push(scope));
  assert.deepEqual(posts(calls).map((c) => [c.url, c.body]), [['/api/history/reset', { language: 'en' }]]);
  assert.equal($('reset-confirm').open, false);
  assert.equal($('settings').open, false);
  assert.equal($('notice-text').textContent, 'English 기록을 지웠어요');
  assert.deepEqual(reloaded, ['en']);
});

test('the scope deleted is the one the counts were for, even if the radio moved since', async () => {
  const calls = install();
  pickScope('ja');
  await openResetConfirm();
  pickScope('all');
  await confirmReset(() => {});
  assert.deepEqual(posts(calls)[0].body, { language: 'ja' });
});

test('while the reset is out the buttons are off and say so; a failure keeps the dialog open', async () => {
  let answer;
  install({ reset: () => new Promise((r) => { answer = r; }) });
  pickScope('ja');
  $('settings').showModal();
  await openResetConfirm();
  const reloaded = [];
  const done = confirmReset(() => reloaded.push('x'));
  assert.equal($('btn-reset-confirm').disabled, true);
  assert.equal($('btn-reset-cancel').disabled, true);
  assert.equal($('btn-reset-confirm').textContent, '지우는 중이에요');

  answer(jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }));
  await done;
  assert.equal($('reset-confirm').open, true);
  assert.equal($('settings').open, true);
  assert.match($('reset-error').textContent, /지우지 못했어요/);
  assert.equal($('btn-reset-confirm').disabled, false);
  assert.equal($('btn-reset-cancel').disabled, false);
  assert.equal($('btn-reset-confirm').textContent, '기록 지우기');
  assert.deepEqual(reloaded, []);
});

test('a counting failure says so and leaves the delete button off; reopening clears it', async () => {
  install({ summary: () => jsonResponse({ detail: 'x' }, { ok: false, status: 500 }) });
  pickScope('en');
  await openResetConfirm();
  assert.equal($('reset-counts').textContent, '');
  assert.match($('reset-error').textContent, /개수를 세지 못했어요/);
  assert.equal($('btn-reset-confirm').disabled, true);

  install();
  await openResetConfirm();
  assert.equal($('reset-error').textContent, '');
  assert.equal($('btn-reset-confirm').disabled, false);
});

test('Escape cannot close the confirm while the reset is out', async () => {
  let answer;
  install({ reset: () => new Promise((r) => { answer = r; }) });
  initResetPrefs(() => {});
  await openResetConfirm();
  const done = confirmReset(() => {});
  let prevented = false;
  for (const fn of $('reset-confirm').listeners.cancel || []) fn({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  answer(jsonResponse({ deleted: COUNTS }));
  await done;
  prevented = false;
  for (const fn of $('reset-confirm').listeners.cancel || []) fn({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('the buttons are wired: 기록 지우기… opens the confirm, 취소 closes it', async () => {
  const calls = install();
  initResetPrefs(() => {});
  pickScope('en');
  for (const fn of $('btn-reset-open').listeners.click) await fn({});
  assert.equal($('reset-confirm').open, true);
  assert.equal(calls[0].url, '/api/history/summary?language=en');
  for (const fn of $('btn-reset-cancel').listeners.click) fn({});
  assert.equal($('reset-confirm').open, false);
  assert.deepEqual(posts(calls), []);
});

test('a failure after the confirm was closed anyway (a second Escape) still says so, as a notice', async () => {
  let answer;
  install({ reset: () => new Promise((r) => { answer = r; }) });
  await openResetConfirm();
  const done = confirmReset(() => {});
  $('reset-confirm').close();
  answer(jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }));
  await done;
  assert.equal($('notice-text').textContent, '지우지 못했어요. 잠시 뒤 다시 해 주세요.');
});

test('a failure with the confirm still open does not also raise a notice', async () => {
  install({ reset: () => jsonResponse({ detail: 'boom' }, { ok: false, status: 500 }) });
  await openResetConfirm();
  await confirmReset(() => {});
  assert.equal($('notice-text').textContent, '');
});

/* ---------- after the reset: which screen moves ---------- */

function spies() {
  const calls = [];
  return { calls, h: { mypage: () => calls.push('mypage'), home: () => calls.push('home'),
                       goHome: () => calls.push('goHome') } };
}

for (const screen of ['session', 'timed', 'leveltest', 'pick', 'report']) {
  test(`resetting the other language leaves the ${screen} screen alone`, () => {
    const { calls, h } = spies();
    resetAftermath('ja', screen, 'en', h);
    assert.deepEqual(calls, []);
  });
  test(`resetting this language (or both) takes the ${screen} screen home`, () => {
    for (const scope of ['en', 'all']) {
      const { calls, h } = spies();
      resetAftermath(scope, screen, 'en', h);
      assert.deepEqual(calls, ['goHome'], scope);
    }
  });
}

test('home and my page just reload, whichever language was reset', () => {
  for (const scope of ['en', 'ja', 'all']) {
    const a = spies();
    resetAftermath(scope, 'home', 'en', a.h);
    assert.deepEqual(a.calls, ['home'], scope);
    const b = spies();
    resetAftermath(scope, 'mypage', 'en', b.h);
    assert.deepEqual(b.calls, ['mypage'], scope);
  }
});
