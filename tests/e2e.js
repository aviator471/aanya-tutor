/*
 * End-to-end tests for the tutor (index.html).
 *
 *   npm install        (once; installs Playwright)
 *   npx playwright install chromium   (once, if Chromium isn't installed yet)
 *   npm test           (or: node tests/e2e.js)
 *
 * Every test opens the real page in Chromium, taps the real buttons, and checks what
 * Mom and Aanya would see plus the saved data. Claude is never called: requests to
 * api.anthropic.com are answered by a fake that returns a fixed lesson. The clock is
 * faked, so week rollover, the 8-minute rule and Sunday/Monday edges are exact.
 * Filter with: node tests/e2e.js week
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');

const FILE = 'file://' + path.resolve(__dirname, '..', 'index.html');
const MIN = 60e3, DAY = 864e5;
// Wednesday 11 Nov 2026, 4 pm local time. Week = Mon 9 Nov .. Sun 15 Nov.
const WED = new Date(2026, 10, 11, 16, 0, 0).getTime();

/* ---------------- fake Claude ---------------- */
function lessonJSON(title, subject = 'math') {
  const wrong = 'Look again at how many equal parts there are.';
  return {
    meta: { subject, title, topic: title, expectations: [], forMom: 'Practice with ' + title },
    concepts: ['Equal parts', 'Naming fractions'],
    explain: [{ text: 'A fraction names equal parts of a whole.' }, { text: 'The bottom number says how many equal parts.' }],
    examples: [{ title: 'Pizza', problem: 'A pizza has 4 slices. You eat 1. What fraction?', steps: ['Count all slices: 4', 'Count eaten: 1'], answer: '1/4' }],
    offscreen: [{ title: 'Draw it', instructions: 'Draw these.', problems: ['Draw 1/2', 'Draw 1/3'], answers: ['half shaded', 'one third shaded'], minutes: 3 }],
    practice: [
      { type: 'mcq', tier: 1, prompt: 'Which is one half?', choices: ['1/2', '1/3', '2/3'], answer: '1/2', explanationWrong: wrong, explainRef: 0 },
      { type: 'numeric', tier: 1, prompt: 'What is 3 + 4?', answer: '7', expr: '3+4', explanationWrong: wrong, explainRef: 0 },
      { type: 'short', tier: 2, prompt: 'Name the top number of a fraction.', answer: 'numerator', explanationWrong: wrong, explainRef: 1 },
      { type: 'order', tier: 2, prompt: 'Put in order, smallest first.', answer: ['1/4', '1/2', '1'], explanationWrong: wrong, explainRef: 0 },
      { type: 'match', tier: 2, prompt: 'Match each fraction to its word.', pairs: [{ a: '1/2', b: 'half' }, { a: '1/3', b: 'third' }, { a: '1/4', b: 'quarter' }], explanationWrong: wrong, explainRef: 0 },
      { type: 'sort', tier: 2, prompt: 'Sort them.', buckets: ['Less than 1/2', 'More than 1/2'], items: [{ text: '1/4', bucket: 0 }, { text: '1/8', bucket: 0 }, { text: '3/4', bucket: 1 }, { text: '7/8', bucket: 1 }], explanationWrong: wrong, explainRef: 0 },
      { type: 'fraction', tier: 3, prompt: 'Shade three quarters.', n: 3, d: 4, shape: 'pizza', explanationWrong: wrong, explainRef: 0 },
      { type: 'numberline', tier: 3, prompt: 'Place one half.', min: 0, max: 1, step: 0.25, target: '0.5', explanationWrong: wrong, explainRef: 0 },
    ],
    check: [
      { type: 'mcq', prompt: 'Which shows three quarters?', choices: ['3/4', '4/3', '1/4'], answer: '3/4', explanationWrong: wrong, explainRef: 0 },
      { type: 'numeric', prompt: 'What is 10 - 4?', answer: '6', expr: '10-4', explanationWrong: wrong, explainRef: 0 },
      { type: 'mcq', prompt: 'How many halves make a whole?', choices: ['2', '3', '4'], answer: '2', explanationWrong: wrong, explainRef: 1 },
    ],
  };
}
// The fake second model "solves" a question by looking it up in the fixture above.
function solve(q) {
  const L = lessonJSON('x'), src = [...L.practice, ...L.check].find(x => x.prompt === q.question);
  if (!src) return null;
  if (src.type === 'match') return src.pairs.map(p => p.b);
  if (src.type === 'sort') return src.items.map(i => i.bucket);
  return src.answer;
}
function sse(text) {
  const ev = o => 'data: ' + JSON.stringify(o) + '\n\n';
  return ev({ type: 'message_start' }) + ev({ type: 'content_block_delta', delta: { type: 'text_delta', text } }) + ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + ev({ type: 'message_stop' });
}

/* ---------------- harness ---------------- */
const TESTS = [];
const test = (name, fn) => TESTS.push({ name, fn });
class Fail extends Error {}
const ok = (cond, msg) => { if (!cond) throw new Fail(msg); };
const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Fail(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); };

let browser;
async function open({ time = WED, state, claudeCalls, init } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  page.calls = claudeCalls || [];
  if (init) await page.addInitScript(init);
  await page.route('https://api.anthropic.com/**', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    page.calls.push(body.model);
    const all = JSON.stringify(body.messages);
    if (/ANSWER-KEY CHECK/.test(body.system || '')) {
      page.keyChecks = (page.keyChecks || 0) + 1;
      if (page.keyCheckFails) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"message":"overloaded"}}' });
      const qs = JSON.parse(body.messages[0].content[0].text.split('Questions:\n')[1]);
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(JSON.stringify({ answers: qs.map(q => ({ id: q.id, answer: (page.badKeys || []).includes(q.question) ? 'something else' : solve(q) })) })) });
    }
    if (page.dropWhileHidden && /sonnet/.test(body.model)) { // the iPad locks while the lesson is being written
      await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      return route.abort('connectionreset');
    }
    if (/haiku/.test(body.model)) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse('Think of sharing a sandwich with a friend: two equal halves.') });
    const m = all.match(/Topic [A-Z][a-z]+/);
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(JSON.stringify({ lesson: lessonJSON(m ? m[0] : 'Mock lesson') })) });
  });
  page.now = time;
  await page.clock.setFixedTime(time);
  await page.goto(FILE);
  if (state) await page.evaluate(s => { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(s)); load(); render(); }, state);
  return page;
}
// Move the fake clock forward (time passes for the app).
async function tick(page, ms) { page.now += ms; await page.clock.setFixedTime(page.now); }
async function setTime(page, t) { page.now = t; await page.clock.setFixedTime(t); }
// A tap = a real click event on the button (the app's own handlers run). We skip Playwright's
// "wait until the element stops animating" check, which only slows things down here.
const tap = async (page, sel) => {
  const el = page.locator(sel).first();
  await el.waitFor({ state: 'visible' });
  await el.evaluate(e => { if (e.disabled) throw new Error('button is disabled'); e.click(); });
  await page.waitForTimeout(15);
};
const act = (page, a, v) => tap(page, v == null ? `[data-a="${a}"]` : `[data-a="${a}"][data-v="${v}"]`);
const S = (page, fn = 'S') => page.evaluate(fn);
const text = page => page.locator('#app').textContent(); // textContent ignores CSS uppercase

/* Mom set-up through the real screens: PIN, welcome (name + key). */
async function momSetup(page, pin = '1234') {
  await act(page, 'pickMom');
  for (const d of pin) await act(page, 'pinKey', d);
  await page.waitForFunction(() => view.name === 'pin' && view.p.mode === 'set2');
  for (const d of pin) await act(page, 'pinKey', d);
  await page.waitForFunction(() => view.name === 'welcome');
  await page.fill('[data-bind="W:name"]', 'Aanya');
  await page.fill('[data-bind="W:key"]', 'sk-ant-test-key');
  await act(page, 'welcomeSave');
  await page.waitForFunction(() => view.name === 'momHome');
}
async function momLogin(page, pin = '1234') {
  await page.evaluate(() => { role = null; go('gate'); });
  await act(page, 'pickMom');
  for (const d of pin) await act(page, 'pinKey', d);
  await page.waitForFunction(() => view.name === 'momHome');
}
async function kidLogin(page) { await page.evaluate(() => { role = null; go('gate'); }); await act(page, 'pickKid'); }

/* Mom makes a lesson through New lesson (fake Claude). Returns the lesson id. */
async function makeLesson(page, topic, subject = 'math') {
  await page.evaluate(() => go('momHome'));
  await act(page, 'newLesson');
  await act(page, 'nlSubject', subject);
  await page.fill('#nlTopic', topic);
  if (await page.locator('[data-bind="NL:split"]').isChecked()) await page.locator('[data-bind="NL:split"]').uncheck();
  await act(page, 'generate');
  await page.waitForFunction(() => view.name === 'summary', null, { timeout: 10000 });
  return page.evaluate(() => view.p.id);
}
/* Fast path for tests that are not about authoring: same normalising code, no screens. */
async function seedLessons(page, titles) {
  return page.evaluate(([titles, raws]) => titles.map((t, i) => saveNewLesson({ lesson: normalizeLesson(raws[i], 'math') }, { mode: 'topic', subject: 'math' }).id),
    [titles, titles.map(t => lessonJSON(t))]);
}
async function freshWithLessons(titles, opts = {}) {
  const page = await open(opts);
  await momSetup(page);
  const ids = await seedLessons(page, titles);
  return { page, ids };
}

/*
 * Plays the lesson on screen like Aanya would, tapping real buttons.
 *  minutes: how long it takes (spread over the steps on the fake clock)
 *  wrong:   set of question prompts to answer wrongly
 *  explainDifferently: tap "Explain it differently" on the first card
 */
