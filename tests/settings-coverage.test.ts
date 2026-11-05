import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SECRET_SPECS, SETTINGS } from '../src/gateway/settings';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'src');

/**
 * Keeps the env surface honest in the three places it is described.
 *
 *   1. Every var the code reads is on the settings page, a secret, or INTERNAL with a
 *      written reason — otherwise it exists only as a Worker var and you have to read
 *      the source to find it.
 *   2. Every settings entry is read by something — otherwise saving it does nothing.
 *   3. Every key declared in `Env` is read by something, and every key in
 *      `.env.example` is real. These are the two places a removed feature leaves a
 *      corpse: a field in types.ts and a line in the example both read like a working
 *      switch, and the example is what a fresh deploy copies.
 */

/** Reads that are not runtime knobs, each with the reason it stays off the page. */
const INTERNAL: Record<string, string> = {
  DB: 'D1 binding',
  AI: 'Workers AI binding',
  MEMORY_QUEUE: 'queue binding',
  VECTORIZE: 'Vectorize binding',
  GATEWAY_CONFIG: '内部 JSON blob（/admin 的配置本体），不是开关',
  AI_GATEWAY_BASE_URL: '/admin 的上游地址优先，这个只是 Worker var 兜底',
  CLOUDFLARE_ACCOUNT_ID: '同上：上游地址里的账户 ID 优先',
  DAILY_DIGEST_MODEL: 'readDreamModel 的旧名兜底，前面有 DREAM_MODEL',
  DAILY_DIGEST_TIME_ZONE: 'readDreamTimeZone 的旧名兜底',
  DAILY_DIGEST_MAX_MESSAGES: 'readDreamMaxMessages 的旧名兜底',
  DAILY_DIGEST_MAX_TOKENS: 'readDreamMaxTokens 的旧名兜底',
  DAILY_DIGEST_MEMORY_CONTEXT_LIMIT: 'readDreamMemoryContextLimit 的旧名兜底',
  DAILY_DIGEST_MAX_RUNS: 'DREAM_MAX_RUNS 的旧名兜底',
  ENABLE_DAILY_MEMORY_DIGEST: 'isDreamEnabled 的旧名兜底，ENABLE_DREAM 优先'
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

/**
 * Env reads in src/, in both shapes the repo uses: `env.NAME` and the model-name
 * lists passed to `readModelName(env, ["NAME", ...])`. A helper that reads env by a
 * string key it builds at runtime would slip past this — none exists today.
 */
function envReads(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const record = (name: string, where: string) => {
    const places = found.get(name) ?? [];
    if (!places.includes(where)) places.push(where);
    found.set(name, places);
  };
  for (const file of sourceFiles(SRC)) {
    if (file.endsWith('types.ts')) continue;
    const relative = file.slice(SRC.length + 1);
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) record(match[1], relative);
    for (const call of content.matchAll(/readModelName\([^;]*?\[([^\]]*)\]/g)) {
      for (const name of call[1].matchAll(/"([A-Z][A-Z0-9_]+)"/g)) record(name[1], relative);
    }
  }
  return found;
}

/** Keys declared on the `Env` interface in src/types.ts. */
function declaredEnvKeys(): string[] {
  const content = readFileSync(join(SRC, 'types.ts'), 'utf8');
  const start = content.indexOf('export interface Env');
  assert.ok(start >= 0, 'Env interface not found in src/types.ts');
  const body = content.slice(start);
  const end = body.indexOf('\n}');
  assert.ok(end > 0, 'Env interface body not closed');
  return [...new Set(
    [...body.slice(0, end).matchAll(/^\s*([A-Z][A-Z0-9_]+)\??:/gm)].map((match) => match[1])
  )];
}

/** `NAME=` keys from .env.example. */
function exampleKeys(): string[] {
  return readFileSync(join(ROOT, '.env.example'), 'utf8')
    .split('\n')
    .flatMap((line) => {
      const match = /^([A-Z][A-Z0-9_]+)=/.exec(line);
      return match ? [match[1]] : [];
    });
}

test('every env var the code reads is either on the settings page, a secret, or documented as internal', () => {
  const allowed = new Set([
    ...SETTINGS.map((spec) => spec.name),
    ...SECRET_SPECS.map((spec) => spec.name),
    ...Object.keys(INTERNAL)
  ]);
  const unaccounted = [...envReads()]
    .filter(([name]) => !allowed.has(name))
    .map(([name, places]) => `${name} (${places.join(', ')})`);
  assert.deepEqual(unaccounted, [],
    'add the knob to SETTINGS, or add it to INTERNAL with the reason it stays off the page');
});

test('every internal env var carries a reason', () => {
  const undocumented = Object.entries(INTERNAL).filter(([, reason]) => !reason.trim()).map(([name]) => name);
  assert.deepEqual(undocumented, [], 'INTERNAL entries need a reason');
});

/**
 * Settings that the deploy reads, not the running Worker: `npm run deploy` (scripts/setup-cloudflare.mjs) takes
 * them out of the saved config and writes them into that deploy's wrangler.toml.
 */
const DEPLOY_TIME = ['PLACEMENT_REGION'];

test('every settings entry is read by the code', () => {
  const reads = envReads();
  const deployScript = readFileSync(join(ROOT, 'scripts', 'setup-cloudflare.mjs'), 'utf8');
  const readAtDeploy = (name: string) => DEPLOY_TIME.includes(name) && new RegExp(`settings\\?\\.${name}\\b`).test(deployScript);
  const dead = SETTINGS.map((spec) => spec.name).filter((name) => !reads.has(name) && !readAtDeploy(name));
  assert.deepEqual(dead, [],
    'a setting nothing reads is a dead knob: the source would not show why saving it changed nothing');
});

test('every key declared on Env is read somewhere', () => {
  const reads = envReads();
  const allowed = new Set([
    ...SETTINGS.map((spec) => spec.name),
    ...SECRET_SPECS.map((spec) => spec.name),
    ...Object.keys(INTERNAL)
  ]);
  const dead = declaredEnvKeys().filter((name) => !reads.has(name) && !allowed.has(name));
  assert.deepEqual(dead, [],
    'types.ts is the first place a removed feature leaves a corpse: either delete the field or read it');
});

test('every key in .env.example is real', () => {
  const reads = envReads();
  const allowed = new Set([
    ...SETTINGS.map((spec) => spec.name),
    ...SECRET_SPECS.map((spec) => spec.name),
    ...Object.keys(INTERNAL)
  ]);
  const stale = exampleKeys().filter((name) => !reads.has(name) && !allowed.has(name));
  assert.deepEqual(stale, [],
    '.env.example is what a fresh deploy copies: a dead line there is a switch that does nothing');
});
