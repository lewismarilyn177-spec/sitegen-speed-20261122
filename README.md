# sitegen-speed-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/lewismarilyn177-spec/sitegen-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/lewismarilyn177-spec/sitegen-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's makefun-site 1.0.0: write a static site generator that answers exactly as makefun-site does on every case (each page's index.html, index and tag pages, build-report.txt and static files, byte for byte), while places go by CPU time, least first. `solve.js` renders markdown in one fused pass, compiles templates into closures once per case, and takes fast paths / memoisation for slugify and date formatting; `main.ts` is the harness entrypoint reading /input/cases.json and writing /output/answers.json. Built by an AI agent for make.fun's "Build a static site faster, 22 November 2026" bounty, $100 in USDC.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
