import assert from 'node:assert/strict';
import test from 'node:test';
import { NcellApp, parseCount, parseDelay, type GameEvent } from '../src/app.js';
import { MemorySessionStore, NcellError, type Session } from '../src/core/index.js';
import type { GameEndpoints } from '../src/game/index.js';

type Data = Record<string, unknown>;
interface Call {
  url: string;
  init: RequestInit | undefined;
}
const gameOrigin = 'https://game.test';
const endpoints: GameEndpoints = {
  status: `${gameOrigin}/status`,
  ranks: `${gameOrigin}/ranks`,
  checkIn: `${gameOrigin}/check-in`,
  claimTask: `${gameOrigin}/claim`,
  spin: `${gameOrigin}/spin`,
  scratch: `${gameOrigin}/scratch`,
  math: `${gameOrigin}/math`,
};
const primary = '9800000000';
const secondary = '9800000001';
const session = (): Session => ({
  deviceId: 'device-primary',
  account: {
    msisdn: primary,
    accessToken: 'access-primary',
    refreshToken: 'refresh-primary',
    authenticatedAt: '2026-10-13T00:00:00Z',
  },
  otherAccounts: [
    {
      deviceId: 'device-secondary',
      account: {
        msisdn: secondary,
        accessToken: 'access-secondary',
        refreshToken: 'refresh-secondary',
        authenticatedAt: '2026-10-13T00:00:00Z',
      },
    },
  ],
});
const api = (body: Data) => Response.json({ responseHeader: { responseCode: '200' }, ...body });

function fixture(
  options: {
    tokens?: number;
    bootstrapTokens?: boolean;
    handle?: (
      call: Call,
      state: { tokens: number; calls: Call[] },
    ) => Response | Promise<Response | undefined> | undefined;
  } = {},
) {
  const store = new MemorySessionStore(session());
  const state = { tokens: options.tokens ?? 100, calls: [] as Call[] };
  const fetcher: typeof fetch = async (url, init) => {
    const call = { url: String(url), init };
    state.calls.push(call);
    const custom = await options.handle?.(call, state);
    if (custom) return custom;
    if (call.url.includes('third-party-encryption'))
      return api({ encryptionResponse: { msisdn: 'encrypted%2Fnumber' } });
    if (call.url.includes('index.php?MSISDN=')) {
      return new Response(
        `<input name="csrf_token" value="csrf">${options.bootstrapTokens === false ? '' : `<div id="tokens-display">${state.tokens}</div>`}`,
        {
          headers: { 'Set-Cookie': 'PHPSESSID=fixture; Secure; Path=/' },
        },
      );
    }
    if (call.url === endpoints.status) return Response.json({ success: true, challenges: [] });
    if (call.url === endpoints.spin || call.url === endpoints.scratch) {
      if (state.tokens < 25) return Response.json({ success: false, error: 'Insufficient tokens' });
      state.tokens -= 25;
      return Response.json({
        value: '50',
        description: '50 Points',
        ...(call.url === endpoints.spin
          ? { new_token_balance: state.tokens }
          : { points_remaining: state.tokens }),
        new_week_points: 100,
      });
    }
    if (call.url === endpoints.math) {
      assert.ok(init?.body instanceof URLSearchParams);
      const action = init.body.get('action');
      if (action === 'start_game') {
        if (state.tokens < 25) return Response.json({ success: false, error: 'Not enough points' });
        state.tokens -= 25;
        return Response.json({ success: true });
      }
      if (action === 'get_question')
        return Response.json({ level: 20, question: '2+3', options: [5, 6] });
      assert.equal(init.body.get('answer'), '5');
      return Response.json({ result: 'win', total_score: 165, bg_reward: 10 });
    }
    if (call.url.includes('refresh/token'))
      return api({
        userAuthResponse: {
          accessToken: 'access-rotated',
          refreshToken: 'refresh-rotated',
          expiresIn: 3600,
        },
      });
    if (call.url.includes('balance/query')) return api({ queryBalanceResponse: { balance: 100 } });
    throw new Error(`Unexpected mock request: ${call.url}`);
  };
  const app = new NcellApp({ store, fetch: fetcher, gameEndpoints: endpoints });
  const count = (value: string) => state.calls.filter((call) => call.url.includes(value)).length;
  return { app, store, state, count };
}

