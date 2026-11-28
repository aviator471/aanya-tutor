# Aanya tutor

Single-page Grade 5 learning app. The page only holds the app; lessons, keys and progress stay on the device, unless Mom turns on sync (Settings → Use on more devices), which keeps one locked copy in a secret gist on her GitHub account.

## Tests

End-to-end tests drive the real page in Chromium: Mom's PIN and setup, making a lesson
(Claude is faked, no key or credits used), Aanya playing every question type, mistakes and
review, flags, report, the final test (15 questions drawn from a 40-question bank, 10 from 24 for catch-up plan lessons, never fewer than 10: a lesson with a smaller bank can't be assigned or started until Mom builds it; its own sitting; right/wrong hidden until the end), pay from the final test only (a perfect test = $3, less = the same share, cap in dollars whatever the points rate), retests only Mom can give (new unseen questions, the replaced try unpaid, only the accepted test pays, at most 2), Mom’s review screen and test-only scoring (with the v17 → v18 re-scoring), backup/restore, rewards and pay-out, and the weekly plan (3 lessons +
2 bonus, 8-minute rule, bonus lessons paying the same as core, Monday rollover, break weeks), the review fixes (points rules, Mom accepting points, PIN lockout, answer-key check, refresh questions), and sync between two devices (a fake GitHub gist shared by two browsers: joining, points accepted on both devices, saves at the same moment, deletes, restores, mid-lesson waits, token errors, an unfinished lesson left open, a second shared copy, combining two copies). The clock is faked so
week edges are exact.

```
npm install
npx playwright install chromium   # first time only
npm test                          # or: node tests/e2e.js week   (only tests whose name matches)
```
