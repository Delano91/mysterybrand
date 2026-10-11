{
  "name": "mysterybrand",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "generate": "node src/generate.js",
    "test": "node --test"
  },
  "dependencies": {
    "googleapis": "^144.0.0"
  }
}
node_modules/
.env
ANTHROPIC_API_KEY=
CLAUDE_MODEL=claude-sonnet-5-5
SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_JSON=
DRY_RUN=true
name: Weekly generate

on:
  schedule:
    - cron: '0 12 * * 0'   # Sundays 12:00 UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: 'true = print only, false = write to Sheet'
        default: 'true'

jobs:
  generate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install
      - run: npm test
      - run: npm run generate
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GOOGLE_SERVICE_ACCOUNT_JSON: ${{ secrets.GOOGLE_SERVICE_ACCOUNT_JSON }}
          SHEET_ID: ${{ secrets.SHEET_ID }}
          DRY_RUN: ${{ github.event.inputs.dry_run || 'false' }}
import { readTab, appendRows } from './sheets.js';
import { buildInputs, userMessage } from './inputs.js';
import { callClaude } from './claude.js';
import { validate } from './validator.js';

const DRY = String(process.env.DRY_RUN || 'true').toLowerCase() !== 'false';

const bankRows = await readTab('bank');
const queueRows = await readTab('queue');
const ctx = buildInputs(bankRows, queueRows);

if (!ctx.bank.length) throw new Error('bank tab is empty: add at least one case');
if (!ctx.slots.length) { console.log('No open slots in the next 7 days. Nothing to do.'); process.exit(0); }
console.log(`Bank entries: ${ctx.bank.length} | Open slots: ${ctx.slots.length}`);

const raw = await callClaude(ctx.system_prompt, userMessage(ctx));
const rows = validate(raw, ctx);

console.log(`Validated rows: ${rows.length} | Flagged: ${rows.filter((r) => r.needs_review).length}`);
for (const r of rows) console.log(`- ${r.platform} ${r.scheduled_at} review=${r.needs_review} ${r.review_reason}`);

if (DRY) {
  console.log('DRY_RUN is on: nothing written to the Sheet. Set DRY_RUN=false to write.');
} else {
  await appendRows('queue', rows);
  console.log(`Appended ${rows.length} pending rows to queue.`);
}
import { google } from 'googleapis';

function client() {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
  const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return google.sheets({ version: 'v4', auth });
}

export async function readTab(tab) {
  const sheets = client();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: `${tab}!A1:Z` });
  const [header = [], ...rows] = res.data.values || [];
  return rows.map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

