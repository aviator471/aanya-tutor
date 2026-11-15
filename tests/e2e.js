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
async function open({ time = WED, state, claudeCalls } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.setDefaultTimeout(6000);
  page.errors = [];
  page.on('pageerror', e => page.errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') page.errors.push(m.text()); });
  page.on('dialog', d => d.accept());
  page.calls = claudeCalls || [];
  await page.route('https://api.anthropic.com/**', async route => {
    const body = JSON.parse(route.request().postData() || '{}');
    page.calls.push(body.model);
    const all = JSON.stringify(body.messages);
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
async function play(page, { minutes = 15, wrong = [], explainDifferently = false, cause } = {}) {
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
    await tick(page, per);
    if (st.interject != null && st.k === 'practice' && !st.fb) { await act(page, 'endInterject'); continue; }
    if (st.k === 'explain') { if (explainDifferently) { explainDifferently = false; await act(page, 'explainDiff', '0'); await page.waitForFunction(() => !EXPLAINING); } await act(page, 'next'); continue; }
    if (st.k === 'passage') { await act(page, 'next'); continue; }
    if (st.k === 'example') { if (st.shown < st.ex) await act(page, 'revealStep'); else await act(page, 'next'); continue; }
    if (st.k === 'pencil') {
      if (st.phase === 'work') { await tick(page, 46e3); await page.waitForFunction(() => !document.querySelector('#doneBtn').disabled, null, { timeout: 5000 }); await act(page, 'pencilDone'); }
      else await act(page, 'pencilScore', '2');
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
  const pts = 100 + (r.practiceTotal + 3) * 5 + 2 * 5 + 50;
  eq(r.points, pts, 'points = lesson + answers + pencil + perfect check');
  eq(await page.evaluate(() => S.points.balance), pts, 'balance');
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

test('help-free mastery: "explain differently" (Haiku, faked) marks answers as helped', async () => {
  const { page, ids } = await freshWithLessons(['Topic Gamma']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  const r = await kidDoes(page, ids[0], { minutes: 15, explainDifferently: true, wrong: ['What is 10 - 4?'] });
  ok(page.calls.some(m => /haiku/.test(m)), 'Haiku called');
  eq(r.helpedCount, 2, 'two check questions used explain card 0');
  eq([r.masteryRight, r.masteryTotal], [1, 1], 'mastery uses only the help-free question');
  eq(r.explainUsed, 1, 'explain count');
  return page;
});

test('flag a question: not counted against her, Mom sees it', async () => {
  const { page, ids } = await freshWithLessons(['Topic Delta']);
  await page.evaluate(id => addToWeek(id, true), ids[0]);
  await kidLogin(page);
  await act(page, 'kidStart', ids[0]);
  // go to the first question and flag it
  for (let i = 0; i < 12; i++) { if (await page.locator('[data-a="flagQ"]').count()) break; await tick(page, MIN); const k = await page.evaluate(() => S.attempt.steps[S.attempt.si].k); if (k === 'example') await act(page, (await page.locator('[data-a="revealStep"]').count()) ? 'revealStep' : 'next'); else if (k === 'pencil') { await tick(page, 46e3); await page.waitForFunction(() => !document.querySelector('#doneBtn').disabled); await act(page, 'pencilDone'); await act(page, 'pencilScore', '2'); } else await act(page, 'next'); }
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
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
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
  for (const id of ids.slice(0, 3)) { const r = await kidDoes(page, id, { minutes: 10 }); eq(r.breakdown[0], ['Lesson complete', 100], 'core pays 100'); }
  const b = await kidDoes(page, ids[3], { minutes: 10 });
  eq(b.breakdown[0], ['Bonus lesson ×2', 200], 'bonus pays 200');
  ok(b.bonus, 'result marked bonus');
  ok((await text(page)).includes('Bonus lesson ×2'), 'shown on reward screen');
  const short = await kidDoes(page, ids[4], { minutes: 3 });
  eq(short.breakdown[0], ['Lesson complete', 100], 'a too-short bonus lesson gets no double');
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