test('facade shares game encryption and bootstrap within ten minutes', async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, 'now', () => now);
  const { app, count } = fixture();
  await app.taskStatus();
  await app.spin();
  await app.scratch();
  await app.taskStatus();
  assert.equal(count('third-party-encryption'), 1);
  assert.equal(count('index.php'), 1);
  now += 599_999;
  await app.taskStatus();
  assert.equal(count('index.php'), 1);
  now++;
  await app.taskStatus();
  assert.equal(count('third-party-encryption'), 2);
  assert.equal(count('index.php'), 2);
});

test('account, external device and token changes rebuild the game session', async () => {
  const { app, store, count } = fixture();
  await app.taskStatus();
  await app.switchAccount(secondary);
  await app.taskStatus();
  let saved = await store.load();
  assert.equal(saved?.account?.msisdn, secondary);
  assert.ok(saved?.account);
  saved.deviceId = 'changed-device';
  await store.save(saved);
  await app.taskStatus();
  saved = await store.load();
  assert.ok(saved?.account);
  saved.account.accessToken = 'externally-rotated';
  await store.save(saved);
  await app.taskStatus();
  assert.equal(count('third-party-encryption'), 4);
  assert.equal(count('index.php'), 4);
});

test('explicit refresh invalidates game state while keeping both accounts', async () => {
  const { app, count } = fixture();
  await app.taskStatus();
  await app.refresh();
  await app.taskStatus();
  assert.equal(count('refresh/token'), 1);
  assert.equal(count('index.php'), 2);
  assert.deepEqual(await app.listAccounts(), [
    { msisdn: primary, active: true },
    { msisdn: secondary, active: false },
  ]);
});

test('automatic refresh caches the post-refresh identity without another bootstrap', async () => {
  let first = true;
  const { app, store, count } = fixture({
    handle: (call) => {
      if (call.url.includes('third-party-encryption') && first) {
        first = false;
        return Response.json(
          { responseHeader: { responseCode: '401', responseDescDisplay: 'LGN2001' } },
          { status: 401 },
        );
      }
      return undefined;
    },
  });
  await app.taskStatus();
  await app.taskStatus();
  assert.equal(count('refresh/token'), 1);
  assert.equal(count('third-party-encryption'), 2);
  assert.equal(count('index.php'), 1);
  assert.equal((await store.load())?.account?.accessToken, 'access-rotated');
});

test('unknown bootstrap balance rebuilds the session on the next game command', async () => {
  const { app, count } = fixture({ bootstrapTokens: false });
  await app.taskStatus();
  await app.taskStatus();
  assert.equal(count('index.php'), 2);
});

test('fixed game counts stream results in order and reuse one session', async () => {
  const { app, count, state } = fixture({ tokens: 100 });
  const events: string[] = [];
  const played = await app.spin({
    count: 3,
    onEvent: async (event) => {
      if (event.event !== 'wait') events.push(`${event.event}:${event.game}`);
      if (event.event === 'result') assert.equal(count('/spin'), event.game);
      await Promise.resolve();
    },
  });
  assert.deepEqual(events, [
    'game_start:1',
    'result:1',
    'game_start:2',
    'result:2',
    'game_start:3',
    'result:3',
  ]);
  assert.equal(played.games, 3);
  assert.equal(played.stop, 'count');
  assert.equal(count('index.php'), 1);
  assert.equal(count('/spin'), 3);
  assert.equal(state.tokens, 25);
});

test('all-token play uses exact entry fees and preserves an unaffordable remainder', async () => {
  for (const kind of ['spin', 'scratch', 'math'] as const) {
    const { app, state, count } = fixture({ tokens: 60 });
    const totals: Array<number | undefined> = [];
    const result = await app[kind]({
      count: 'all',
      onEvent: (event) => {
        if (event.event === 'game_start') totals.push(event.total);
      },
    });
    assert.equal(result.games, 2, kind);
    assert.equal(result.stop, 'insufficient_tokens');
    assert.deepEqual(totals, [2, 2]);
    assert.equal(state.tokens, 10);
    assert.equal(count('index.php'), 1);
    if (kind === 'math') assert.equal(result.results[0]?.bg_reward, 10);
  }
});