async function play(page, { minutes = 15, wrong = [], explainDifferently = false, cause, stopAt } = {}) {
  await page.waitForFunction(() => view.name === 'play');
  const per = Math.floor(minutes * MIN / 30); // a full lesson is about 30 taps
  for (let guard = 0; guard < 120; guard++) {
    await page.waitForTimeout(20);
    const st = await page.evaluate(() => {
      if (view.name !== 'play' || !S.attempt) return { done: true, view: view.name };
      const a = S.attempt, s = a.steps[a.si], q = curQ();
      return { k: s && s.k, interject: a.interject, fb: a.sub.fb ? { correct: a.sub.fb.correct } : null, phase: a.sub.phase || 'work', shown: a.sub.shown || 0, ex: s && s.k === 'example' ? curLesson().examples[s.i].steps.length : 0,
        q: q && { type: q.type, prompt: q.prompt, choices: q.choices, answer: q.answer, pairs: q.pairs, items: q.items, n: q.n, d: q.d, min: q.min, max: q.max, target: q.target }, shuf: a.sub.shuf, seen: a.sub.seen };
    });
    if (st.done) return st.view;
    if (stopAt && st.q && !st.fb && st.interject == null && st.q.type === stopAt) return 'stopped';
    await tick(page, per);
    if (st.interject != null && st.k === 'practice' && !st.fb) { await act(page, 'endInterject'); continue; }
    if (st.k === 'explain') { if (explainDifferently) { explainDifferently = false; await act(page, 'explainDiff', '0'); await page.waitForFunction(() => !EXPLAINING); } await act(page, 'next'); continue; }
    if (st.k === 'passage') { await act(page, 'next'); continue; }
    if (st.k === 'example') { if (st.shown < st.ex) await act(page, 'revealStep'); else await act(page, 'next'); continue; }
    if (st.k === 'pencil') {
      if (st.phase === 'work') { await tick(page, 46e3); await page.waitForFunction(() => !document.querySelector('#doneBtn').disabled, null, { timeout: 5000 }); await act(page, 'pencilDone'); }
      else await act(page, 'pencilNext');
      continue;
    }
    if (st.fb) { if (!st.fb.correct && cause) await act(page, 'setCause', cause); await act(page, 'next'); continue; }
    if (st.k === 'warm' && !st.seen && (await page.locator('[data-a="seenReteach"]').count())) { await act(page, 'seenReteach'); continue; }
    await answer(page, st.q, st.shuf, wrong.includes(st.q.prompt));
  }
  throw new Fail('lesson did not finish');
}
async function answer(page, q, shuf, bad) {
  if (q.type === 'mcq') { const want = bad ? q.choices.find(c => c !== q.answer) : q.answer; return act(page, 'answerMcq', String(q.choices.indexOf(want))); }
  if (q.type === 'numeric') { for (const ch of (bad ? '999' : q.answer)) await act(page, 'key', ch === ' ' ? 'sp' : ch); return act(page, 'key', 'ok'); }
  if (q.type === 'short') { await page.fill('#shortIn', bad ? 'banana' : q.answer); return act(page, 'answerShort'); }
  if (q.type === 'order') { const seq = bad ? q.answer.slice().reverse() : q.answer; for (const x of seq) await act(page, 'orderPick', String(shuf.indexOf(x))); return act(page, 'answerOrder'); }
  if (q.type === 'match') {
    if (bad) { await act(page, 'mLeft', '0'); await act(page, 'mRight', '1'); }
    for (let i = 0; i < q.pairs.length; i++) { await act(page, 'mLeft', String(i)); await act(page, 'mRight', String(i)); }
    return page.waitForFunction(() => S.attempt && S.attempt.sub.fb, null, { timeout: 3000 });
  }
  if (q.type === 'sort') {
    if (bad) { await act(page, 'sItem', '0'); await act(page, 'sBucket', String(1 - q.items[0].b)); }
    for (let i = 0; i < q.items.length; i++) { await act(page, 'sItem', String(i)); await act(page, 'sBucket', String(q.items[i].b)); }
    return page.waitForFunction(() => S.attempt && S.attempt.sub.fb, null, { timeout: 3000 });
  }
  if (q.type === 'fraction') { const n = bad ? 1 : q.n; for (let i = 0; i < n; i++) await page.locator(`[data-a="fTog"][data-v="${i}"]`).dispatchEvent('click'); return act(page, 'fCheck'); }
  if (q.type === 'numberline') {
    const v = bad ? q.max : q.target, box = await page.locator('#nlSvg').boundingBox();
    await page.mouse.click(box.x + (30 + (v - q.min) / (q.max - q.min) * 540) / 600 * box.width, box.y + box.height * 0.55);
    return act(page, 'nlCheck');
  }
  throw new Fail('unknown question type ' + q.type);
}
/* Aanya taps Start on a lesson in "My week" and plays it. */
async function kidDoes(page, id, opts) {
  await page.evaluate(() => go('kidHome'));
  await act(page, 'kidStart', id);
  const v = await play(page, opts);
  eq(v, 'reward', 'ends on the reward screen');
  return page.evaluate(() => S.results[0]);
}
async function addToWeekUI(page, id) {
  await page.evaluate(() => { LTAB = 'all'; go('lessons'); });
  await act(page, 'assignLesson', id);
}

/* =========================================================
   Existing features
   ========================================================= */
test('first run: PIN, welcome, wrong PIN is refused, reload keeps data', async () => {
  const page = await open();
  await momSetup(page, '2468');
  const st = await S(page);
  eq(st.settings.learnerName, 'Aanya', 'name saved');
  ok(st.settings.pin && st.settings.pin !== '2468', 'PIN saved hashed');
  await page.evaluate(() => { role = null; go('gate'); });
  await act(page, 'pickMom');
  for (const d of '1111') await act(page, 'pinKey', d);
  await page.waitForTimeout(250);
  ok((await text(page)).includes('didn’t match'), 'wrong PIN message');
  eq(await page.evaluate(() => role), null, 'still locked');
  await page.reload();
  eq(await page.evaluate(() => S.settings.learnerName), 'Aanya', 'data survives reload');
  await page.evaluate(() => { go('momHome'); });
  eq(await page.evaluate(() => view.name), 'gate', 'Mom screens need the PIN after reload');
  return page;
});

test('Mom makes a lesson with Claude (faked) and it lands in this week', async () => {
  const page = await open();
  await momSetup(page);
  const id = await makeLesson(page, 'Topic Fractions');
  ok((await text(page)).includes('Topic Fractions'), 'summary shows the lesson');
  eq(page.calls.filter(m => /sonnet/.test(m)).length, 1, 'one authoring call');
  eq(page.keyChecks, 1, 'answer keys checked once by the second model');
  ok((await text(page)).includes('Answer keys double-checked'), 'Mom sees the check passed');
  const L = await page.evaluate(id => S.lessons[id], id);
  eq(L.practice.length, 8, 'all 8 practice questions kept');
  eq(L.check.length, 3, '3 check questions kept');
  await page.evaluate(() => go('lessons'));
  await act(page, 'assignLesson', id);
  eq(await page.evaluate(() => S.week.core), [id], 'added to this week');
  ok((await text(page)).includes('This week’s lessons'), 'plan card on Lessons');
  return page;
});

test('Aanya plays a whole lesson, every question type, all right', async () => {
  const { page, ids } = await freshWithLessons(['Topic Alpha']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 20 });
  eq(r.mastery, 100, 'mastery');
  eq([r.checkRight, r.checkTotal], [3, 3], 'check score');
  eq(r.practiceRight, r.practiceTotal, 'all practice right');
  ok(r.minutes >= 17 && r.minutes <= 24, 'minutes from the clock: ' + r.minutes);
  const pts = 100 + 3 * 5 + 50;
  eq(r.points, pts, 'points = lesson + right answers on the final test + perfect test (practice and paper pay nothing)');
  eq(await page.evaluate(() => [S.points.balance, pendingPts()]), [0, pts], 'held until Mom accepts');
  const t = await text(page);
  ok(t.includes('Lesson complete') && t.includes('2 more to fill your week'), 'reward screen with week progress');
  return page;
});

test('wrong answers: feedback, cause tag, mistakes notebook, review flow', async () => {
  const { page, ids } = await freshWithLessons(['Topic Beta']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 15, wrong: ['Which shows three quarters?', 'What is 3 + 4?'], cause: 'slip' });
  eq([r.checkRight, r.checkTotal], [2, 3], 'one check wrong');
  eq(r.mastery, 67, 'mastery');
  eq(r.causes.slip, 2, 'causes recorded');
  const nb = await page.evaluate(() => S.notebook.map(n => n.q.prompt).sort());
  eq(nb, ['What is 3 + 4?', 'Which shows three quarters?'], 'notebook has both');
  ok((await text(page)).includes('Review your mistakes (2)'), 'review button on reward');
  await act(page, 'startReview', ids[0]);
  eq(await play(page, { minutes: 2 }), 'reviewDone', 'review completes');
  ok((await text(page)).includes('Review done'), 'review done screen');
  return page;
});

test('score is the whole final test: "explain differently" (Haiku, faked) marks answers as helped but they still count', async () => {
  const { page, ids } = await freshWithLessons(['Topic Gamma']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 15, explainDifferently: true, wrong: ['What is 10 - 4?'] });
  ok(page.calls.some(m => /haiku/.test(m)), 'Haiku called');
  eq(r.helpedCount, 2, 'two check questions used explain card 0');
  eq([r.masteryRight, r.masteryTotal, r.mastery], [2, 3, 67], 'score counts every test question, helped or not');
  eq(r.explainUsed, 1, 'explain count');
  return page;
});

