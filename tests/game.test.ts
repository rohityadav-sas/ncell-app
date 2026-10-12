import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { NcellError } from '../src/core/index.js';
import {
  GameSession,
  alreadyCheckedIn,
  alreadyClaimed,
  evaluateMath,
  isInsufficientTokens,
  parseRanks,
  solveMath,
  type GameEndpoints,
} from '../src/game/index.js';

type Data = Record<string, unknown>;
const origin = 'https://game.example';
const endpoints: GameEndpoints = {
  status: `${origin}/api/status`,
  ranks: `${origin}/ranks`,
  checkIn: `${origin}/api/check-in`,
  claimTask: `${origin}/api/claim`,
  spin: `${origin}/spin`,
  scratch: `${origin}/scratch`,
  math: `${origin}/math`,
};
const page = (tokens = '100', csrf = 'csrf') =>
  `<input name="csrf_token" value="${csrf}"><div id="tokens-display">${tokens}</div>`;
const json = (data: unknown, status = 200) => Response.json(data, { status });

interface Call {
  url: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
  signal: AbortSignal | null | undefined;
}

async function fixture(
  respond: (call: Call, index: number) => Response | Promise<Response>,
  html = page(),
  cookie = 'PHPSESSID=shared; Path=/; Secure; HttpOnly',
  overrides: Partial<GameEndpoints> = {},
): Promise<{ game: GameSession; calls: Call[] }> {
  const calls: Call[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal instanceof AbortSignal);
    const call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: new Headers(init?.headers),
      body: init?.body,
      signal: init?.signal,
    };
    calls.push(call);
    if (calls.length === 1) {
      assert.equal(call.url, `${origin}/index`);
      assert.equal(call.headers.get('User-Agent'), 'wv');
      return new Response(html, { headers: { 'Set-Cookie': cookie } });
    }
    return respond(call, calls.length - 2);
  };
  const game = await GameSession.open(`${origin}/index`, {
    fetch: fetcher,
    endpoints: { ...endpoints, ...overrides },
  });
  return { game, calls };
}

function fields(call: Call): Record<string, string> {
  assert.ok(call.body instanceof URLSearchParams);
  return Object.fromEntries([...call.body.entries()].map(([key, value]) => [key, String(value)]));
}

test('bootstrap preserves zero and grouped token balances', async () => {
  for (const [raw, expected] of [
    ['0', 0],
    ['1,250', 1250],
    ['', undefined],
    ['bad', undefined],
  ] as const) {
    const { game } = await fixture(() => json({ success: true }), page(raw));
    assert.equal(game.tokens, expected);
  }
});

test('read-only requests do not require CSRF, and mutations fail before requests', async () => {
  const { game, calls } = await fixture(
    (call) => {
      assert.equal(call.headers.get('User-Agent'), 'wv');
      assert.equal(call.body, undefined);
      if (call.url === endpoints.status) return json({ success: true, challenges: [] });
      return new Response('<h1>Leaderboard</h1>');
    },
    page('50', ''),
  );
  assert.deepEqual(await game.status(), { success: true, challenges: [] });
  assert.deepEqual((await game.ranks()).players, []);
  await assert.rejects(game.spin(), /CSRF/);
  await assert.rejects(game.scratch(), /CSRF/);
  await assert.rejects(game.checkIn(), /CSRF/);
  await assert.rejects(game.claimTasks([1]), /CSRF/);
  await assert.rejects(game.math(), /CSRF/);
  assert.equal(calls.length, 3);
});