export async function appendRows(tab, objects) {
  if (!objects.length) return;
  const sheets = client();
  const head = await sheets.spreadsheets.values.get({ spreadsheetId: process.env.SHEET_ID, range: `${tab}!1:1` });
  const header = (head.data.values || [[]])[0];
  const values = objects.map((o) => header.map((k) => (o[k] === undefined ? '' : o[k])));
  await sheets.spreadsheets.values.append({
    spreadsheetId: process.env.SHEET_ID,
    range: `${tab}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  });
}
export async function callClaude(system, user) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: 6000,
      system,
      messages: [{ role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Claude API error ' + res.status + ': ' + JSON.stringify(data).slice(0, 300));
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}
import { SYSTEM_PROMPT, VOICE_RULES_VERSION } from './prompt.js';

// Turns raw Sheet rows into the context object used by the prompt and validator.
export function buildInputs(bankRows, queueRows, now = new Date()) {
  const bank = bankRows.filter((r) => r.id).map((r) => ({
    id: String(r.id),
    title: r.title || '',
    summary: r.summary || '',
    sources: String(r.sources || '').split(',').map((s) => s.trim()).filter(Boolean),
    living_person: String(r.living_person).toLowerCase() === 'true',
    active_case: String(r.active_case).toLowerCase() === 'true',
  }));

  const queue = queueRows.filter((r) => r.id);
  const cutoff = now.getTime() - 14 * 24 * 3600 * 1000;
  const recent = queue.filter((r) => { const t = Date.parse(r.scheduled_at); return !isNaN(t) && t >= cutoff; });
  const recent_hooks = recent.map((r) => String(r.content || '').split(/(?<=[.!?])\s/)[0]);
  const recent_case_ids = recent
    .map((r) => { try { return JSON.parse(r.generation_metadata).bank_entry_id; } catch { return null; } })
    .filter(Boolean);
  const existing_keys = queue.map((r) => r.idempotency_key).filter(Boolean);

  // Slots: 1 X post/day; LinkedIn Mon/Wed/Fri. Times in UTC.
  const taken = new Set(
    queue.map((r) => { const t = Date.parse(r.scheduled_at); return isNaN(t) ? null : r.platform + '|' + new Date(t).toISOString(); }).filter(Boolean)
  );
  const slots = [];
  const start = new Date(now); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() + 1);
  for (let d = 0; d < 7; d++) {
    const day = new Date(start); day.setUTCDate(start.getUTCDate() + d);
    const iso = (hh) => { const x = new Date(day); x.setUTCHours(hh, 0, 0, 0); return x.toISOString(); };
    const xs = iso(14);
    if (!taken.has('x|' + xs)) slots.push({ platform: 'x', scheduled_at: xs });
    if ([1, 3, 5].includes(day.getUTCDay())) {
      const ls = iso(15);
      if (!taken.has('linkedin|' + ls)) slots.push({ platform: 'linkedin', scheduled_at: ls });
    }
  }

  return { voice_rules_version: VOICE_RULES_VERSION, system_prompt: SYSTEM_PROMPT, bank, slots, recent_hooks, recent_case_ids, existing_keys, feedback: '' };
}

export function userMessage(ctx) {
  return (
    'CONTENT_BANK:\n' + JSON.stringify(ctx.bank) +
    '\n\nSLOTS:\n' + JSON.stringify(ctx.slots) +
    '\n\nRECENT:\n' + JSON.stringify({ hooks: ctx.recent_hooks, case_ids: ctx.recent_case_ids }) +
    '\n\nFEEDBACK:\n' + (ctx.feedback || '(none)') +
    '\n\nVOICE_RULES_VERSION: ' + ctx.voice_rules_version
  );
}
export const VOICE_RULES_VERSION = 'v1';

export const SYSTEM_PROMPT = `You write posts for a channel about strange and mysterious topics: unsolved disappearances, anomalous events, folklore, high strangeness, historical oddities, edge-case science.

INPUTS (in the user message):
- CONTENT_BANK: entries with id, title, summary, sources
- SLOTS: list of {platform, scheduled_at}
- RECENT: hooks and case ids used in the last 14 days
- FEEDBACK: short weekly performance notes (may be "(none)")
- VOICE_RULES_VERSION

VOICE RULES (always apply):
1. Lead with a concrete detail, not a tease. Good: "In 1930, a fur trapper walked out of the Yukon with no memory of the previous nine years." Bad: "You won't believe what happened next."
2. One mystery per post. No listicles unless a slot says so.
3. Stay in the evidence. Say "unexplained," not "paranormal." Say "the records are missing," not "they were erased."
4. No fake suspense. If the case is unsolved, say so plainly.
5. End with a question or an open thread, not a moral.

HARD RULES:
- Never invent details, names, dates, or quotes. Use only what CONTENT_BANK supports. If a claim is unsupported, rewrite without it, set needs_review=true, and name the unsupported part in review_reason.
- Distinguish documented fact, witness account, folklore/legend, and speculation. Never blend them in one sentence.
- Do not reuse any case id or hook from RECENT. Do not use the same hook_type more than twice in a week.
- Set needs_review=true if the post names a living person, involves a missing-persons case that may still be open, or involves a recent death. Give the reason.
- Tone: neutral and precise. No creepypasta voice. No debunker voice. Treat real victims and families with respect.
- Only cite URLs that appear in the chosen bank entry's sources.
- Platform limits: X at most 270 characters. LinkedIn 600 to 1,200 characters, short paragraphs, at most 2 hashtags.

OUTPUT: only a JSON array, one object per slot. status is always pending.

EXAMPLE OUTPUT (shape only; never copy its content or URLs):
[
  {
    "platform": "x",
    "scheduled_at": "2026-10-12T14:00:00Z",
    "content": "EXAMPLE TEXT ONLY",
    "media_refs": [],
    "voice_rules_version": "v1",
    "generation_metadata": {
      "bank_entry_id": "b1",
      "hook_type": "date",
      "topic_tags": ["disappearance"],
      "evidence_class": "documented"
    },
    "sources": ["https://example.com/source"],
    "needs_review": false,
    "review_reason": ""
  }
]
Return ONLY this array. No prose. No code fences.`;
// Validates the agent's raw output. Flags problems (needs_review), drops retry clones.
export const LIMITS = { x: 270, linkedin: 1200 };
export const BANNED = ['shivers', 'chilling', "you won't believe", 'mind-blowing', 'bizarrely', 'spine-tingling'];
const REQUIRED = ['platform', 'scheduled_at', 'content', 'sources', 'needs_review'];

// small non-crypto hash (cyrb53)
export const h = (s) => {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0, c; i < s.length; i++) {
    c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
};

export const firstSentence = (t) =>
  (t.split(/(?<=[.!?])\s/)[0] || t).trim().toLowerCase().replace(/\s+/g, ' ');

export function validate(rawText, ctx) {
  let raw = (rawText || '').trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let posts;
  try { posts = JSON.parse(raw); } catch (e) { throw new Error('Agent returned non-JSON: ' + raw.slice(0, 200)); }
  if (!Array.isArray(posts)) throw new Error('Agent output is not an array');

  const bank = Object.fromEntries((ctx.bank || []).map((b) => [b.id, b]));
  const seenHooks = new Set((ctx.recent_hooks || []).map((t) => h(firstSentence(t))));
  const seenCases = new Set(ctx.recent_case_ids || []);
  const seenKeys = new Set(ctx.existing_keys || []);
  const out = [];

  for (const p of posts) {
    const content = typeof p.content === 'string' ? p.content : '';
    const contentHash = h(content);
    const key = h(`${p.platform}|${p.scheduled_at}|${contentHash}`);
    if (seenKeys.has(key)) continue; // retry artifact: drop silently
    seenKeys.add(key);

    const reasons = [];
    const miss = REQUIRED.filter((f) => !(f in p));
    if (miss.length) reasons.push('missing ' + miss.join(','));
    if (!content) reasons.push('empty content');
    if (!LIMITS[p.platform]) reasons.push('bad platform');
    if (isNaN(Date.parse(p.scheduled_at))) reasons.push('bad scheduled_at');

    const meta = p.generation_metadata || {};
    const entry = bank[meta.bank_entry_id];
    if (!entry) reasons.push('unknown bank_entry_id');
    const srcs = Array.isArray(p.sources) ? p.sources : [];
    if (!srcs.length) reasons.push('no sources');
    else if (entry) {
      const bad = srcs.filter((s) => !(entry.sources || []).includes(s));
      if (bad.length) reasons.push('source not in bank: ' + bad.join(' '));
    }
    if (entry && entry.active_case) reasons.push('active case');
    if (entry && entry.living_person) reasons.push('living person');

    const lim = LIMITS[p.platform];
    if (lim && content.length > lim) reasons.push(`over ${lim} chars`);
    const low = content.toLowerCase().replace(/[\u2019]/g, "'");
    for (const w of BANNED) if (low.includes(w)) reasons.push('banned tone: ' + w);

    const hook = h(firstSentence(content));
    if (seenHooks.has(hook)) reasons.push('duplicate hook');
    seenHooks.add(hook);
    if (meta.bank_entry_id && seenCases.has(meta.bank_entry_id)) reasons.push('case repeated');
    seenCases.add(meta.bank_entry_id);

    const allReasons = (p.review_reason ? [p.review_reason] : []).concat(reasons);
    out.push({
      id: key, idempotency_key: key, status: 'pending',
      platform: p.platform, scheduled_at: p.scheduled_at,
      content, content_hash: contentHash,
      media_refs: JSON.stringify(p.media_refs || []),
      voice_rules_version: p.voice_rules_version || ctx.voice_rules_version || 'v1',
      generation_metadata: JSON.stringify({ ...meta, hook_hash: hook }),
      sources: JSON.stringify(srcs),
      needs_review: Boolean(p.needs_review) || reasons.length > 0,
      review_reason: allReasons.join(' | '),
      approved_at: '', posted_at: '', platform_post_id: '',
      retry_count: 0, next_retry_at: '', last_error: '',
    });
  }
  return out;
}
const mk = (o) => ({ media_refs: [], voice_rules_version: 'v1', needs_review: false, review_reason: '', ...o });

export const ctx = {
  voice_rules_version: 'v1',
  bank: [1, 2, 3, 4, 5].map((n) => ({ id: 'b' + n, sources: ['https://example.com/' + 'abcde'[n - 1]], living_person: false, active_case: false })),
  recent_hooks: ['In 1931, a surveyor logged a lamp burning in a cabin that did not exist.'],
  recent_case_ids: ['b0'],
  existing_keys: [],
};

const posts = [
  mk({ platform: 'x', scheduled_at: '2026-10-12T14:00:00Z',
    content: 'In 1930, a fur trapper walked out of the Yukon with no memory of the previous nine years. The file is four pages. It does not explain the nine years.',
    generation_metadata: { bank_entry_id: 'b1' }, sources: ['https://example.com/a'] }),
  mk({ platform: 'x', scheduled_at: '2026-10-13T14:00:00Z',
    content: 'In 1948, a lighthouse keeper wrote, "the light is wrong tonight." The log ends there. Who read it last?',
    generation_metadata: { bank_entry_id: 'b2' }, sources: ['https://madeup-site.example/story'] }),
  mk({ platform: 'x', scheduled_at: '2026-10-14T14:00:00Z',
    content: 'In 1931, a surveyor logged a lamp burning in a cabin that did not exist. The survey party never returned to check. What would you have done?',
    generation_metadata: { bank_entry_id: 'b3' }, sources: ['https://example.com/c'] }),
  mk({ platform: 'x', scheduled_at: '2026-10-15T14:00:00Z',
    content: 'In 1962, a ranger found a locked cabin. '.repeat(8).trim(),
    generation_metadata: { bank_entry_id: 'b4' }, sources: ['https://example.com/d'] }),
  mk({ platform: 'x', scheduled_at: '2026-10-16T14:00:00Z',
    content: 'In 1948, a ship\u2019s log ended mid-sentence. Chilling, and you won\u2019t believe the rest. Why did it stop?',
    generation_metadata: { bank_entry_id: 'b5' }, sources: ['https://example.com/e'] }),
];
posts.push(JSON.parse(JSON.stringify(posts[0]))); // retry clone

export const fakeAgentText = JSON.stringify(posts);
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/validator.js';
import { ctx, fakeAgentText } from './fixtures.js';

const rows = validate(fakeAgentText, ctx);

test('retry clone is dropped, 5 rows remain', () => assert.equal(rows.length, 5));
test('good post is clean', () => assert.equal(rows[0].needs_review, false));
test('made-up source is flagged', () => assert.match(rows[1].review_reason, /source not in bank/));
test('duplicate hook is flagged', () => assert.match(rows[2].review_reason, /duplicate hook/));
test('over-limit is flagged', () => assert.match(rows[3].review_reason, /over 270 chars/));
test('banned tone is flagged (both phrases)', () => {
  assert.match(rows[4].review_reason, /banned tone: chilling/);
  assert.match(rows[4].review_reason, /banned tone: you won't believe/);
});
test('non-JSON output throws', () => assert.throws(() => validate('hello', ctx), /non-JSON/));
test('code-fenced JSON still parses', () => assert.equal(validate('```json\n[]\n```', ctx).length, 0));
