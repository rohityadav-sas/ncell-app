import assert from 'node:assert/strict';
import test from 'node:test';
import { PackCatalog, PACK_CACHE_TTL } from '../src/cli/pack-completion.js';
import { CompletionEngine, acceptSuggestion } from '../src/cli/completion.js';
import { InteractiveEditor } from '../src/cli/interactive-editor.js';
import { parseCommand } from '../src/cli/parse.js';
const tags = {
  tags: [
    { id: 50, categories: [{ name: 'GSM_SMS' }] },
    { id: 61, categories: [{ name: 'GSM_VOICE' }] },
    { id: 66, categories: [{ name: 'GSM_DATA' }] },
    { id: 29, categories: [{ name: 'GSM_ROAMING' }] },
  ],
};
const response = (category: number) => ({
  availablePackages:
    category === 50
      ? [{ id: '984', ncellName: 'SMS pack', productOfferingPrice: { price: '15.00' } }]
      : [{ id: '856', ncellName: 'Voice pack' }],
});

test('pack catalog fetches supported categories, deduplicates IDs and expires after five minutes', async () => {
  let now = 1000;
  const calls: number[] = [];
  const cache = new PackCatalog(
    async () => tags,
    async (category) => {
      calls.push(category);
      return response(category);
    },
    () => {},
    () => now,
  );
  const first = await cache.load();
  assert.deepEqual(calls, [50, 61, 66]);
  assert.equal(first.length, 2);
  assert.deepEqual(first.find((pack) => pack.id === '856')?.categories, [61, 66]);
  await cache.load();
  assert.equal(calls.length, 3);
  now += PACK_CACHE_TTL + 1;
  await cache.load();
  assert.equal(calls.length, 6);
  cache.invalidate();
  await cache.load();
  assert.equal(calls.length, 9);
});
test('failed category requests never cache a partial unique catalog and invalidation discards stale results', async () => {
  const failed = new PackCatalog(
    async () => tags,
    async (category) => {
      if (category === 61) throw Error('secret');
      return response(category);
    },
    () => {},
  );
  await assert.rejects(failed.load(), /Could not load packs/);
  assert.equal(failed.items, undefined);
  assert.doesNotMatch(failed.error ?? '', /secret/);
  const finishers: ((value: unknown) => void)[] = [];
  const cache = new PackCatalog(
    async () => tags,
    () =>
      new Promise((resolve) => {
        finishers.push(resolve);
      }),
    () => {},
  );
  const pending = cache.load();
  await new Promise((resolve) => setImmediate(resolve));
  cache.invalidate();
  for (const finish of finishers) finish(response(50));
  await assert.rejects(pending);
  assert.equal(cache.items, undefined);
  assert.equal(cache.error, undefined);
});
test('subscribe completion loads on demand, filters unique packs, and accepts a valid category without purchasing', async () => {
  const completion = new CompletionEngine({
    categories: async () => tags,
    plans: async (category) => response(category),
    scripts: { directory: '', list: async () => [] },
  });
  assert.equal((await completion.suggest('plans subscribe ')).packPanel, undefined);
  const loading = await completion.suggest('plans subscribe ', undefined, true);
  assert.equal(loading.notice, 'Loading packs…');
  assert.deepEqual(loading.items, []);
  await completion.packs!.load();
  const list = await completion.suggest('plans subscribe ', undefined, true);
  assert.equal(list.items.length, 2);
  const filtered = await completion.suggest('plans subscribe --category 50 ', undefined, true);
  assert.deepEqual(
    filtered.items.map((item) => item.value),
    ['984'],
  );
  assert.equal(filtered.items[0]?.subscriptionCategory, undefined);
  const sms = await completion.suggest('plans subscribe 984');
  assert.equal(sms.items[0]?.subscriptionCategory, 50);
  const editor = new InteractiveEditor();
  editor.input = 'plans subscribe 984';
  editor.cursor = editor.input.length;
  assert.equal(editor.key({ name: 'return' }, sms).kind, 'render');
  assert.equal(editor.input, 'plans subscribe 984 --category 50 ');
  const parsed = parseCommand(['plans', 'subscribe', '984', '--category', '50'], {
    out: () => {},
    err: () => {},
  });
  assert.equal(parsed.category, 50);
  const name = await completion.suggest('plans subscribe SMS');
  assert.equal(name.items[0]?.value, '984');
  const normal = await completion.suggest('plans subscribe 856');
  assert.equal(normal.items[0]?.subscriptionCategory, undefined);
  assert.equal(
    acceptSuggestion('plans subscribe 856', normal, normal.items[0]!).input,
    'plans subscribe 856 ',
  );
});