test('status, claims, spin and scratch share one bootstrap and update authoritative balances', async () => {
  const { game, calls } = await fixture((call) => {
    assert.equal(call.headers.get('Cookie'), 'PHPSESSID=shared');
    assert.equal(call.headers.get('Origin'), null);
    assert.equal(call.headers.get('Referer'), null);
    if (call.url === endpoints.status) {
      assert.equal(call.headers.get('User-Agent'), 'wv');
      return json({ success: true, challenges: [] });
    }
    if (call.url === endpoints.claimTask) {
      assert.equal(call.headers.get('User-Agent'), 'wv');
      assert.deepEqual(fields(call), { csrf_token: 'csrf', activity_id: '7' });
      return json({ success: true, new_token_balance: 125 });
    }
    assert.equal(call.headers.get('User-Agent'), null);
    assert.deepEqual(fields(call), { csrf_token: 'csrf' });
    if (call.url === endpoints.spin) {
      assert.ok(call.body instanceof URLSearchParams);
      return json({ value: '50', new_token_balance: 100, new_week_points: 150 });
    }
    assert.ok(call.body instanceof URLSearchParams);
    return json({ value: '50', points_remaining: 0, new_week_points: 200 });
  });
  await game.status();
  let streamed = false;
  const claims = await game.claimTasks([7], (item) => {
    assert.equal(item.id, 7);
    assert.equal(calls.length, 3);
    streamed = true;
  });
  assert.equal(claims.failed, false);
  assert.ok(streamed);
  assert.equal(game.tokens, 125);
  await game.spin();
  assert.equal(game.tokens, 100);
  await game.scratch();
  assert.equal(game.tokens, 0);
  assert.equal(calls.length, 5);
});

test('cookie updates are reused and rejected domain cookies never leak', async () => {
  const { game } = await fixture((call, index) => {
    if (index === 0) {
      assert.equal(call.headers.get('Cookie'), 'PHPSESSID=shared');
      const response = json({ success: true, challenges: [] });
      response.headers.append('Set-Cookie', 'PHPSESSID=rotated; Path=/; Secure');
      response.headers.append('Set-Cookie', 'other=secret; Domain=evil.example; Path=/');
      return response;
    }
    assert.equal(call.headers.get('Cookie'), 'PHPSESSID=rotated');
    return json({ success: true, challenges: [] });
  });
  await game.status();
  await game.status();
});

test('cookie security, domain and path restrictions are respected', async () => {
  for (const target of [
    'https://other.example/status',
    'http://game.example/status',
    `${origin}/outside`,
  ]) {
    const { game } = await fixture(
      (call) => {
        assert.equal(call.headers.get('Cookie'), null);
        return json({ success: true, challenges: [] });
      },
      page(),
      'PHPSESSID=private; Path=/api; Secure',
      { status: target },
    );
    await game.status();
  }
});

test('check-in sends only CSRF and accepts an already checked result without changing balance', async () => {
  const { game, calls } = await fixture((call, index) => {
    assert.deepEqual(fields(call), { csrf_token: 'csrf' });
    return index === 0
      ? json({ success: true, data: { game_tokens: 150, current_streak: 1 } })
      : json({ success: false, message: 'Already checked in today' });
  });
  await game.checkIn();
  assert.equal(game.tokens, 150);
  const result = await game.checkIn();
  assert.ok(alreadyCheckedIn(result));
  assert.equal(game.tokens, 150);
  assert.equal(calls.length, 3);
});

test('claim all preserves response order and filters only completed unclaimed tasks', async () => {
  const observed: number[] = [];
  const { game } = await fixture((call) => {
    if (call.url === endpoints.status)
      return json({
        success: true,
        challenges: [
          { id: '22', completed: 1, rewarded: 0 },
          { id: 2, completed: false, rewarded: false },
          { id: 3, completed: true, rewarded: true },
          { id: 7, completed: true, rewarded: false },
        ],
      });
    const id = Number(fields(call).activity_id);
    assert.equal(observed.length, id === 22 ? 0 : 1);
    return json({ success: true, new_token_balance: id === 22 ? 150 : 175 });
  });
  const result = await game.claimTasks('all', async (item) => {
    await Promise.resolve();
    observed.push(item.id as number);
  });
  assert.deepEqual(observed, [22, 7]);
  assert.equal(result.failed, false);
  assert.equal(game.tokens, 175);
});

test('claim all with no tasks is successful and does not require CSRF', async () => {
  const { game, calls } = await fixture(
    () => json({ success: true, challenges: [] }),
    page('50', ''),
  );
  assert.deepEqual(await game.claimTasks('all'), { results: [], failed: false });
  assert.equal(calls.length, 2);
});

test('claim task errors are streamed once; already claimed remains successful', async () => {
  const responses = [
    { success: false, error: 'Reward already claimed' },
    { success: false, message: 'Task already completed today' },
    { success: false, error: 'Task not completed' },
  ];
  const { game, calls } = await fixture((_call, index) => json(responses[index]));
  const results: Data[] = [];
  const first = await game.claimTasks([1, 2], (item) => {
    results.push(item);
  });
  assert.equal(first.failed, false);
  assert.equal(game.tokens, 100);
  assert.equal((await game.claimTasks([3])).failed, true);
  assert.equal(game.tokens, undefined);
  assert.equal(results.length, 2);
  assert.equal(calls.length, 4);
  assert.ok(alreadyClaimed({ error: 'Reward already claimed' }));
});