test('flag a question: not counted against her, Mom sees it', async () => {
  const { page, ids } = await freshWithLessons(['Topic Delta']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  // go to the first question and flag it
  for (let i = 0; i < 12; i++) { if (await page.locator('[data-a="flagQ"]').count()) break; await tick(page, MIN); const k = await page.evaluate(() => S.attempt.steps[S.attempt.si].k); if (k === 'example') await act(page, (await page.locator('[data-a="revealStep"]').count()) ? 'revealStep' : 'next'); else if (k === 'pencil') { await tick(page, 46e3); await page.waitForFunction(() => !document.querySelector('#doneBtn').disabled); await act(page, 'pencilDone'); await act(page, 'pencilNext'); } else await act(page, 'next'); }
  await act(page, 'flagQ');
  await play(page, { minutes: 12 });
  const r = await S(page, 'S.results[0]');
  eq(r.flagged.length, 1, 'flag recorded on result');
  await momLogin(page);
  ok((await text(page)).includes('1 flagged question'), 'Mom home strip');
  await act(page, 'go', 'flags');
  ok((await text(page)).includes('Flagged questions'), 'flags screen');
  return page;
});

test('Mom: results accept, report, catch-up plan, curriculum', async () => {
  const { page, ids } = await freshWithLessons(['Topic Eps']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 15, wrong: ['Which shows three quarters?', 'What is 10 - 4?', 'How many halves make a whole?'] });
  await momLogin(page);
  await act(page, 'go', 'results');
  await act(page, 'acceptResult');
  eq(await page.evaluate(() => S.results[0].accepted), true, 'accepted');
  await page.evaluate(() => go('report'));
  const t = await text(page);
  ok(t.includes('How Aanya is doing') && t.includes('Lessons per week'), 'report with weekly chart');
  await page.locator('[data-a="planBuild"]').first().click();
  ok(await page.evaluate(() => !!S.plan && S.plan.steps.length > 0), 'catch-up plan built (free)');
  await act(page, 'go', 'curriculum');
  ok((await text(page)).length > 200, 'curriculum renders');
  return page;
});

test('backup: save a file and restore it', async () => {
  const { page, ids } = await freshWithLessons(['Topic Zeta', 'Topic Eta']);
  await page.evaluate(ids => { ids.forEach(id => addToWeek(id, true)); S.points.balance = 321; save(); }, ids);
  await page.evaluate(() => go('settings'));
  const [dl] = await Promise.all([page.waitForEvent('download'), act(page, 'exportData')]);
  const file = path.join(os.tmpdir(), 'tutor-backup-test.json');
  await dl.saveAs(file);
  ok(/tutor-backup-\d{4}-\d\d-\d\d-balance-3\.21\.json/.test(dl.suggestedFilename()), 'balance in the file name: ' + dl.suggestedFilename());
  const raw = fs.readFileSync(file, 'utf8');
  ok(raw.startsWith('{"summary":"Aanya') && raw.includes('balance 321 points ($3.21'), 'summary is the first thing in the file');
  const saved = JSON.parse(raw);
  eq(saved.settings.apiKey, '', 'key not in backup');
  eq(saved.week.core, ids, 'week plan in backup');
  await page.evaluate(() => { S.points.balance = 0; S.week.core = []; save(); go('settings'); });
  await page.setInputFiles('#importFile', file);
  await page.waitForFunction(() => S.points.balance === 321);
  eq(await page.evaluate(() => S.week.core), ids, 'plan restored');
  eq(await page.evaluate(() => S.settings.apiKey), 'sk-ant-test-key', 'key kept on restore');
  return page;
});

test('rewards: dollar rate, goal bought, redeemable, pay out', async () => {
  const { page } = await freshWithLessons([]);
  await page.evaluate(() => { addPoints(1000, 'test'); save(); go('rewards'); });
  await page.fill('#rateIn', '200'); await act(page, 'saveRate');
  ok((await text(page)).includes('$5.00'), '1000 points at 200/$ = $5.00');
  await page.fill('[data-bind="RW:goal"]', 'Book'); await page.fill('[data-bind="RW:price"]', '2'); await act(page, 'goalAdd');
  await act(page, 'goalBought');
  eq(await page.evaluate(() => S.points.balance), 600, 'goal took 400 points');
  await page.fill('#payIn', '1.50'); await act(page, 'payOut');
  eq(await page.evaluate(() => S.points.balance), 300, 'pay out took 300 points');
  await page.fill('#payIn', '50'); await act(page, 'payOut');
  eq(await page.evaluate(() => S.points.balance), 300, 'cannot pay out more than she has');
  await kidLogin(page);
  ok((await text(page)).includes('worth $1.50'), 'Aanya sees her points in dollars');
  return page;
});

/* =========================================================
   Weekly plan, goal and bonus
   ================================================================ */
test('week plan: 3 core then 2 bonus, a 6th is refused, duplicates ignored', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C', 'Topic D', 'Topic E', 'Topic F']);
  for (const id of ids) await addToWeekUI(page, id);
  await addToWeekUI(page, ids[5]); // already refused, still not added
  const w = await S(page, 'S.week');
  eq(w.core.length + w.bonus.length, 5, 'five slots filled');
  eq(w.bonus.length, 2, 'two bonus');
  ok(!w.core.includes(ids[5]) && !w.bonus.includes(ids[5]), '6th refused');
  await page.evaluate(id => addToWeek(id), w.core[0]);
  eq((await S(page, 'S.week')).core.length, 3, 'adding a planned lesson again does nothing');
  await page.evaluate(() => go('momHome'));
  const t = await text(page);
  ok(t.includes('This week’s lessons') && t.includes('B1') && t.includes('B2'), 'Mom home shows the plan with bonus slots');
  ok(!t.includes('needs'), 'no "needs more lessons" warning when 3 are planned');
  return page;
});

test('Mom is warned when the week has fewer than 3 lessons planned', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => { addToWeek(id, true); go('momHome'); }, ids[0]);
  ok((await text(page)).includes('This week’s plan needs 2 more lessons'), 'warning');
  return page;
});

test('Aanya picks any of the 3 in any order; bonus stays locked until 3 are done', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C', 'Topic D']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  const t = await text(page);
  ok(t.includes('A fresh week') && t.includes('unlock after your 3'), 'kid home shows week + locked bonus');
  eq(await page.locator(`[data-a="kidStart"][data-v="${ids[3]}"]`).count(), 0, 'no Start button on locked bonus');
  await page.evaluate(id => A.kidStart(id), ids[3]);
  eq(await page.evaluate(() => S.attempt), null, 'bonus cannot be started early, even by a direct call');
  await kidDoes(page, ids[2], { minutes: 12 }); // third one first
  await kidDoes(page, ids[0], { minutes: 12 });
  await page.evaluate(() => go('kidHome'));
  ok((await text(page)).includes('Just 1 more'), 'goal-gradient message at 2');
  await kidDoes(page, ids[1], { minutes: 12 });
  ok((await text(page)).includes('Bonus lessons are open'), 'reward screen announces bonus');
  await page.evaluate(() => go('kidHome'));
  ok((await page.locator(`[data-a="kidStart"][data-v="${ids[3]}"]`).count()) === 1, 'bonus Start button now shown');
  return page;
});

test('starting a second lesson while one is in progress is blocked', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  await act(page, 'exitPlay');
  ok((await text(page)).includes('Keep going'), 'keep going shown');
  eq(await page.locator(`[data-a="kidStart"][data-v="${ids[1]}"]`).count(), 0, 'other Start hidden');
  await page.evaluate(id => A.kidStart(id), ids[1]);
  eq(await page.evaluate(() => S.attempt.lessonId), ids[0], 'still on the first lesson');
  await act(page, 'resumePlay');
  eq(await play(page, { minutes: 12 }), 'reward', 'resumes and finishes');
  return page;
});

test('8-minute rule: a 5-minute lesson does not count and its slot stays open', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 3 });
  ok(r.minutes < 8, 'short lesson: ' + r.minutes + ' min');
  ok((await text(page)).includes('at least 8 minutes'), 'reward explains the rule');
  eq(await page.evaluate(() => weekList(1)[0].count), 0, 'week count stays 0');
  await page.evaluate(() => go('kidHome'));
  eq(await page.locator(`[data-a="kidStart"][data-v="${ids[0]}"]`).count(), 1, 'she can do it again');
  const r2 = await kidDoes(page, ids[0], { minutes: 10 });
  ok(r2.minutes >= 8, 'second try counts');
  eq(await page.evaluate(() => weekList(1)[0].count), 1, 'now 1');
  return page;
});

test('bonus lesson pays 2x base points only after the 3, core lessons pay 1x', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C', 'Topic D', 'Topic E']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  for (const id of ids.slice(0, 3)) { const r = await kidDoes(page, id, { minutes: 10 }); eq(r.breakdown[0], ['Lesson complete (score 100%)', 100], 'core pays 100'); }
  const b = await kidDoes(page, ids[3], { minutes: 10 });
  eq(b.breakdown[0], ['Bonus lesson ×2 (score 100%)', 200], 'bonus pays 200');
  ok(b.bonus, 'result marked bonus');
  ok((await text(page)).includes('Bonus lesson ×2'), 'shown on reward screen');
  const short = await kidDoes(page, ids[4], { minutes: 3 });
  eq([short.points, short.bonus], [0, false], 'a too-short bonus lesson pays nothing');
  eq(await page.evaluate(() => weekList(1)[0].count), 4, 'week count 4');
  return page;
});