test('all-token progress adapts to token rewards without using a fixed game limit', async () => {
  let spins = 0;
  const { app, state } = fixture({
    tokens: 50,
    handle: (call, current) => {
      if (call.url !== endpoints.spin) return undefined;
      spins++;
      current.tokens = spins === 1 ? 75 : current.tokens - 25;
      return Response.json({
        value: '25',
        new_token_balance: current.tokens,
        new_week_points: spins,
      });
    },
  });
  const starts: Array<number | undefined> = [];
  const result = await app.spin({
    count: 'all',
    onEvent: (event) => {
      if (event.event === 'game_start') starts.push(event.total);
    },
  });
  assert.equal(result.games, 4);
  assert.deepEqual(starts, [2, 4, 4, 4]);
  assert.equal(state.tokens, 0);
});

test('all-token requests stop normally when the server reports insufficient tokens', async () => {
  for (const kind of ['spin', 'scratch', 'math'] as const) {
    const { app, count } = fixture({
      handle: (call) =>
        call.url === endpoints[kind]
          ? Response.json({
              success: false,
              error: kind === 'math' ? 'low_balance' : 'Insufficient tokens',
            })
          : undefined,
    });
    const result = await app[kind]({ count: 'all' });
    assert.deepEqual(result, { games: 0, results: [], stop: 'insufficient_tokens' });
    assert.equal(count(`/${kind}`), 1);
  }
});

test('numeric game counts fail visibly on insufficient tokens and never retry', async () => {
  const { app, count } = fixture({ tokens: 10 });
  await assert.rejects(
    app.spin({ count: 2 }),
    (error: unknown) => error instanceof NcellError && error.message === 'Insufficient tokens',
  );
  assert.equal(count('/spin'), 1);
  const stopped = await app.spin({ count: 'all' });
  assert.equal(stopped.games, 0);
  assert.equal(count('/spin'), 1);
});

test('math events preserve answer ordering, manual fallback and raw final response', async () => {
  const { app } = fixture({
    handle: (call) => {
      if (
        call.url === endpoints.math &&
        call.init?.body instanceof URLSearchParams &&
        call.init.body.get('action') === 'get_question'
      ) {
        return Response.json({ level: 20, question: 'unknown(5)', options: [5, 6] });
      }
      return undefined;
    },
  });
  const events: GameEvent[] = [];
  const result = await app.math({
    manualAnswer: async () => '5',
    onEvent: async (event) => {
      await Promise.resolve();
      events.push(event);
    },
  });
  assert.deepEqual(
    events.map((event) => event.event),
    ['game_start', 'answer', 'result'],
  );
  assert.equal(result.games, 1);
  assert.equal(result.results[0]?.bg_reward, 10);
});

test('math accepts terminal-question win flags and rejects losses', async () => {
  const winning = fixture({
    handle: (call) =>
      call.url === endpoints.math &&
      call.init?.body instanceof URLSearchParams &&
      call.init.body.get('action') === 'get_question'
        ? Response.json({ win: true, total_score: 165 })
        : undefined,
  });
  assert.equal((await winning.app.math()).games, 1);
  const losing = fixture({
    handle: (call) =>
      call.url === endpoints.math &&
      call.init?.body instanceof URLSearchParams &&
      call.init.body.get('action') === 'get_question'
        ? Response.json({ game_over: true, total_score: 0 })
        : undefined,
  });
  await assert.rejects(
    losing.app.math({ count: 2 }),
    (error: unknown) => error instanceof NcellError && error.code === 'GAME_LOST',
  );
  assert.equal(losing.count('/math'), 2);
});

test('all-token play refuses an unknown bootstrap balance before spending tokens', async () => {
  const { app, count } = fixture({ bootstrapTokens: false });
  await assert.rejects(app.spin({ count: 'all' }), /token balance/);
  assert.equal(count('/spin'), 0);
});