test('successful claims without a balance invalidate the cached balance', async () => {
  const { game } = await fixture(() => json({ success: true }));
  await game.claimTasks([1]);
  assert.equal(game.tokens, undefined);
});

test('HTTP rejection cannot become a successful claim through its JSON success field', async () => {
  const { game, calls } = await fixture(() => json({ success: true, new_token_balance: 100 }, 403));
  assert.equal((await game.claimTasks([1])).failed, true);
  assert.equal(calls.length, 2);
});

test('claim callbacks finish before the next request and callback failures stop later claims', async () => {
  const { game, calls } = await fixture(() => json({ success: true, new_token_balance: 150 }));
  await assert.rejects(
    game.claimTasks([1, 2], async (item) => {
      assert.equal(item.id, 1);
      await Promise.resolve();
      throw new Error('callback stopped');
    }),
    /callback stopped/,
  );
  assert.equal(calls.length, 2);
});

test('invalid task IDs and malformed task lists fail before reward requests', async () => {
  const { game, calls } = await fixture(() =>
    json({ success: true, challenges: [{ id: 'bad', completed: true, rewarded: false }] }),
  );
  for (const ids of [[0], [-1], [NaN], [1.5], [Number.MAX_SAFE_INTEGER + 1]]) {
    await assert.rejects(game.claimTasks(ids), /positive integers/);
  }
  await assert.rejects(game.claimTasks('all'), /invalid task ID/);
  assert.equal(calls.length, 2);
});

test('reward failures preserve raw responses and never retry', async () => {
  for (const method of ['spin', 'scratch'] as const) {
    for (const [response, status] of [
      [{ success: false, error: 'Insufficient tokens' }, 200],
      [{ success: true }, 200],
      [{ value: '50', new_token_balance: 75, new_week_points: 100 }, 403],
    ] as const) {
      const { game, calls } = await fixture(() => json(response, status));
      await assert.rejects(game[method](), (error: unknown) => {
        assert.ok(error instanceof NcellError);
        assert.equal(error.status, status);
        assert.deepEqual(error.response, response);
        assert.equal(
          isInsufficientTokens(error),
          response.error === 'Insufficient tokens' && status === 200,
        );
        return true;
      });
      assert.equal(calls.length, 2);
      assert.equal(game.tokens, 100);
    }
  }
});

test('invalid JSON, nonobject responses and redirects are rejected without following', async () => {
  for (const response of [new Response('not-json'), json([]), json({ success: true }, 302)]) {
    const { game, calls } = await fixture(() => response);
    await assert.rejects(game.status(), NcellError);
    assert.equal(calls.length, 2);
  }
});

test('bootstrap failures and non-HTTP URLs are rejected', async () => {
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return new Response('', { status: 403 });
  };
  await assert.rejects(GameSession.open(`${origin}/index`, { fetch: fetcher }), /rejected/);
  await assert.rejects(GameSession.open('file:///secret', { fetch: fetcher }), /HTTP/);
  await assert.rejects(
    GameSession.open(`${origin}/index`, { timeoutMs: 0, fetch: fetcher }),
    /timeout/,
  );
  assert.equal(calls, 1);
});

test('request timeout aborts a local request without retry', async () => {
  let calls = 0;
  let attempts = 0;
  let requestSignal: AbortSignal | null | undefined;
  const server = createServer((_request, response) => {
    calls++;
    const timer = setTimeout(() => response.end(page()), 200);
    response.on('close', () => clearTimeout(timer));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      GameSession.open(`http://127.0.0.1:${address.port}/index`, {
        timeoutMs: 30,
        fetch: (input, init) => {
          attempts++;
          requestSignal = init?.signal;
          return fetch(input, init);
        },
      }),
      (error: unknown) => error instanceof NcellError && error.code === 'NETWORK_ERROR',
    );
    assert.ok(calls <= 1);
    assert.equal(attempts, 1);
    assert.equal(requestSignal?.aborted, true);
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, 'close');
  }
});

