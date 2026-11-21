# csv-reader-speed-01 — fast drop-in for csv-reader 1.0.0

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/sixthin016/csv-reader-speed-01-run-20261121/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/sixthin016/csv-reader-speed-01-run-20261121/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A dependency-free, hand-written CSV reader that answers exactly as
[csv-reader 1.0.0](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
does on every case — including its broken-row policy (stray CRs, unterminated
quotes, quote junk, short and long rows) — and reads the text much faster
than the reference, which walks it one character at a time.

## Files

- `solve.js` — the reader. `run({text, header})` returns
  `{columns, rows, errors}`. No dependencies, no per-character loop on the
  hot paths: whole lines without quotes are split on commas in one pass, and
  each field is found with `indexOf` / `slice`.
- `main.ts` — the driver. It reads the case list from `MAKEFUN_INPUT_DIR`
  (or `/input`) and writes `answers.json` to `MAKEFUN_OUTPUT_DIR`
  (or `/output`).

## Usage

```js
import { run } from './solve.js';
run({ text: 'a,b\n1,2\n', header: true });
// { columns: ['a', 'b'], rows: [['1', '2']], errors: [] }
```

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=./out node main.ts
```

## Why it is fast

- **Whole-line fast path:** a record whose line holds no quote and no stray
  CR is split on commas in a single C++ pass instead of being read field by
  field.
- **Bulk field scans:** unquoted fields are located with `indexOf`, and
  quoted fields by searching for the closing quote, so a clean quoted field
  is one `slice`.
- **Rare paths stay rare:** only segments with line breaks inside quotes,
  doubled quotes, or stray CRs are walked character by character.
- V8's incremental marking is off, as the house driver runs it.