test('invalid play options are rejected before fetching or loading credentials', async () => {
  const { app, state } = fixture();
  for (const count of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => app.spin({ count }), /Count/);
  }
  for (const delay of [-1, NaN, Infinity, '-1s', '1d', '1.2.3', 'forever']) {
    assert.throws(() => app.spin({ delay }), /Delay/);
  }
  assert.equal(state.calls.length, 0);
  assert.equal(parseCount('3'), 3);
  assert.equal(parseCount('all'), 'all');
  assert.equal(parseDelay(1.5), 1.5);
  assert.equal(parseDelay('1.5s'), 1.5);
  assert.equal(parseDelay('2m'), 120);
  assert.equal(parseDelay('1.5h'), 5400);
});

test('fractional delays occur only between games and cancellation prevents later games', async () => {
  const { app, count } = fixture({ tokens: 100 });
  const times: number[] = [];
  await app.spin({
    count: 2,
    delay: '0.03s',
    onEvent: (event) => {
      if (event.event === 'game_start') times.push(performance.now());
    },
  });
  assert.ok((times[1] ?? 0) - (times[0] ?? 0) >= 20);
  assert.equal(count('/spin'), 2);
  const abort = new AbortController();
  await assert.rejects(
    app.spin({
      count: 2,
      delay: '1h',
      signal: abort.signal,
      onEvent: (event) => {
        if (event.event === 'result') abort.abort(new Error('cancelled'));
      },
    }),
    /cancelled/,
  );
  assert.equal(count('/spin'), 3);
});

test('concurrent SDK operations are queued and reuse safe game state', async () => {
  let active = 0;
  let peak = 0;
  const { app, count } = fixture({
    handle: async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
      active--;
      return undefined;
    },
  });
  await Promise.all([app.taskStatus(), app.balance(), app.spin(), app.scratch()]);
  assert.equal(peak, 1);
  assert.equal(count('index.php'), 1);
  assert.equal(count('/spin'), 1);
  assert.equal(count('/scratch'), 1);
});

test('an operation failure does not poison subsequent queued SDK commands', async () => {
  const { app } = fixture({ tokens: 10 });
  await assert.rejects(app.spin(), /Insufficient/);
  assert.deepEqual(await app.taskStatus(), { success: true, challenges: [] });
});

test('awaiting another command inside a progress callback rejects without deadlocking', async () => {
  const { app, count } = fixture();
  await assert.rejects(
    app.spin({
      onEvent: async (event) => {
        if (event.event === 'result') await app.taskStatus();
      },
    }),
    (error: unknown) => error instanceof NcellError && error.code === 'REENTRANT_COMMAND',
  );
  assert.equal(count('/spin'), 1);
  assert.equal(count('/status'), 0);
  assert.deepEqual(await app.taskStatus(), { success: true, challenges: [] });
});

test('play cancellation reaches the request and rebuilds an uncertain game balance', async () => {
  const controller = new AbortController();
  const reason = new Error('Stopped by caller');
  let first = true;
  const { app, count } = fixture({
    handle: (call) => {
      if (call.url !== endpoints.spin || !first) return undefined;
      first = false;
      return new Promise<Response>((_resolve, reject) => {
        assert.ok(call.init?.signal);
        call.init.signal.addEventListener('abort', () => reject(call.init?.signal?.reason), {
          once: true,
        });
        controller.abort(reason);
      });
    },
  });
  await assert.rejects(
    app.spin({ signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(count('/spin'), 1);
  assert.equal((await app.spin()).games, 1);
  assert.equal(count('index.php'), 2);

  const aborted = new AbortController();
  aborted.abort(reason);
  const before = count('/spin');
  await assert.rejects(app.spin({ signal: aborted.signal }), (error: unknown) => error === reason);
  assert.equal(count('/spin'), before);
});

test('default and named package imports have no request side effects', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    throw new Error('No requests expected');
  });
  const imported = await import('../src/index.js');
  assert.ok(imported.default instanceof imported.NcellApp);
  assert.ok(
    imported.createNcellApp({ store: new MemorySessionStore() }) instanceof imported.NcellApp,
  );
  assert.equal(calls, 0);
});