test('bootstrap cancellation preserves the caller reason and never retries', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel bootstrap');
  let attempts = 0;
  const fetcher: typeof fetch = (_input, init) => {
    attempts++;
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(reason);
    });
  };
  await assert.rejects(
    GameSession.open(`${origin}/index`, { fetch: fetcher, signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(attempts, 1);
  await assert.rejects(
    GameSession.open(`${origin}/index`, { fetch: fetcher, signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(attempts, 1);
});

test('cancelled game requests do not retry or poison a reused session', async () => {
  for (const kind of ['spin', 'scratch'] as const) {
    const controller = new AbortController();
    const reason = new Error(`cancel ${kind}`);
    const { game, calls } = await fixture((call, index) => {
      if (index === 0)
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
          controller.abort(reason);
        });
      return json({ value: '50', new_token_balance: 50, new_week_points: 100 });
    });
    await assert.rejects(
      game[kind]({ signal: controller.signal }),
      (error: unknown) => error === reason,
    );
    assert.equal(game.tokens, undefined);
    assert.equal(calls.length, 2);
    await game[kind]();
    assert.equal(game.tokens, 50);
    assert.equal(calls.length, 3);
  }
});

test('cancellation while reading a reward body preserves the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel body');
  const { game, calls } = await fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(new TextEncoder().encode('{"value":'));
          },
          pull(stream) {
            controller.abort(reason);
            stream.error(reason);
          },
        }),
      ),
  );
  await assert.rejects(
    game.spin({ signal: controller.signal }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls.length, 2);
  assert.equal(game.tokens, undefined);
});

test('a disconnected reward body invalidates its balance without retrying the reward', async () => {
  const { game, calls } = await fixture(
    () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(stream) {
            stream.error(new TypeError('Connection closed'));
          },
        }),
      ),
  );
  await assert.rejects(
    game.spin(),
    (error: unknown) => error instanceof NcellError && error.code === 'NETWORK_ERROR',
  );
  assert.equal(calls.length, 2);
  assert.equal(game.tokens, undefined);
});

test('math cancellation stops after its current answer and never requests another question', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel math');
  const { game, calls } = await fixture((_call, index) =>
    index === 0
      ? json({ success: true })
      : index === 1
        ? json({ level: 1, question: '1+1', options: [2, 3] })
        : json({ result: 'win', total_score: 5 }),
  );
  await assert.rejects(
    game.math({ signal: controller.signal, onAnswer: () => controller.abort(reason) }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls.length, 4);
  assert.equal(game.tokens, 75);
});

test('math cancellation while waiting for manual input never submits an answer', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel manual input');
  const { game, calls } = await fixture((_call, index) =>
    index === 0
      ? json({ success: true })
      : json({ level: 1, question: 'unknown(5)', options: [2, 3] }),
  );
  await assert.rejects(
    game.math({
      signal: controller.signal,
      manualAnswer: () => {
        queueMicrotask(() => controller.abort(reason));
        return new Promise<string>(() => {});
      },
    }),
    (error: unknown) => error === reason,
  );
  assert.equal(calls.length, 3);
});

test('math forwards cancellation to start, question and answer requests without replaying them', async () => {
  for (const stage of [0, 1, 2]) {
    const controller = new AbortController();
    const reason = new Error(`cancel math request ${stage}`);
    const { game, calls } = await fixture((call, index) => {
      if (index === stage)
        return new Promise((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
          controller.abort(reason);
        });
      return index === 0
        ? json({ success: true })
        : json({ level: 1, question: '1+1', options: [2, 3] });
    });
    await assert.rejects(
      game.math({ signal: controller.signal }),
      (error: unknown) => error === reason,
    );
    assert.equal(calls.length, stage + 2);
    assert.equal(game.tokens, undefined);
  }
});

