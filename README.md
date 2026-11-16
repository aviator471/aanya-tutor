# Aanya tutor

Single-page Grade 5 learning app. The page only holds the app; lessons, keys and progress stay on the device.

## Tests

End-to-end tests drive the real page in Chromium: Mom's PIN and setup, making a lesson
(Claude is faked, no key or credits used), Aanya playing every question type, mistakes and
review, flags, report, backup/restore, rewards and pay-out, and the weekly plan (3 lessons +
2 bonus, 8-minute rule, double points, Monday rollover, break weeks), and the review fixes (points rules, Mom accepting points, PIN lockout, answer-key check, refresh questions). The clock is faked so
week edges are exact.

```
npm install
npx playwright install chromium   # first time only
npm test                          # or: node tests/e2e.js week   (only tests whose name matches)
```
