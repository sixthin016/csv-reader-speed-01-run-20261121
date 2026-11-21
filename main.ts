// The program the harness runs: node /bot/main.ts (node22). It reads every case
// from /input/cases.json (a JSON array of {id, input}), answers each one alone
// and writes /output/answers.json: a JSON array of the answers, one per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// The fast path: the CSV parse runs in WebAssembly (csv.wasm, built from
// wasm/src/lib.rs — a byte-level transliteration of solve.js run()). The
// driver reads the cases file as bytes, finds each case's escaped "text"
// token, copies it into the module, and the module unescapes it, parses the
// CSV and writes the answer JSON straight into its output buffer. The driver
// never JSON.parses the 11 MB file, never builds the answer's objects, and
// never JSON.stringifies — the plain driver's time went to those two JSON
// conversions plus the object graph, not to the scan. Each answer is written
// to the output file as it comes back, so no 11 MB answer string is built
// either. solve.js run() stays as the fallback: a token the module cannot
// unescape, or a file shaped otherwise than {"text": "...", "header": ...},
// takes the plain path.

import { readFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too).
setFlagsFromString('--no-incremental-marking');

// solve.js run() is the fallback for a token the module cannot unescape and
// for a file shaped otherwise than {"text": "...", "header": ...}. It is
// imported lazily, only when the fallback runs, so the fast path never pays
// to parse and compile it.
let runFallback: ((input: unknown) => unknown) | null = null;
async function getRun(): Promise<(input: unknown) => unknown> {
  if (runFallback === null) {
    const mod = (await import(new URL('./solve.js', import.meta.url).href)) as {
      run: (input: unknown) => unknown;
    };
    runFallback = mod.run;
  }
  return runFallback;
}

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const TEXT_MARK = Buffer.from('"text"');
const HEADER_MARK = Buffer.from('","header"');

/** Skip blanks (space, tab, LF, CR) in the raw bytes from i. */
function skipBlanks(b: Buffer, i: number): number {
  while (b[i] === 32 || b[i] === 9 || b[i] === 10 || b[i] === 13) i++;
  return i;
}

const raw = readFileSync(join(INPUT_DIR, 'cases.json'));

const outFd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(outFd, '[');
let cases = 0;
let wasmCases = 0;
let fallbackCases = 0;

{
  const wasmBytes = readFileSync(new URL('./csv.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const exp = instance.exports as {
    memory: WebAssembly.Memory;
    init(): void;
    token_ptr(): number;
    token_capacity(): number;
    reserve_token(cap: number): void;
    output_ptr(): number;
    parse_case(token_len: number, header: number): number;
  };
  exp.init();

  let from = 0;
  for (;;) {
    const tKey = raw.indexOf(TEXT_MARK, from);
    if (tKey === -1) break;
    let i = skipBlanks(raw, tKey + 6);
    if (raw[i] !== 58) {
      from = tKey + 6;
      continue;
    }
    i = skipBlanks(raw, i + 1);
    if (raw[i] !== 34) {
      from = tKey + 6;
      continue;
    }
    const a = i + 1;
    // The text's closing quote is the one before ,"header": a raw quote
    // cannot sit inside the text, where every quote reads as \".
    const hMark = raw.indexOf(HEADER_MARK, a);
    if (hMark === -1) break;
    const b = hMark;
    let j = skipBlanks(raw, hMark + 10);
    if (raw[j] !== 58) break;
    j = skipBlanks(raw, j + 1);
    const header = raw.subarray(j, j + 4).toString() === 'true';
    if (!header && raw.subarray(j, j + 5).toString() !== 'false') break;
    const tokenLen = b - a;
    if (tokenLen > exp.token_capacity()) exp.reserve_token(tokenLen);
    // The memory buffer is re-fetched per case: a WASM memory grow detaches
    // the old one, and the token/output pointers are only valid against the
    // current buffer.
    const mem = new Uint8Array(exp.memory.buffer);
    mem.set(raw.subarray(a, b), exp.token_ptr());
    const outLen = exp.parse_case(tokenLen, header ? 1 : 0);
    if (cases > 0) writeSync(outFd, ',');
    if (outLen === 0) {
      // An escape the module does not handle: the plain reader for this case.
      const run = await getRun();
      const text = JSON.parse(raw.subarray(a - 1, b + 1).toString('utf8')) as string;
      writeSync(outFd, JSON.stringify(run({ text, header })));
      fallbackCases++;
    } else {
      const outPtr = exp.output_ptr();
      writeSync(outFd, Buffer.from(exp.memory.buffer, outPtr, outLen));
      wasmCases++;
    }
    cases++;
    from = b + 1;
  }
}

if (cases === 0) {
  // A file shaped otherwise than {"text": "...", "header": ...} takes the
  // plain path: JSON.parse the file, run each case, JSON.stringify.
  const run = await getRun();
  const parsed = JSON.parse(raw.toString('utf8')) as { id: string; input: unknown }[];
  for (let k = 0; k < parsed.length; k++) {
    if (k > 0) writeSync(outFd, ',');
    writeSync(outFd, JSON.stringify(run(parsed[k].input)));
    cases++;
  }
}

writeSync(outFd, ']');
closeSync(outFd);

if (process.env.MAKEFUN_BENCH === '1') {
  const u = process.cpuUsage();
  process.stderr.write(
    `bench cpu_ms=${((u.user + u.system) / 1000).toFixed(1)} cases=${cases} wasm=${wasmCases} fallback=${fallbackCases}\n`,
  );
}