test('safe math solver supports captured arithmetic, percentages and averages', () => {
  for (const [question, answer] of [
    ['6 + 6', 12],
    ['6 - 4', 2],
    ['11 + 3 × 9', 38],
    ['120 ÷ 10', 12],
    ['(5 × 10) + (4 × 3)', 62],
    ['25% of 8', 2],
    ['avg(22, 26, 12)', 20],
    ['20% of 75', 15],
    ['-2^2 + 5', 1],
    ['2^3^2', 512],
    ['1.5 + .5', 2],
  ] as const) {
    assert.equal(solveMath({ question, options: [answer, 999] }), String(answer));
  }
  for (const question of [
    '1/0',
    'unknown(5)',
    'process.exit()',
    '1; console.log(1)',
    'avg()',
    '2 ** 3',
    'globalThis.fetch("x")',
  ]) {
    assert.throws(() => solveMath({ question, options: [999] }), NcellError);
  }
  assert.throws(() => solveMath({ question: '1 + 1', options: [3] }), /not among/);
  assert.throws(() => solveMath({ question: '1 + 1' }), /invalid/);
  assert.throws(() => evaluateMath('('.repeat(100) + '1' + ')'.repeat(100)), /Unsupported/);
});

test('a complete math game streams twenty answers in order and does not refund bg_reward', async () => {
  const { game, calls } = await fixture((call, index) => {
    assert.equal(call.headers.get('User-Agent'), null);
    assert.equal(call.headers.get('Cookie'), 'PHPSESSID=shared');
    assert.ok(call.body instanceof URLSearchParams);
    const data = fields(call);
    assert.equal(data.csrf_token, 'csrf');
    if (index === 0) {
      assert.deepEqual(data, { action: 'start_game', csrf_token: 'csrf' });
      return json({ success: true, balance: 100 });
    }
    if (index % 2 === 1) {
      assert.deepEqual(data, { action: 'get_question', csrf_token: 'csrf' });
      return json({ level: Math.ceil(index / 2), question: '2 + 3', options: [5, 6, 7, 8] });
    }
    assert.deepEqual(data, { action: 'submit_answer', csrf_token: 'csrf', answer: '5' });
    return json({
      result: index === 40 ? 'win' : 'correct',
      total_score: (index / 2) * 5,
      bg_reward: 10,
    });
  });
  let answers = 0;
  const result = await game.math({
    onAnswer: async (item) => {
      answers++;
      assert.equal(item.level, answers);
      assert.equal(calls.length, 2 + answers * 2);
      await Promise.resolve();
    },
  });
  assert.equal(answers, 20);
  assert.equal(calls.length, 42);
  assert.equal(result.result, 'win');
  assert.equal(result.bg_reward, 10);
  assert.equal(game.tokens, 75);
});

test('unsupported math can use a validated manual answer', async () => {
  const { game, calls } = await fixture((call, index) => {
    if (index === 0) return json({ success: true });
    if (index === 1) return json({ level: 20, question: 'unknown(5)', options: [2, 4] });
    assert.equal(fields(call).answer, '2');
    return json({ result: 'win', total_score: 155 });
  });
  const result = await game.math({
    manualAnswer: async (question) => {
      assert.equal(question.question, 'unknown(5)');
      return ' 2 ';
    },
  });
  assert.equal(result.result, 'win');
  assert.equal(calls.length, 4);
});

test('unsupported math without a handler never guesses or submits an answer', async () => {
  const { game, calls } = await fixture((_call, index) =>
    index === 0
      ? json({ success: true })
      : json({ level: 1, question: 'unknown(5)', options: [2, 4] }),
  );
  await assert.rejects(
    game.math(),
    (error: unknown) => error instanceof NcellError && error.code === 'MANUAL_ANSWER_REQUIRED',
  );
  assert.equal(calls.length, 3);
});

test('manual answers absent from options are rejected before submission', async () => {
  const { game, calls } = await fixture((_call, index) =>
    index === 0
      ? json({ success: true })
      : json({ level: 1, question: 'unknown(5)', options: [2, 4] }),
  );
  await assert.rejects(game.math({ manualAnswer: async () => '3' }), /not among/);
  assert.equal(calls.length, 3);
});

test('failed math start never retries or requests questions and preserves tokens', async () => {
  const { game, calls } = await fixture(() => json({ success: false, error: 'Not enough points' }));
  await assert.rejects(game.math(), (error: unknown) => isInsufficientTokens(error));
  assert.equal(calls.length, 2);
  assert.equal(game.tokens, 100);
});

test('the captured low_balance math error is recognized as insufficient tokens', async () => {
  const { game, calls } = await fixture(() => json({ error: 'low_balance' }));
  await assert.rejects(game.math(), (error: unknown) => isInsufficientTokens(error));
  assert.equal(calls.length, 2);
  assert.equal(game.tokens, 100);
});

