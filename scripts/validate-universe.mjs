/**
 * Validates every universe symbol against the CBOE delayed-quotes feed.
 * Run after editing src/lib/universe.ts:  node scripts/validate-universe.mjs
 * Prints any symbol that 404s/403s so it can be fixed or removed.
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/lib/universe.ts', import.meta.url), 'utf8');
const body = src.split('BY_SECTOR')[1] ?? src;
const symbols = [...new Set([...body.matchAll(/'([A-Z][A-Z0-9.]{0,6})'/g)].map((m) => m[1]))];
console.log(`checking ${symbols.length} symbols against CBOE…`);

const bad = [];
let done = 0;
// The CBOE CDN rate-limits aggressive bursts — pace politely and retry 429s.
const CONCURRENCY = 3;
const DELAY_MS = 150;
let cursor = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(sym) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(
      `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`,
    );
    if (res.status === 429) {
      await sleep(3000 * (attempt + 1));
      continue;
    }
    if (!res.ok) return `${sym} (HTTP ${res.status})`;
    const j = await res.json();
    return j?.data?.options?.length ? null : `${sym} (empty chain)`;
  }
  return `${sym} (persistent 429)`;
}

async function worker() {
  while (cursor < symbols.length) {
    const sym = symbols[cursor++];
    try {
      const problem = await check(sym);
      if (problem) bad.push(problem);
    } catch (err) {
      bad.push(`${sym} (${err.message})`);
    }
    if (++done % 50 === 0) console.log(`  ${done}/${symbols.length}…`);
    await sleep(DELAY_MS);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

if (bad.length === 0) console.log(`✓ all ${symbols.length} symbols valid`);
else {
  console.log(`✗ ${bad.length} invalid symbols:`);
  for (const b of bad.sort()) console.log(`  - ${b}`);
  process.exitCode = 1;
}