test('mid-week edits: remove undone slot, done slot is locked, in-progress asks first', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C', 'Topic D']);
  await page.evaluate(ids => ids.slice(0, 3).forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10 });
  await act(page, 'go', 'kidHome');
  await act(page, 'kidStart', ids[1]); await act(page, 'exitPlay');
  await momLogin(page);
  eq(await page.locator(`[data-a="weekRemove"][data-v="${ids[0]}"]`).count(), 0, 'done slot has no remove');
  await act(page, 'weekRemove', ids[2]);
  eq((await S(page, 'S.week')).core, [ids[0], ids[1]], 'removed C');
  await act(page, 'weekRemove', ids[1]); // dialog auto-accepted
  eq(await page.evaluate(() => S.attempt), null, 'in-progress attempt cleared after confirm');
  await addToWeekUI(page, ids[3]);
  eq((await S(page, 'S.week')).core, [ids[0], ids[3]], 'new lesson takes the free slot');
  const grp = await page.evaluate(id => lessonInfo(S.lessons[id]).group, ids[2]);
  eq(grp, 'ready', 'removed lesson is back in Ready');
  return page;
});

test('week rollover on Monday: plan resets, unfinished go back to Ready, history kept', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C', 'Topic D']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10 });
  await kidDoes(page, ids[1], { minutes: 10 });
  // Sunday 23:40: finish one more. It must count for this week.
  await setTime(page, new Date(2026, 10, 15, 23, 40).getTime());
  await kidDoes(page, ids[2], { minutes: 10 }); // ends ~23:51 Sunday
  eq(await page.evaluate(() => weekList(1)[0].count), 3, 'Sunday-night lesson counts for the old week');
  // Monday 7 am
  await setTime(page, new Date(2026, 10, 16, 7, 0).getTime());
  await page.reload();
  await kidLogin(page);
  const w = await S(page, 'S.week');
  eq([w.start, w.core.length, w.bonus.length], ['2026-11-16', 0, 0], 'new empty week');
  const t = await text(page);
  ok(t.includes('Mom hasn’t picked this week’s lessons yet'), 'kid sees empty week');
  ok(t.includes('Last week') && t.includes('3 lessons'), 'last week stamp shows 3');
  eq(await page.evaluate(() => S.weekLeft), { start: '2026-11-09', n: 1 }, 'one bonus left unfinished');
  eq(await page.evaluate(id => lessonInfo(S.lessons[id]).group, ids[3]), 'ready', 'unfinished one is in Ready');
  await momLogin(page);
  ok((await text(page)).includes('Last week: 1 lesson not done'), 'Mom told once');
  await act(page, 'weekLeftOk');
  eq(await page.evaluate(() => S.weekLeft), null, 'notice dismissed');
  eq(await page.evaluate(() => weeksFilled()), 1, 'weeks filled = 1');
  return page;
});

test('a lesson started Sunday and finished Monday counts for Monday', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await setTime(page, new Date(2026, 10, 15, 23, 50).getTime());
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  await act(page, 'exitPlay');
  await setTime(page, new Date(2026, 10, 16, 8, 0).getTime());
  await page.reload();
  await kidLogin(page);
  const t = await text(page);
  ok(t.includes('Keep going'), 'in-progress lesson can still be finished');
  await act(page, 'resumePlay');
  await play(page, { minutes: 12 });
  const wl = await page.evaluate(() => weekList(2).map(w => w.count));
  eq(wl, [0, 1], 'counted in the new week');
  return page;
});

test('break week: Mom marks it, Aanya sees it, chart and stamps show it after rollover', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(() => go('momHome'));
  await act(page, 'weekBreak');
  ok(await page.evaluate(() => S.week.brk), 'flag set');
  ok(!(await text(page)).includes('needs'), 'no "needs more" warning in a break week');
  await kidLogin(page);
  ok((await text(page)).includes('Break week'), 'kid sees break message');
  await setTime(page, new Date(2026, 10, 17, 9, 0).getTime());
  await page.reload();
  await kidLogin(page);
  ok(await page.evaluate(() => S.breaks.includes('2026-11-09')), 'break remembered');
  ok((await text(page)).includes('break'), 'stamp says break');
  await momLogin(page);
  await act(page, 'go', 'report');
  ok((await page.locator('.wkchart').first().textContent()).includes('break'), 'chart labels the break week');
  return page;
});

test('upgrade from v14: the lesson Mom had assigned moves into this week', async () => {
  const page = await open();
  const L = await page.evaluate(raw => normalizeLesson(raw, 'math'), lessonJSON('Topic Old'));
  const st = await page.evaluate(L => { const d = DEFAULT_STATE(); delete d.week; L.id = 'old1'; L.createdAt = Date.now(); L.status = 'ready'; d.lessons = { old1: L }; d.order = ['old1']; d.todayLessonId = 'old1'; d.assignLog = [{ id: 'old1', at: Date.now() - 1000 }]; d.settings.learnerName = 'Aanya'; d.settings.welcomed = true; return d; }, L);
  await page.evaluate(s => { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(s)); }, st);
  await page.reload();
  await kidLogin(page);
  eq(await page.evaluate(() => S.week.core), ['old1'], 'migrated');
  ok((await text(page)).includes('Topic Old'), 'kid sees it');
  return page;
});

test('Mom "START" on a lesson hands it to Aanya and puts it in the week', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => go('summary', { id }), ids[0]);
  await act(page, 'startLesson', ids[0]);
  eq(await page.evaluate(() => role), 'kid', 'switched to Aanya');
  eq(await page.evaluate(() => S.week.core), ids, 'in the week');
  await act(page, 'kidStart', ids[0]);
  eq(await play(page, { minutes: 10 }), 'reward', 'played');
  return page;
});

test('4-week chart on Mom home and report has the right counts', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  // results: 4 in week of Oct 19, 1 in Oct 26, 3 + 1 short in Nov 2, 2 this week
  await page.evaluate(() => {
    const mk = (d, h, min) => ({ id: uid(), lessonId: 'x', title: 'x', subject: 'math', at: new Date(2026, 9, d, h).getTime(), minutes: min, mastery: 80, masteryTotal: 3, masteryRight: 2, checkRight: 2, checkTotal: 3, practiceRight: 1, practiceTotal: 1, maxTier: 1, breakdown: [], points: 0, accepted: true, causes: {}, missed: [], flagged: [], expectations: [], byExp: {}, pencil: [] });
    S.results = [mk(19, 10, 20), mk(20, 10, 20), mk(21, 10, 20), mk(25, 21, 20), mk(27, 10, 20), mk(33, 10, 20), mk(34, 10, 20), mk(35, 10, 20), mk(36, 10, 3), mk(40, 10, 20), mk(41, 10, 20)].reverse();
    save(); go('report');
  });
  eq(await page.evaluate(() => weekList(4).map(w => w.count)), [4, 1, 3, 2], 'counts per week');
  eq(await page.evaluate(() => weekList(4).map(w => w.short)), [0, 0, 1, 0], 'short lessons tracked');
  const t = await text(page);
  ok(t.includes('1 very short lesson'), 'report notes the short lesson');
  ok(t.includes('2 of 3 this week'), 'status line');
  return page;
});

/* =========================================================
   Fixes from the 2026-11-16 review
   ========================================================= */
test('points: short lessons pay nothing, a lesson pays once a week, lesson part scales with the score', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  const all = ['Which shows three quarters?', 'What is 10 - 4?', 'How many halves make a whole?', 'Which is one half?', 'What is 3 + 4?', 'Name the top number of a fraction.', 'Put in order, smallest first.', 'Match each fraction to its word.', 'Sort them.', 'Shade three quarters.', 'Place one half.'];
  // the exploit from the review: every answer wrong, about a minute a run
  for (let i = 0; i < 3; i++) { const r = await kidDoes(page, ids[0], { minutes: 1, wrong: all }); eq(r.points, 0, 'farming run ' + (i + 1) + ' pays 0'); }
  ok((await text(page)).includes('at least 8 minutes'), 'reward screen says why');
  const r1 = await kidDoes(page, ids[0], { minutes: 10, wrong: all });
  eq(r1.breakdown, [['Lesson complete (score 0%)', 50]], 'a real try with 0% still earns the finishing half');
  await momLogin(page);
  await page.evaluate(id => { S.week.core = S.week.core.filter(x => x !== id); go('lessons'); }, ids[0]); // Mom tries to add it again the same week
  await act(page, 'assignLesson', ids[0]);
  ok(!(await S(page, 'S.week.core')).includes(ids[0]), 'a lesson done this week cannot be added again');
  await kidLogin(page);
  const r3 = await kidDoes(page, ids[1], { minutes: 10, wrong: ['What is 10 - 4?'] });
  eq(r3.breakdown[0], ['Lesson complete (score 67%)', 84], 'score-scaled: 50 + 50 × 67%');
  eq(await page.evaluate(() => [S.points.balance, pendingPts()]), [0, 50 + r3.points], 'nothing paid until Mom accepts');
  ok((await text(page)).length > 0, 'ok');
  await page.evaluate(() => go('kidHome'));
  ok((await text(page)).includes('waiting for Mom'), 'Aanya sees points waiting');
  return page;
});