test('an empty non-JSON HTTP rejection reports the server status', async () => {
  const { game, calls } = await fixture(() => new Response('', { status: 403 }));
  await assert.rejects(game.checkIn(), (error: unknown) => {
    assert.ok(error instanceof NcellError);
    assert.equal(error.code, 'GAME_ERROR');
    assert.equal(error.status, 403);
    assert.equal(error.message, 'Game website rejected the request');
    return true;
  });
  assert.equal(calls.length, 2);
});

test('math handles a resumed session, game-over question and lost submit result', async () => {
  for (const final of [
    { game_over: true, total_score: 5 },
    { win: true, total_score: 165 },
  ]) {
    const { game, calls } = await fixture((_call, index) =>
      index === 0 ? json({ success: true, resumed: true }) : json(final),
    );
    assert.deepEqual(await game.math(), final);
    assert.equal(calls.length, 3);
  }
  const { game } = await fixture((_call, index) =>
    index === 0
      ? json({ success: true })
      : index === 1
        ? json({ level: 1, question: '1+1', options: [2, 3] })
        : json({ result: 'lose', total_score: 0 }),
  );
  assert.equal((await game.math()).result, 'lose');
});

test('repeated math reuses bootstrap and cookies, with a bounded unexpected server loop', async () => {
  const { game, calls } = await fixture((call) =>
    fields(call).action === 'start_game'
      ? json({ success: true })
      : json({ win: true, total_score: 165 }),
  );
  await game.math();
  await game.math();
  assert.equal(calls.length, 5);
  assert.equal(game.tokens, 50);
  const looping = await fixture((call) => {
    const action = fields(call).action;
    return action === 'start_game'
      ? json({ success: true })
      : action === 'get_question'
        ? json({ level: 1, question: '1+1', options: [2, 3] })
        : json({ result: 'wrong' });
  });
  await assert.rejects(looping.game.math(), /exceeded/);
  assert.equal(looping.calls.length, 122);
});

test('rankings parse current and last-week performance, prizes and identify you', () => {
  const result = parseRanks(`<h1>Leaderboard</h1><div class="sticky"><p>Week 41 • Oct 12</p></div>
    <div class="glass-card"><h2>Your Performance</h2><div class="rank-hero">#2</div>
      <span class="font-800">6,565</span><span class="font-800">260</span><span class="font-800">30</span>
      <div class="justify-between"><span>Period</span><span>This week</span></div></div>
    <div class="last-week-card"><div class="rank-hero-purple">#10</div><div class="font-800">32,721</div>
      <div class="rank-hero">50GB</div><div class="justify-between"><span>Period</span><span>Last week</span></div></div>
    <div class="space-y-2"><div><span class="font-900">#1</span><div class="truncate">9827***481</div>
      <div class="text-xs text-gray-400">2 days active</div><div class="text-right"><div class="font-900">11,840</div></div></div>
      <div><span class="font-900">#2</span><div class="truncate">9829***372</div><div class="text-right"><div class="font-900">6,565</div></div></div></div>
    <div class="divide-y"><div><span class="text-white font-semibold">1 - 10</span><div class="text-right"><span class="leading-none">50GB</span></div></div></div>`);
  assert.equal(result.week, 'Week 41');
  assert.deepEqual(result.performance, {
    rank: 2,
    points: 6565,
    tokens: 260,
    streak_days: 30,
    period: 'This week',
  });
  assert.deepEqual(result.last_week, {
    rank: 10,
    points: 32721,
    prize: '50GB',
    period: 'Last week',
  });
  assert.deepEqual(result.prizes, [{ ranks: '1 - 10', reward: '50GB' }]);
  const players = result.players as Data[];
  assert.equal(players[0]?.points, 11840);
  assert.equal(players[0]?.is_you, false);
  assert.equal(players[1]?.is_you, true);
});

test('rankings preserve missing values and reject login HTML', () => {
  const result = parseRanks(
    '<h1>Leaderboard</h1><div class="space-y-2"><div><span class="font-900">#1</span><div class="truncate">9827***481</div></div></div>',
  );
  assert.equal(result.performance, null);
  assert.equal(result.last_week, null);
  assert.equal((result.players as Data[])[0]?.points, null);
  assert.throws(() => parseRanks('<h1>Login required</h1>'), /invalid leaderboard/);
});