test('Mom accepts or refuses results; only accepted points reach the balance', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B', 'Topic C']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  const a = await kidDoes(page, ids[0], { minutes: 10 });
  const b = await kidDoes(page, ids[1], { minutes: 10 });
  const c = await kidDoes(page, ids[2], { minutes: 10 });
  await momLogin(page);
  ok((await text(page)).includes('3 results to check'), 'Mom home strip');
  await page.evaluate(id => go('result', { id }), c.id);
  await act(page, 'rejectResult', c.id);
  await page.evaluate(() => go('results'));
  ok((await text(page)).includes(`${a.points + b.points} points are waiting`), 'waiting total shown');
  await act(page, 'acceptAll');
  eq(await page.evaluate(() => [S.points.balance, pendingPts()]), [a.points + b.points, 0], 'accepted two, refused one');
  await page.evaluate(() => go('rewards'));
  ok((await text(page)).includes('Lesson: Topic A'), 'history lists the paid lesson');
  return page;
});

test('self-grading: pencil and "means the same" earn nothing, Mom sees self-corrections', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  // play until the short question, answer it wrong, then tap "My answer means the same thing"
  eq(await play(page, { minutes: 0, stopAt: 'short' }), 'stopped', 'reached the short question');
  const before = await page.evaluate(() => S.attempt.pts);
  await page.fill('#shortIn', 'the top one'); await act(page, 'answerShort');
  await act(page, 'meantThat');
  eq(await page.evaluate(() => S.attempt.pts), before, 'no points for a self-correction');
  ok(await page.evaluate(() => S.review.some(r => r.q.prompt === 'Name the top number of a fraction.')), 'the mistake stays in her review');
  ok(await page.evaluate(() => S.notebook.some(n => n.q.prompt === 'Name the top number of a fraction.')), 'and in her notebook');
  await play(page, { minutes: 12 });
  const r = await S(page, 'S.results[0]');
  eq(r.selfCorrected.map(x => x.given), ['the top one'], 'recorded on the result');
  ok(!r.breakdown.some(x => /Pencil/.test(x[0])), 'no pencil points');
  await momLogin(page);
  await page.evaluate(id => go('result', { id }), r.id);
  ok((await text(page)).includes('She marked this right herself'), 'Mom sees it before accepting (in the folded practice list)');
  return page;
});

test('flags: one per lesson; "It’s fine" puts the question back into her review', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  await play(page, { minutes: 0, stopAt: 'mcq' });
  const q = await page.evaluate(() => { const q = curQ(); return { choices: q.choices, answer: q.answer }; });
  await act(page, 'answerMcq', String(q.choices.findIndex(c => c !== q.answer))); // gets it wrong, then says the key is wrong
  await act(page, 'flagQ');
  await play(page, { minutes: 0, stopAt: 'numeric' });
  eq(await page.locator('[data-a="flagQ"]').count(), 0, 'no second flag button');
  await page.evaluate(() => A.flagQ());
  eq(await page.evaluate(() => S.flags.length), 1, 'second flag refused');
  await play(page, { minutes: 12 });
  await momLogin(page);
  await page.evaluate(() => go('flags'));
  await act(page, 'flagKeep');
  eq(await page.evaluate(() => S.review.some(r => r.q.prompt === 'Which is one half?')), true, 'back in her review');
  return page;
});

test('mistakes notebook no longer shows the answers', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10, wrong: ['What is 3 + 4?'] });
  await page.evaluate(() => go('notebook'));
  const t = await text(page);
  ok(t.includes('What is 3 + 4?') && t.includes('missed 1×'), 'mistake listed');
  ok(!/answer:\s*7/.test(t), 'answer hidden');
  return page;
});

test('PIN: 3 wrong tries lock it for 30 s, then 60 s; the lock survives a reload', async () => {
  const page = await open();
  await momSetup(page, '1357');
  const wrong = async () => { await page.evaluate(() => { role = null; go('gate'); }); await act(page, 'pickMom'); for (const d of '0000') await act(page, 'pinKey', d); await page.waitForTimeout(200); };
  for (let i = 0; i < 3; i++) await wrong();
  ok((await text(page)).includes('Too many wrong tries'), 'locked after 3');
  for (const d of '1357') await act(page, 'pinKey', d);
  await page.waitForTimeout(200);
  eq(await page.evaluate(() => role), null, 'right PIN refused while locked');
  await page.reload();
  await act(page, 'pickMom');
  ok((await text(page)).includes('Too many wrong tries'), 'still locked after reload');
  await tick(page, 31e3);
  await wrong();
  await tick(page, 31e3);
  await page.evaluate(() => { go('pin', { mode: 'enter' }); });
  ok((await text(page)).includes('Too many wrong tries'), '4th miss locks for 60 s');
  await tick(page, 30e3);
  await page.evaluate(() => { go('pin', { mode: 'enter' }); });
  for (const d of '1357') await act(page, 'pinKey', d);
  await page.waitForFunction(() => role === 'mom');
  eq(await page.evaluate(() => S.settings.pinFails), 0, 'a correct PIN resets the count');
  return page;
});

test('PIN: Mom can choose 6 digits', async () => {
  const page = await open();
  await act(page, 'pickMom');
  await act(page, 'pinLenToggle');
  for (const d of '246810') await act(page, 'pinKey', d);
  await page.waitForFunction(() => view.p.mode === 'set2');
  for (const d of '246810') await act(page, 'pinKey', d);
  await page.waitForFunction(() => view.name === 'welcome');
  await act(page, 'welcomeSkip');
  await page.evaluate(() => { role = null; go('gate'); });
  await act(page, 'pickMom');
  eq(await page.locator('.dots span').count(), 6, 'six dots');
  for (const d of '246810') await act(page, 'pinKey', d);
  await page.waitForFunction(() => role === 'mom');
  return page;
});

test('rate changes are written to the history Mom sees', async () => {
  const { page } = await freshWithLessons([]);
  await page.evaluate(() => go('rewards'));
  await page.fill('#rateIn', '1'); await act(page, 'saveRate');
  ok((await text(page)).includes('Rate changed: 100 → 1 points per $1'), 'logged');
  return page;
});

test('backup: Mom gets a one-tap reminder each new week', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10 });
  await momLogin(page);
  ok((await text(page)).includes('New week: save a backup'), 'reminder before the first backup');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.strip[data-a="exportData"]').evaluate(e => e.click())]);
  ok(dl.suggestedFilename().includes('balance-'), 'downloaded');
  await page.waitForTimeout(100);
  ok(!(await text(page)).includes('New week: save a backup'), 'gone once saved');
  await setTime(page, new Date(2026, 10, 16, 8, 0).getTime());
  await page.evaluate(() => go('momHome'));
  ok((await text(page)).includes('New week: save a backup'), 'back on Monday');
  return page;
});

test('answer-key check: a disagreement blocks the lesson until Mom decides', async () => {
  const page = await open();
  await momSetup(page);
  page.badKeys = ['What is 3 + 4?', 'How many halves make a whole?', 'What is 10 - 4?'];
  const id = await makeLesson(page, 'Topic Keys');
  ok((await text(page)).includes('Check 3 answers first'), 'Mom is shown the 3 disagreements');
  await page.evaluate(id => go('lessons'), id);
  await act(page, 'assignLesson', id);
  eq(await page.evaluate(() => S.week.core), [], 'cannot go into the week yet');
  await page.evaluate(id => go('summary', { id }), id);
  const q1 = await page.evaluate(id => S.lessons[id].keyCheck.issues[0].qid, id);
  const q2 = await page.evaluate(id => S.lessons[id].keyCheck.issues[1].qid, id);
  const q3 = await page.evaluate(id => S.lessons[id].keyCheck.issues[2].qid, id);
  await act(page, 'keyRemove', `${id}:${q1}`);
  await act(page, 'keyRemove', `${id}:${q2}`); // check 3 -> 2
  await act(page, 'keyRemove', `${id}:${q3}`); // refused: a lesson keeps at least 2 check questions
  eq(await page.evaluate(id => S.lessons[id].check.length, id), 2, 'check keeps at least 2');
  await act(page, 'keyOk', `${id}:${q3}`);
  eq(await page.evaluate(([id, q]) => S.lessons[id].practice.some(x => x.id === q), [id, q1]), false, 'practice question removed');
  ok((await text(page)).includes('Answer keys double-checked'), 'all decided');
  await page.evaluate(() => go('lessons'));
  await act(page, 'assignLesson', id);
  eq(await page.evaluate(() => S.week.core), [id], 'now it can go in');
  return page;
});

test('answer-key check: if the check fails, the lesson still works and can be re-checked', async () => {
  const page = await open();
  await momSetup(page);
  page.keyCheckFails = true; page.allowErrors = /status of 500/;
  const id = await makeLesson(page, 'Topic Offline');
  ok((await text(page)).includes('didn’t run'), 'Mom told');
  await page.evaluate(() => go('lessons'));
  await act(page, 'assignLesson', id);
  eq(await page.evaluate(() => S.week.core), [id], 'not blocked');
  page.keyCheckFails = false;
  await page.evaluate(id => go('summary', { id }), id);
  await act(page, 'keyRecheck', id);
  await page.waitForFunction(id => S.lessons[id].keyCheck.status === 'ok', id);
  return page;
});

test('questions she got right 1-4 weeks ago come back in the warm-up', async () => {
  const { page, ids } = await freshWithLessons(['Topic Old', 'Topic New']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await setTime(page, WED - 10 * DAY);
  await page.evaluate(() => ensureWeek());
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10 });
  await setTime(page, WED);
  await page.evaluate(id => { ensureWeek(); addToWeek(id, true); go('kidHome'); }, ids[1]);
  await act(page, 'kidStart', ids[1]);
  const warm = await page.evaluate(() => S.attempt.steps.filter(s => s.k === 'warm').map(s => S.review.find(r => r.id === s.id)));
  eq(warm.length, 2, 'two old questions in the warm-up');
  ok(warm.every(r => r.refresh && r.lessonId !== S), 'they are refresh questions');
  eq(await page.evaluate(() => dueReviews().length), 0, 'not counted as mistakes to review');
  const wrongPrompt = warm[0].q.prompt;
  await play(page, { minutes: 12, wrong: [wrongPrompt] });
  const rv = await page.evaluate(() => S.review.map(r => [r.q.prompt, !!r.refresh]));
  ok(rv.some(([p, f]) => p === wrongPrompt && !f), 'the missed one is now a normal review item');
  ok(!rv.some(([p]) => p === warm[1].q.prompt && warm[1].q.prompt !== wrongPrompt), 'the right one is gone');
  ok(await page.evaluate(p => S.notebook.some(n => n.q.prompt === p), wrongPrompt), 'and in the notebook');
  return page;
});

test('redo: Mom can get brand-new questions (fresh ids, answer keys checked)', async () => {
  const { page, ids } = await freshWithLessons(['Topic Redo']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await kidDoes(page, ids[0], { minutes: 10 });
  await momLogin(page);
  const before = await page.evaluate(id => S.lessons[id].practice.map(q => q.id), ids[0]);
  await page.evaluate(id => go('summary', { id }), ids[0]);
  await act(page, 'freshQs', ids[0]);
  await page.waitForFunction(id => S.lessons[id].qVersion === 2, ids[0], { timeout: 10000 });
  const L = await page.evaluate(id => S.lessons[id], ids[0]);
  ok(L.practice.every(q => !before.includes(q.id)), 'new question ids');
  eq(L.keyCheck.status, 'ok', 'keys checked');
  return page;
});

const WAKE_STUB = () => { window.__wake = { req: 0, rel: 0 }; Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.req++; return { release: async () => { window.__wake.rel++; } }; } } }); };

test('writing a lesson keeps the screen awake, then lets it sleep', async () => {
  const page = await open({ init: WAKE_STUB });
  await momSetup(page);
  await makeLesson(page, 'Topic Awake');
  eq(await page.evaluate(() => window.__wake), { req: 1, rel: 1 }, 'wake lock taken and released');
  return page;
});

test('if the iPad sleeps mid-writing, Mom is told that instead of "check the Wi-Fi"', async () => {
  const page = await open({ init: WAKE_STUB });
  await momSetup(page);
  page.dropWhileHidden = true; page.allowErrors = /ERR_CONNECTION_RESET|Failed to load/;
  await page.evaluate(() => go('momHome'));
  await act(page, 'newLesson');
  await page.fill('#nlTopic', 'Topic Sleepy');
  await act(page, 'generate');
  await page.waitForFunction(() => GEN && GEN.status === 'error', null, { timeout: 10000 });
  const t = await text(page);
  ok(t.includes('went to sleep or another app was opened'), 'clear message: ' + t.slice(0, 200));
  ok(!t.includes('Check the Wi-Fi'), 'does not blame the Wi-Fi');
  eq(await page.evaluate(() => window.__wake.rel), 1, 'wake lock released');
  return page;
});

test('Settings suggests a dedicated key with a spend limit', async () => {
  const page = await open();
  await momSetup(page);
  await page.evaluate(() => go('settings'));
  ok((await text(page)).includes('monthly spend limit'), 'advice shown');
  return page;
});

test('offline: the app opens from cache when there is no internet (service worker)', async () => {
  const http = require('http');
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const f = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': f.endsWith('.js') ? 'text/javascript' : 'text/html' }); fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${server.address().port}/index.html`;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.errors = [];
  try {
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await ctx.setOffline(true);
    await page.reload();
    ok((await page.locator('#app').textContent()).includes('Who’s using this?'), 'app opened offline');
    const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
    ok(/url\.origin !== self\.location\.origin\) return/.test(sw), 'never handles other sites (Claude calls)');
  } finally { await ctx.setOffline(false); server.close(); }
  return page;
});

/* =========================================================
   Sync between devices (fake GitHub gist shared by two browsers)
   ========================================================= */
const GOOD_TOKEN = 'github_pat_test_good';
class FakeGist {
  constructor() { this.gists = {}; this.token = GOOD_TOKEN; this.n = 0; this.gets = 0; this.staleOnce = false; }
  view(id, upto) {
    const g = this.gists[id], vs = g.versions.slice(0, upto == null ? g.versions.length : upto);
    const cur = vs[vs.length - 1];
    return { id, files: { 'tutor-sync.txt': { content: cur.content, truncated: false, raw_url: 'https://gist.example/raw' } }, history: vs.slice().reverse().map(v => ({ version: v.version })) };
  }
  latest(id) { return this.gists[id].versions[this.gists[id].versions.length - 1].content; }
  async attach(page) {
    await page.context().route('https://api.github.com/**', async route => {
      const req = route.request(), url = new URL(req.url()), m = req.method();
      const reply = (status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
      if (req.headers().authorization !== 'Bearer ' + this.token) return reply(401, { message: 'Bad credentials' });
      const parts = url.pathname.split('/').filter(Boolean); // gists, id, ver
      if (m === 'POST' && parts.length === 1) {
        const id = 'gist' + (++this.n), content = JSON.parse(req.postData()).files['tutor-sync.txt'].content;
        this.gists[id] = { versions: [{ version: id + '-v1', content }] };
        return reply(201, this.view(id));
      }
      const g = this.gists[parts[1]];
      if (!g) return reply(404, { message: 'Not Found' });
      if (m === 'GET' && parts.length === 3) { this.byVersion = (this.byVersion || 0) + 1; const i = g.versions.findIndex(v => v.version === parts[2]); return reply(200, this.view(parts[1], i + 1)); }
      if (m === 'GET') { this.gets++; if (this.staleOnce) { this.staleOnce = false; return reply(200, this.view(parts[1], g.versions.length - 1)); } return reply(200, this.view(parts[1])); }
      if (m === 'PATCH') {
        g.versions.push({ version: parts[1] + '-v' + (g.versions.length + 1), content: JSON.parse(req.postData()).files['tutor-sync.txt'].content });
        return reply(200, this.view(parts[1]));
      }
      return reply(405, {});
    });
  }
}
/* Laptop: Mom turns sync on through Settings. Returns the setup code. */
async function turnOnSync(page, gist) {
  await gist.attach(page);
  await page.evaluate(() => go('settings'));
  await page.fill('[data-bind="SY:token"]', GOOD_TOKEN);
  await act(page, 'syncStart');
  await page.waitForFunction(() => S.settings.sync && S.settings.sync.gist);
  await page.evaluate(() => { S.settings.sync.auto = false; save(); }); // tests sync by hand, at exact moments
  return page.evaluate(() => setupCode(S.settings.sync));
}
/* iPad: a fresh device joins from the first screen with the setup code. */
async function joinSync(gist, code, opts = {}) {
  const page = await open(opts);
  await gist.attach(page);
  ok((await text(page)).includes('Already set up on another device?'), 'fresh device offers to join');
  await act(page, 'go', 'join');
  await page.fill('#syncCode', code);
  await act(page, 'syncJoin');
  await page.waitForFunction(() => view.name === 'gate' && S.settings.sync && S.settings.sync.last > 0);
  await page.evaluate(() => { S.settings.sync.auto = false; save(); });
  return page;
}
const sync = page => page.evaluate(() => syncNow());
async function closeOther(p) { if (p) await p.context().close().catch(() => {}); }

test('sync: lessons made on the laptop show up on the iPad, with the key, PIN and points; GitHub only sees locked data', async () => {
  const gist = new FakeGist();
  const { page: laptop, ids } = await freshWithLessons(['Topic Synced A', 'Topic Synced B']);
  // An older save: the points log was trimmed, so it doesn't add up to her balance on its own.
  await laptop.evaluate(ids => { ids.forEach(id => addToWeek(id, true)); S.points.balance = 500; S.points.earned = 650; save(); }, ids);
  const code = await turnOnSync(laptop, gist);
  ok((await text(laptop)).includes('Sync is on') && (await text(laptop)).includes('TUTOR1-'), 'Mom sees the setup code');
  const stored = gist.latest('gist1');
  ok(/^ATS1\./.test(stored), 'shared copy is locked');
  for (const secret of ['Topic Synced', 'sk-ant', 'Aanya', GOOD_TOKEN]) ok(!stored.includes(secret), 'GitHub cannot read: ' + secret);
  let ipad;
  try {
    ipad = await joinSync(gist, code);
    const st = await S(ipad);
    eq(st.week.core, ids, 'same week plan on the iPad');
    eq(st.order.length, 2, 'both lessons');
    eq(st.settings.apiKey, 'sk-ant-test-key', 'Claude key came along');
    eq(st.settings.learnerName, 'Aanya', 'name came along');
    eq([st.points.balance, st.points.earned], [500, 650], 'balance came along');
    ok(!st.settings.sync.token.includes(' ') && st.settings.sync.device !== (await laptop.evaluate(() => S.settings.sync.device)), 'each device has its own id');
    await momLogin(ipad); // the laptop's PIN works here
    await kidLogin(ipad);
    ok((await text(ipad)).includes('Topic Synced A'), 'Aanya sees the lesson');
    // A join link opened in Safari fills the code in for her.
    const third = await open();
    await third.goto('about:blank');
    await third.goto(FILE + '#join=' + encodeURIComponent(code));
    eq(await third.evaluate(() => [view.name, $('#syncCode').value, location.hash]), ['join', code, ''], 'link opens Join with the code, and the code leaves the address bar');
    await closeOther(third);
    // A wrong code is refused and nothing is changed.
    const bad = await open(); await gist.attach(bad);
    await act(bad, 'go', 'join'); await bad.fill('#syncCode', 'TUTOR1-garbage'); await act(bad, 'syncJoin');
    eq(await bad.evaluate(() => S.settings.sync), null, 'bad code: not joined');
    await closeOther(bad);
  } finally { await closeOther(ipad); }
  return laptop;
});

test('sync: she finishes on the iPad while Mom accepts on both; points are never lost or doubled', async () => {
  const gist = new FakeGist();
  const { page: laptop, ids } = await freshWithLessons(['Topic One', 'Topic Two', 'Topic Three']);
  await laptop.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  const code = await turnOnSync(laptop, gist);
  let ipad;
  try {
    ipad = await joinSync(gist, code);
    await kidLogin(ipad);
    const r0 = await kidDoes(ipad, ids[0], { minutes: 12 });
    await sync(ipad); await sync(laptop);
    eq(await laptop.evaluate(() => [S.results.length, pendingPts()]), [1, r0.points], 'laptop sees the pending result');
    // Both devices act before syncing again.
    await laptop.evaluate(id => { A.acceptResult(id); FORMS.RW = { rname: 'Movie night', rpts: '300' }; A.redeemAdd(); }, r0.id);
    await ipad.evaluate(id => A.acceptResult(id), r0.id);
    await kidLogin(ipad);
    const r1 = await kidDoes(ipad, ids[1], { minutes: 12 });
    await sync(ipad); await sync(laptop); await sync(ipad);
    for (const [name, p] of [['laptop', laptop], ['iPad', ipad]]) {
      const st = await S(p);
      eq(st.points.balance, r0.points, name + ': lesson 1 paid exactly once');
      eq(st.points.log.filter(x => x.id === 'acc-' + r0.id).length, 1, name + ': one payment in the history');
      eq(st.results.map(r => r.id).sort(), [r0.id, r1.id].sort(), name + ': both results kept');
      eq(await p.evaluate(() => pendingPts()), r1.points, name + ': lesson 2 still waiting for Mom');
      eq(st.redeemables.map(r => r.name), ['Movie night'], name + ': reward made on the laptop');
    }
    // Mom pays out on the laptop while accepting lesson 2 on the iPad.
    await laptop.evaluate(() => go('rewards')); await laptop.fill('#payIn', '1'); await act(laptop, 'payOut');
    await ipad.evaluate(id => A.acceptResult(id), r1.id);
    await sync(laptop); await sync(ipad); await sync(laptop);
    const want = r0.points + r1.points - 100;
    eq(await laptop.evaluate(() => S.points.balance), want, 'laptop: both changes count');
    eq(await ipad.evaluate(() => S.points.balance), want, 'iPad: both changes count');
  } finally { await closeOther(ipad); }
  return laptop;
});

test('sync: two devices saving at the same moment are combined, not overwritten', async () => {
  const gist = new FakeGist();
  const { page: laptop } = await freshWithLessons(['Topic Base']);
  const code = await turnOnSync(laptop, gist);
  let ipad;
  try {
    ipad = await joinSync(gist, code);
    const [x] = await seedLessons(laptop, ['Topic Laptop']);
    await laptop.evaluate(() => save());
    await sync(laptop);
    // The iPad read the shared copy just before the laptop's save landed, then saves its own change.
    gist.staleOnce = true;
    await ipad.evaluate(() => { S.redeemables.push({ id: 'r1', name: 'Ice cream', points: 200 }); save(); });
    await sync(ipad);
    eq(gist.byVersion, 1, 'iPad noticed the laptop wrote in between and fetched its copy');
    await sync(laptop);
    for (const [name, p] of [['laptop', laptop], ['iPad', ipad]]) {
      const st = await S(p);
      ok(!!st.lessons[x], name + ': lesson made on the laptop survived');
      eq(st.redeemables.map(r => r.name), ['Ice cream'], name + ': reward made on the iPad survived');
    }
  } finally { await closeOther(ipad); }
  return laptop;
});

test('sync: deleting on one device deletes on the other; a restored backup only adds', async () => {
  const gist = new FakeGist();
  const { page: laptop, ids } = await freshWithLessons(['Topic Keep', 'Topic Drop']);
  const code = await turnOnSync(laptop, gist);
  let ipad;
  try {
    ipad = await joinSync(gist, code);
    await laptop.evaluate(id => { delete S.lessons[id]; S.order = S.order.filter(x => x !== id); save(); }, ids[1]);
    await sync(laptop); await sync(ipad);
    eq(await ipad.evaluate(() => S.order), [ids[0]], 'iPad: deleted lesson is gone');
    // The iPad restores an old backup that still has the deleted lesson and is missing a new result.
    await ipad.evaluate(() => { S.results.unshift({ id: 'res-new', lessonId: 'z', title: 'New', subject: 'math', at: Date.now(), points: 0, accepted: true }); save(); });
    await sync(ipad); await sync(laptop);
    await ipad.evaluate(([keep, drop]) => {
      const old = JSON.parse(JSON.stringify(S)); old.results = []; old.order = [keep, drop]; old.lessons[drop] = JSON.parse(JSON.stringify(old.lessons[keep])); old.lessons[drop].id = drop;
      S = Object.assign(DEFAULT_STATE(), old); syncForgetBase(); save(); // what importData does
    }, ids);
    await sync(ipad); await sync(laptop);
    for (const [name, p] of [['laptop', laptop], ['iPad', ipad]]) {
      const st = await S(p);
      ok(st.results.some(r => r.id === 'res-new'), name + ': restore did not remove a newer result');
      ok(st.order.includes(ids[1]), name + ': restore brought the old lesson back (adds only)');
    }
  } finally { await closeOther(ipad); }
  return laptop;
});

test('sync: waits while she is in a lesson, then catches up', async () => {
  const gist = new FakeGist();
  const { page: laptop, ids } = await freshWithLessons(['Topic Now', 'Topic Later']);
  await laptop.evaluate(id => addToWeek(id, true), ids[0]);
  const code = await turnOnSync(laptop, gist);
  let ipad;
  try {
    ipad = await joinSync(gist, code);
    await kidLogin(ipad);
    await ipad.evaluate(() => go('kidHome'));
    await act(ipad, 'kidStart', ids[0]);
    await laptop.evaluate(id => addToWeek(id, true), ids[1]);
    await sync(laptop);
    const before = gist.gets;
    eq(await sync(ipad), false, 'no sync mid-lesson');
    eq(gist.gets, before, 'did not even fetch');
    await play(ipad, { minutes: 12 });
    await sync(ipad);
    eq((await S(ipad)).week.core, ids, 'after the lesson, the laptop’s new slot is there');
    ok((await S(ipad)).results.length === 1 && (await S(laptop)).week.core.length === 2, 'her result kept, laptop plan kept');
    await sync(laptop);
    eq((await S(laptop)).results.length, 1, 'laptop gets her result');
  } finally { await closeOther(ipad); }
  return laptop;
});

test('sync: a deleted token is shown to Mom, and the app keeps working', async () => {
  const gist = new FakeGist();
  const { page: laptop, ids } = await freshWithLessons(['Topic Token']);
  await turnOnSync(laptop, gist);
  laptop.allowErrors = /401|ERR_INTERNET_DISCONNECTED|Failed to fetch/;
  gist.token = 'revoked';
  await sync(laptop);
  await laptop.evaluate(() => go('momHome'));
  ok((await text(laptop)).includes('Sync isn’t working: the GitHub token was deleted or expired'), 'Mom home says why');
  await laptop.evaluate(id => addToWeek(id, true), ids[0]);
  eq((await S(laptop)).week.core, ids, 'still works on this device');
  // No internet is only mentioned after a day.
  gist.token = GOOD_TOKEN; await sync(laptop);
  await laptop.context().setOffline(true);
  await sync(laptop);
  await laptop.evaluate(() => go('momHome'));
  ok(!(await text(laptop)).includes('Sync isn’t working'), 'a short time offline is not an alarm');
  await laptop.context().setOffline(false);
  // A bad token when turning sync on is explained.
  const other = await open(); await gist.attach(other); await momSetup(other);
  await other.evaluate(() => go('settings')); await other.fill('[data-bind="SY:token"]', 'nope');
  const msgs = []; other.removeAllListeners('dialog'); other.on('dialog', d => { msgs.push(d.message()); d.accept(); });
  await act(other, 'syncStart'); await other.waitForTimeout(300);
  ok(msgs.some(m => /token was deleted or expired/.test(m)), 'bad token explained: ' + msgs.join(' | '));
  await closeOther(other);
  return laptop;
});

test('sync: changes go up by themselves a moment after saving', async () => {
  const gist = new FakeGist();
  const { page } = await freshWithLessons(['Topic Auto']);
  await turnOnSync(page, gist);
  await page.evaluate(() => { S.settings.sync.auto = true; save(); });
  const n = gist.gists.gist1.versions.length;
  await seedLessons(page, ['Topic Auto Two']);
  await page.evaluate(() => save());
  for (let i = 0; i < 40 && gist.gists.gist1.versions.length === n; i++) await page.waitForTimeout(100);
  ok(gist.gists.gist1.versions.length > n, 'saved to the shared copy without tapping anything');
  return page;
});

test('sync: merge rules (append-only results and ledger, deletions, lists)', async () => {
  const page = await open();
  const r = await page.evaluate(() => {
    const b = { results: [{ id: 'a', at: 1 }], order: ['x', 'y'], lessons: { x: { t: 1 }, y: { t: 1 } }, points: { log: [{ id: 'p1', t: 1, n: 5 }] } };
    const l = { results: [{ id: 'b', at: 2 }], order: ['x'], lessons: { x: { t: 2 } }, points: { log: [{ id: 'p1', t: 1, n: 5 }, { id: 'p2', t: 2, n: 7 }] } };
    const rr = { results: [{ id: 'a', at: 1, accepted: true }], order: ['x', 'y', 'z'], lessons: { x: { t: 1 }, y: { t: 1 }, z: { t: 3 } }, points: { log: [{ id: 'p2', t: 2, n: 7 }, { id: 'p3', t: 3, n: -2 }] } };
    return merge3(b, l, rr, '', 'l');
  });
  eq(r.results.map(x => x.id), ['b', 'a'], 'results never removed by the other side');
  eq(r.results[1].accepted, true, 'change to a kept result applied');
  eq(r.order, ['x', 'z'], 'y deleted on one side, z added on the other');
  eq(Object.keys(r.lessons).sort(), ['x', 'z'], 'lessons follow');
  eq(r.lessons.x.t, 2, 'edit kept');
  eq(r.points.log.map(x => x.id), ['p1', 'p2', 'p3'], 'ledger: union by id, no duplicates');
  return page;
});

/* =========================================================
   v18: only the final test counts; Mom's review screen
   ========================================================= */
const ALL_PRACTICE = ['Which is one half?', 'What is 3 + 4?', 'Name the top number of a fraction.', 'Put in order, smallest first.', 'Match each fraction to its word.', 'Sort them.', 'Shade three quarters.', 'Place one half.'];
test('practice mistakes change neither the score nor the points; only the final test does', async () => {
  const { page, ids } = await freshWithLessons(['Topic A', 'Topic B']);
  await page.evaluate(ids => ids.forEach(id => addToWeek(id, true)), ids);
  await kidLogin(page);
  const good = await kidDoes(page, ids[0], { minutes: 12 });
  const bad = await kidDoes(page, ids[1], { minutes: 12, wrong: ALL_PRACTICE });
  eq(bad.practiceRight, 0, 'every practice answer wrong');
  eq([bad.mastery, bad.checkRight, bad.checkTotal], [100, 3, 3], 'score is the test: 3 of 3');
  eq(bad.points, good.points, 'same points as a lesson with perfect practice');
  eq(bad.breakdown.map(x => x[0]), ['Lesson complete (score 100%)', 'Right on the final test', 'Perfect final test!'], 'breakdown names the test');
  return page;
});

test('Mom’s review: score on top, test answers next to the right answers (wrong first), paper work with expected answers, practice folded away', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 12, wrong: ['What is 10 - 4?', 'Which is one half?'] });
  eq([r.mastery, r.checkRight, r.checkTotal], [67, 2, 3], 'one wrong on the test');
  eq(r.paper.length, 1, 'paper task copied onto the result');
  await momLogin(page);
  await page.evaluate(() => go('results'));
  ok((await text(page)).includes('Test 67% (2 of 3)') && (await text(page)).includes('1 to go over'), 'list shows the test score');
  await act(page, 'openResult', r.id);
  const t = await text(page);
  ok(t.includes('67%') && t.includes('Final test: 2 of 3 right'), 'score at the top');
  ok(t.includes('1 wrong. Go over it with her'), 'plain verdict');
  // the wrong test question is the first card, with her answer and the correct one
  const first = await page.locator('.qalist').first().locator('.qa').first();
  const ft = await first.textContent();
  ok(ft.includes('What is 10 - 4?') && ft.includes('999') && ft.includes('Correct') && ft.includes('6'), 'wrong one first: question, her answer, correct answer: ' + ft);
  ok(await first.evaluate(e => e.classList.contains('bad')), 'marked as wrong');
  const testCards = await page.evaluate(() => [...document.querySelectorAll('#app > .qalist .qa')].map(e => e.className));
  eq(testCards.length, 3, 'all three test questions shown');
  ok(t.includes('Draw 1/2') && t.includes('half shaded') && t.includes('Expected'), 'paper questions with expected answers');
  ok(!(await page.locator('[data-a="pencilScore"]').count()), 'no marking of paper work');
  ok(await page.locator('details.more').first().evaluate(d => !d.open && d.textContent.includes('Practice and warm-up') && d.textContent.includes('Which is one half?')), 'practice is folded away, still there');
  ok(t.includes('not scored'), 'practice says it does not count');
  return page;
});

test('Aanya checks her paper against the answers without marking it', async () => {
  const { page, ids } = await freshWithLessons(['Topic A']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  for (let i = 0; i < 12; i++) { const k = await page.evaluate(() => S.attempt.steps[S.attempt.si].k); if (k === 'pencil') break; await tick(page, MIN); if (k === 'example') await act(page, (await page.locator('[data-a="revealStep"]').count()) ? 'revealStep' : 'next'); else await act(page, 'next'); }
  await tick(page, 46e3); await page.waitForFunction(() => !document.querySelector('#doneBtn').disabled); await act(page, 'pencilDone');
  const t = await text(page);
  ok(t.includes('half shaded') && t.includes('I checked my paper'), 'she sees the answers and one button');
  ok(!t.includes('How many did you get right'), 'no self-score');
  await act(page, 'pencilNext');
  eq(await page.evaluate(() => S.attempt.pencil), [{ i: 0 }], 'no count recorded');
  return page;
});

test('subject score = average of every final test, with the latest beside it', async () => {
  const { page } = await freshWithLessons(['Topic A']);
  await page.evaluate(() => {
    const mk = (d, right, total) => ({ id: uid(), sv: 2, lessonId: 'x', title: 'x', subject: 'math', at: new Date(2026, 9, d, 10).getTime(), minutes: 20, mastery: Math.round(100 * right / total), masteryTotal: total, masteryRight: right, checkRight: right, checkTotal: total, practiceRight: 0, practiceTotal: 8, maxTier: 1, breakdown: [], points: 0, accepted: true, causes: {}, missed: [], flagged: [], expectations: [], byExp: {}, pencil: [] });
    S.results = [mk(30, 2, 3), mk(10, 3, 3), mk(1, 1, 2)]; // newest first: 67, 100, 50
    save(); go('momHome');
  });
  eq(await page.evaluate(() => [subjStats('math').mastery, subjStats('math').latest]), [72, 67], 'plain average, latest');
  ok((await text(page)).includes('Tests 72% avg · last 67%'), 'Math tile');
  await page.evaluate(() => go('report'));
  ok((await text(page)).includes('average of 3 final tests · latest 67%'), 'report');
  return page;
});

test('migration: results saved by v17 are re-scored from the final test on load and on sync; points untouched', async () => {
  const old = (id, extra) => Object.assign({ id, lessonId: 'x', title: 'Old', subject: 'math', at: WED - 5 * DAY, minutes: 20, mastery: 100, masteryRight: 1, masteryTotal: 1, helpedCount: 2, allHelped: false, checkRight: 2, checkTotal: 3, practiceRight: 5, practiceTotal: 8, maxTier: 2, breakdown: [['Lesson complete (score 100%)', 100]], points: 140, accepted: false, pending: true, paid: true, causes: {}, missed: [{ sec: 'check', prompt: 'What is 10 - 4?', given: '5', answer: '6' }], flagged: [], expectations: [], byExp: {}, pencil: [{ i: 0, right: 2, of: 2 }] }, extra);
  const page = await open();
  await momSetup(page);
  const st = await page.evaluate(() => JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)));
  st.results = [old('r1'), old('r2', { checkTotal: 0, checkRight: 0, mastery: 0, masteryTotal: 0, masteryRight: 0 })];
  await page.evaluate(s => { localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(s)); load(); }, st);
  const r = await page.evaluate(() => S.results[0]);
  eq([r.mastery, r.masteryRight, r.masteryTotal, r.sv], [67, 2, 3, 2], 'was 100% (help-free only), now 67% (2 of 3 on the test)');
  eq([r.points, r.pending], [140, true], 'waiting points unchanged');
  eq(await page.evaluate(() => [S.results[1].mastery, S.results[1].sv]), [0, 2], 'a result with no test is left alone');
  eq(await page.evaluate(() => JSON.parse(localStorage.getItem(CONFIG.STORAGE_KEY)).results[0].mastery), 67, 'saved back to the iPad');
  await page.evaluate(() => { const r = S.results[0]; migrateResults(S.results); return r.mastery; });
  eq(await page.evaluate(() => S.results[0].mastery), 67, 'running it again changes nothing');
  // a v17 device sends an old-style result through sync
  await page.evaluate(o => { const m = syncData(S); m.results = [o].concat(m.results); applyShared(m); }, old('r3'));
  eq(await page.evaluate(() => S.results.find(x => x.id === 'r3').mastery), 67, 'synced result re-scored');
  // the review screen still works for the old result (missed questions only, paper from the lesson if it still exists)
  await page.evaluate(() => go('result', { id: 'r1' }));
  const t = await text(page);
  ok(t.includes('67%') && t.includes('What is 10 - 4?') && t.includes('older lesson'), 'older result opens: ' + t.slice(0, 200));
  return page;
});

/* ---------------- runner ---------------- */
(async () => {
  const filter = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
  browser = await chromium.launch();
  let pass = 0, fail = 0;
  for (const t of TESTS) {
    if (filter && !filter.test(t.name)) continue;
    const t0 = Date.now();
    let page;
    try {
      page = await t.fn();
      if (page && page.allowErrors) page.errors = page.errors.filter(e => !page.allowErrors.test(e));
      if (page && page.errors.length) throw new Fail('console errors: ' + page.errors.join(' | '));
      pass++; console.log(`  ✓ ${t.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      fail++; console.log(`  ✗ ${t.name}\n      ${e instanceof Fail ? e.message : e.stack}`);
    } finally { if (page) await page.context().close().catch(() => {}); }
  }
  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
