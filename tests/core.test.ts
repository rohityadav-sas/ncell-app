import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountService,
  MemorySessionStore,
  NcellError,
  normalizeNumber,
} from '../src/core/index.js';
import type { JsonObject, Session } from '../src/core/index.js';

interface Captured {
  url: string;
  body: JsonObject;
  headers: Headers;
  init: RequestInit;
}

function mockFetch(replies: Array<{ status?: number; body: unknown }>): {
  fetch: typeof fetch;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      assert.equal(typeof init?.body, 'string');
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push({
        url,
        body: JSON.parse(String(init?.body)) as JsonObject,
        headers: new Headers(init?.headers),
        init: init ?? {},
      });
      const reply = replies.shift();
      assert.ok(reply, `Unexpected request ${url}`);
      return new Response(
        typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body),
        { status: reply.status ?? 200 },
      );
    },
  };
}

function ok(extra: JsonObject = {}): { body: JsonObject } {
  return { body: { responseHeader: { responseCode: '200' }, ...extra } };
}

function rejected(code: string, status = 401): { status: number; body: JsonObject } {
  return {
    status,
    body: { responseHeader: { responseCode: String(status), responseDescDisplay: code } },
  };
}

function session(): Session {
  return {
    deviceId: 'first-device',
    account: {
      msisdn: '9812345678',
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      authenticatedAt: '2026-10-13T00:00:00Z',
    },
    otherAccounts: [
      {
        deviceId: 'second-device',
        account: {
          msisdn: '9823456789',
          accessToken: 'second-access',
          refreshToken: 'second-refresh',
          authenticatedAt: '2026-10-12T00:00:00Z',
        },
      },
    ],
  };
}

function body(call: Captured | undefined, key: string): JsonObject {
  assert.ok(call);
  return call.body[key] as JsonObject;
}

test('normalizes only supported Nepal numbers and rejects invalid input before requests', async () => {
  assert.equal(normalizeNumber('+9779812345678'), '9812345678');
  const server = mockFetch([]);
  const client = new AccountService({ fetch: server.fetch, store: new MemorySessionStore() });
  for (const value of ['hello', '981234567', '8812345678', ' 9812345678']) {
    await assert.rejects(client.requestOtp(value), /10-digit Nepal/);
  }
  await assert.rejects(client.verifyOtp('9812345678', 'abc'), /4 to 8/);
  await assert.rejects(client.verifyOtp('9812345678', '123456'), /No pending OTP/);
  await assert.rejects(client.sendFreeSms('9812345678', ' '), /cannot be empty/);
  await assert.rejects(client.balance(), /No saved account/);
  await assert.rejects(client.plans({ category: -1 }), /Category/);
  await assert.rejects(client.subscribe(' '), /cannot be empty/);
  assert.equal(server.calls.length, 0);
});

test('login preserves pending device identity, minimum payloads, metadata and leading-zero OTP', async () => {
  const server = mockFetch([
    ok(),
    ok({
      validateOTPResponse: {
        accessToken: 'access',
        refreshToken: 'refresh',
        expiresIn: '2026-10-13T23:59:59',
      },
    }),
  ]);
  const store = new MemorySessionStore();
  const client = new AccountService({ fetch: server.fetch, store });
  assert.deepEqual(await client.requestOtp('+9779812345678'), {
    otpRequested: true,
    msisdn: '9812345678',
  });
  const pending = await store.load();
  assert.equal(pending?.deviceId.length, 16);
  assert.equal(pending?.pendingMsisdn, '9812345678');
  const result = await client.verifyOtp('9812345678', '001234');
  assert.deepEqual(result, { loggedIn: true, msisdn: '9812345678', active: true });
  const saved = await store.load();
  assert.equal(saved?.deviceId, pending?.deviceId);
  assert.equal(saved?.pendingMsisdn, undefined);
  assert.equal(saved?.account?.accessTokenExpiresAt, '2026-10-13T23:59:59');
  assert.ok(saved?.account?.tokenSavedAt);
  assert.equal(Object.keys(body(server.calls[0], 'requestHeader')).length, 10);
  assert.equal(Object.keys(body(server.calls[0], 'generateOTPRequest')).length, 3);
  assert.equal(Object.keys(body(server.calls[1], 'requestHeader')).length, 10);
  assert.deepEqual(body(server.calls[1], 'validateOTPRequest').otpDetail, {
    action: 'LOGIN',
    otp: '001234',
  });
  for (const call of server.calls) {
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.equal(call.headers.get('authorization'), null);
    assert.equal(call.headers.get('user-agent'), null);
    assert.equal(call.init.redirect, 'manual');
  }
  assert.equal('accessToken' in (await client.status()), false);
  assert.equal(JSON.stringify(await client.listAccounts()).includes('refresh'), false);
});

test('failed OTP generation preserves identity and failed validation preserves all accounts', async () => {
  const server = mockFetch([rejected('OTP2006', 400), rejected('OTP2006', 400)]);
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: server.fetch, store });
  await assert.rejects(client.requestOtp('9834567890'));
  const pending = await store.load();
  assert.equal(pending?.pendingMsisdn, '9834567890');
  assert.equal(pending?.deviceId, 'first-device');
  await assert.rejects(client.verifyOtp('9834567890', '123456'));
  assert.deepEqual(await store.load(), pending);
  assert.equal(server.calls.length, 2);
});

test('adding, switching, re-login, removing and logout preserve each account device and tokens', async () => {
  const server = mockFetch([
    ok(),
    ok({ userAuthResponse: { accessToken: 'third-access' } }),
    ok(),
    ok({ validateOTPResponse: { accessToken: 'second-new' } }),
  ]);
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: server.fetch, store });
  await client.requestOtp('9834567890');
  assert.equal((await client.verifyOtp('9834567890', '123456', { activate: false })).active, false);
  assert.equal((await client.status()).account, '9812345678');
  assert.equal((await client.listAccounts()).length, 3);
  const firstIdentity = await client.sessionIdentity();
  assert.equal(firstIdentity.includes('old-access'), false);
  await client.switchAccount('9823456789');
  assert.equal((await store.load())?.deviceId, 'second-device');
  assert.notEqual(await client.sessionIdentity(), firstIdentity);
  await client.requestOtp('9823456789');
  await client.verifyOtp('9823456789', '123456');
  assert.equal((await client.listAccounts()).length, 3);
  await client.removeAccount('9834567890');
  assert.equal((await client.listAccounts()).length, 2);
  await client.logout();
  assert.equal((await client.status()).account, '9812345678');
  assert.equal((await store.load())?.deviceId, 'first-device');
  await assert.rejects(client.switchAccount('9823456789'), /not saved/);
  await client.removeAccount('9812345678');
  assert.equal(await store.load(), undefined);
  assert.deepEqual(await client.listAccounts(), []);
  assert.deepEqual(await client.status(), {});
  await client.logout();
});

test('account add from empty saves without selecting, then switch activates it', async () => {
  const server = mockFetch([ok(), ok({ validateOTPResponse: { accessToken: 'access' } })]);
  const client = new AccountService({ fetch: server.fetch, store: new MemorySessionStore() });
  await client.requestOtp('9812345678');
  await client.verifyOtp('9812345678', '123456', { activate: false });
  assert.deepEqual(await client.status(), {});
  assert.deepEqual(await client.listAccounts(), [{ msisdn: '9812345678', active: false }]);
  await client.switchAccount('9812345678');
  assert.equal((await client.status()).account, '9812345678');
});

test('refresh rotates only active tokens, preserves device and missing refresh token, and records expiry', async () => {
  const server = mockFetch([
    ok({
      userAuthResponse: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresIn: '3600',
      },
    }),
    ok({ userAuthResponse: { accessToken: 'newer-access' } }),
  ]);
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: server.fetch, store });
  const oldIdentity = await client.sessionIdentity();
  await client.refresh();
  const rotated = await store.load();
  assert.equal(rotated?.account?.refreshToken, 'new-refresh');
  assert.ok(rotated?.account?.accessTokenExpiresAt?.endsWith('Z'));
  assert.equal(rotated?.deviceId, 'first-device');
  assert.deepEqual(rotated?.otherAccounts, session().otherAccounts);
  assert.notEqual(await client.sessionIdentity(), oldIdentity);
  await client.refresh();
  assert.equal((await store.load())?.account?.refreshToken, 'new-refresh');
  assert.equal((await store.load())?.account?.accessTokenExpiresAt, undefined);
  assert.deepEqual(body(server.calls[0], 'refreshTokenRequest'), { refreshToken: 'old-refresh' });
  assert.equal(body(server.calls[0], 'requestHeader').deviceId, 'first-device');
  assert.equal(body(server.calls[0], 'requestHeader').action, 'LOGOUT_ACTION');
  assert.equal(Object.keys(body(server.calls[0], 'requestHeader')).length, 11);
});

test('expired access refreshes exactly once and persists before replay', async () => {
  const server = mockFetch([
    rejected('LGN2001'),
    ok({ userAuthResponse: { accessToken: 'new-access', refreshToken: 'new-refresh' } }),
    ok({ queryBalanceResponse: { paidMode: 'Prepaid' } }),
  ]);
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: server.fetch, store });
  assert.deepEqual(await client.balance(), { paidMode: 'Prepaid' });
  assert.deepEqual(
    server.calls.map((call) => call.headers.get('authorization')),
    ['Bearer old-access', null, 'Bearer new-access'],
  );
  assert.equal((await store.load())?.account?.refreshToken, 'new-refresh');
  assert.equal(server.calls.length, 3);
});

test('other rejections never refresh or retry; failed refresh preserves every account', async () => {
  for (const [code, status] of [
    ['LGN2004', 401],
    ['LGN2001', 500],
    ['BIL2006', 400],
  ] as const) {
    const server = mockFetch([rejected(code, status)]);
    const store = new MemorySessionStore(session());
    const client = new AccountService({ fetch: server.fetch, store });
    await assert.rejects(
      client.balance(),
      (error) => error instanceof NcellError && error.code === code && error.status === status,
    );
    assert.equal(server.calls.length, 1);
    assert.deepEqual(await store.load(), session());
  }
  const server = mockFetch([rejected('LGN2001'), rejected('LGN2004')]);
  const store = new MemorySessionStore(session());
  await assert.rejects(
    new AccountService({ fetch: server.fetch, store }).balance(),
    (error) => error instanceof NcellError && error.code === 'LGN2004',
  );
  assert.equal(server.calls.length, 2);
  assert.deepEqual(await store.load(), session());
});

test('a rejected replay is final and empty token success cannot overwrite a session', async () => {
  const server = mockFetch([
    rejected('LGN2001'),
    ok({ userAuthResponse: { accessToken: 'new' } }),
    rejected('LGN2001'),
  ]);
  await assert.rejects(
    new AccountService({ fetch: server.fetch, store: new MemorySessionStore(session()) }).balance(),
  );
  assert.equal(server.calls.length, 3);
  const bad = mockFetch([ok({ userAuthResponse: { accessToken: ' ' } })]);
  const store = new MemorySessionStore(session());
  await assert.rejects(
    new AccountService({ fetch: bad.fetch, store }).refresh(),
    /invalid response/,
  );
  assert.deepEqual(await store.load(), session());
});

test('balance, profile, SMS and encryption use the proven minimal bodies', async () => {
  const server = mockFetch([
    ok({ queryBalanceResponse: { balances: [] } }),
    ok({ querySubscriberProfileResponse: { name: 'Test' } }),
    ok({ sendFreeSMSResponse: { status: 'success' } }),
    ok({ encryptionResponse: { msisdn: 'encoded%2Fvalue' } }),
  ]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  assert.deepEqual(await client.balance(), { balances: [] });
  assert.deepEqual(await client.profile(), { name: 'Test' });
  await client.sendFreeSms('+9779823456789', 'quoted "hello"');
  assert.equal(
    (await client.gameIdentity()).url,
    'https://sajeeb.com.np/ncellapp/checkin/index.php?MSISDN=encoded%2Fvalue',
  );
  assert.equal(Object.keys(body(server.calls[0], 'requestHeader')).length, 10);
  assert.deepEqual(body(server.calls[0], 'queryBalanceRequest'), { msisdn: '9812345678' });
  assert.deepEqual(body(server.calls[1], 'querySubscriberProfileRequest'), {});
  assert.equal(Object.keys(body(server.calls[1], 'requestHeader')).length, 11);
  assert.deepEqual(body(server.calls[2], 'sendSMSFreeRequest'), {
    destination: '9823456789',
    content: 'quoted "hello"',
    isConfirm: 0,
  });
  assert.equal(Object.keys(body(server.calls[3], 'requestHeader')).length, 1);
  assert.equal(Object.keys(server.calls[3]?.body ?? {}).length, 2);
});

test('catalog categories are cached per account, copied, expire and select SMS and voice endpoints', async (context) => {
  let now = 1_000;
  context.mock.method(Date, 'now', () => now);
  const tags = [
    { id: 50, categories: [{ name: 'GSM_SMS' }] },
    { id: 61, categories: [{ name: 'GSM_VOICE' }] },
  ];
  const server = mockFetch([
    ok({ tags }),
    ok({ availablePackages: [] }),
    ok({ availablePackages: [] }),
    ok({ tags }),
    ok({ tags }),
  ]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  const original = await client.categories();
  original.tags = [];
  assert.deepEqual((await client.categories()).tags, tags);
  await client.plans({ category: 50, keyword: 'SMS' });
  await client.plans({ category: 61 });
  assert.ok(server.calls[1]?.url.endsWith('/product/sms-plans'));
  assert.ok(server.calls[2]?.url.endsWith('/product/voice-plans'));
  assert.equal(server.calls[1]?.body.keyword, 'SMS');
  for (const call of server.calls.slice(1, 3)) {
    assert.deepEqual(call?.body.sortby, { name: 'price', isDescending: false });
    assert.equal(call?.body.pageableDto, undefined);
  }
  assert.equal(Object.keys(server.calls[1]?.body ?? {}).length, 6);
  assert.equal(Object.keys(server.calls[2]?.body ?? {}).length, 5);
  await assert.rejects(client.plans({ category: 999 }), /Unknown category/);
  await client.switchAccount('9823456789');
  await client.categories();
  await client.switchAccount('9812345678');
  now += 600_001;
  await client.categories();
  assert.equal(server.calls.length, 5);
});

test('failed catalog replies are not cached', async () => {
  const server = mockFetch([ok({}), ok({ tags: [] })]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  await assert.rejects(client.categories(), /invalid response/);
  assert.deepEqual((await client.categories()).tags, []);
  assert.equal(server.calls.length, 2);
});

test('purchase uses catalog metadata and saved device, accepts BIL1000 only on billing success', async () => {
  const plan = {
    id: 'pack',
    techInfo: { subscriptionCode: '5021027' },
    ncellName: 'Sample',
    productOfferingPrice: { price: '0.00' },
  };
  const server = mockFetch([
    ok({ availablePackages: [plan] }),
    {
      body: {
        responseHeader: { responseCode: '00', responseDescDisplay: 'BIL1000' },
        productSubscriptionSummaryResponse: { status: 'success' },
      },
    },
  ]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  await client.subscribe('pack');
  const subscription = body(server.calls[1], 'productSubscriptionSummaryRequest');
  assert.equal(subscription.deviceId, 'first-device');
  assert.equal(subscription.productPrice, '0.00');
  assert.equal(subscription.subscriptionCode, '5021027');
  assert.equal(Object.keys(subscription).length, 11);
  assert.equal(Object.keys(body(server.calls[1], 'requestHeader')).length, 12);
  const rejectedPurchase = mockFetch([ok({ availablePackages: [plan] }), rejected('BIL2006', 400)]);
  await assert.rejects(
    new AccountService({
      fetch: rejectedPurchase.fetch,
      store: new MemorySessionStore(session()),
    }).subscribe('pack'),
  );
  assert.equal(rejectedPurchase.calls.length, 2);
});

test('malformed, unsafe encryption and unsuccessful SMS responses fail safely', async () => {
  const server = mockFetch([
    { status: 502, body: '<html>private diagnostics</html>' },
    ok({ encryptionResponse: { msisdn: 'x&evil=yes' } }),
    ok({ sendFreeSMSResponse: { status: 'error' } }),
    ok({}),
  ]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  await assert.rejects(
    client.balance(),
    (error) => error instanceof NcellError && !error.message.includes('private'),
  );
  await assert.rejects(client.gameIdentity(), /invalid response/);
  await assert.rejects(client.sendFreeSms('9823456789', 'test'), /invalid response/);
  await assert.rejects(client.profile(), /invalid response/);
});

test('network failure and timeout are distinguished without request retries', async () => {
  for (const [cause, code] of [
    [new TypeError('private network info'), 'NETWORK'],
    [new DOMException('timeout', 'TimeoutError'), 'TIMEOUT'],
  ] as const) {
    let count = 0;
    const request: typeof fetch = async () => {
      count += 1;
      throw cause;
    };
    const client = new AccountService({ fetch: request, store: new MemorySessionStore(session()) });
    await assert.rejects(
      client.balance(),
      (error) =>
        error instanceof NcellError && error.code === code && !error.message.includes('private'),
    );
    assert.equal(count, 1);
  }
});

test('body-stream timeout and disconnect remain network errors after response headers arrive', async () => {
  for (const [cause, code] of [
    [new DOMException('body timeout', 'TimeoutError'), 'TIMEOUT'],
    [new TypeError('socket terminated'), 'NETWORK'],
  ] as const) {
    let calls = 0;
    const request: typeof fetch = async () => {
      calls += 1;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(cause);
          },
        }),
      );
    };
    const client = new AccountService({ fetch: request, store: new MemorySessionStore(session()) });
    await assert.rejects(
      client.balance(),
      (error) => error instanceof NcellError && error.code === code,
    );
    assert.equal(calls, 1);
  }
});

test('unknown response codes cannot inherit descriptions from Object.prototype', async () => {
  const server = mockFetch([
    { status: 400, body: { responseHeader: { responseCode: 'constructor' } } },
  ]);
  const client = new AccountService({
    fetch: server.fetch,
    store: new MemorySessionStore(session()),
  });
  await assert.rejects(
    client.balance(),
    (error) =>
      error instanceof NcellError &&
      error.message === 'Ncell rejected the request (HTTP 400, code constructor)',
  );
});

test('game encryption cancellation is honored before requests and preserves the caller reason', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled by caller');
  controller.abort(reason);
  const server = mockFetch([]);
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: server.fetch, store });
  await assert.rejects(client.gameIdentity(controller.signal), (error) => error === reason);
  assert.equal(server.calls.length, 0);
  assert.deepEqual(await store.load(), session());
});

test('game encryption cancellation propagates into fetch and never starts an auth refresh', async () => {
  const controller = new AbortController();
  const reason = new NcellError('Caller stopped', { code: 'LGN2001', status: 401 });
  let count = 0;
  const request: typeof fetch = async (_input, init) => {
    count += 1;
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init.signal.aborted, false);
    controller.abort(reason);
    assert.equal(init.signal.aborted, true);
    throw reason;
  };
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: request, store });
  await assert.rejects(client.gameIdentity(controller.signal), (error) => error === reason);
  assert.equal(count, 1);
  assert.deepEqual(await store.load(), session());
});

test('cancelling game encryption during expired-token refresh prevents replay and preserves saved state', async () => {
  const controller = new AbortController();
  const reason = new Error('Cancelled during refresh');
  let count = 0;
  const request: typeof fetch = async (input, init) => {
    count += 1;
    if (count === 1) {
      return new Response(JSON.stringify(rejected('LGN2001').body), { status: 401 });
    }
    assert.ok(String(input).endsWith('/refresh/token'));
    assert.ok(init?.signal instanceof AbortSignal);
    controller.abort(reason);
    assert.equal(init.signal.aborted, true);
    throw reason;
  };
  const store = new MemorySessionStore(session());
  const client = new AccountService({ fetch: request, store });
  await assert.rejects(client.gameIdentity(controller.signal), (error) => error === reason);
  assert.equal(count, 2);
  assert.deepEqual(await store.load(), session());
});

test('shared-store auth transactions serialize rotation and account switching', async () => {
  const store = new MemorySessionStore(session());
  let allowRefresh = (): void => {};
  const gate = new Promise<void>((resolve) => {
    allowRefresh = resolve;
  });
  const order: string[] = [];
  const request: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith('/refresh/token')) {
      order.push('refresh');
      await gate;
      return new Response(
        JSON.stringify(ok({ userAuthResponse: { accessToken: 'rotated' } }).body),
      );
    }
    throw new Error('Unexpected request');
  };
  const first = new AccountService({ store, fetch: request });
  const second = new AccountService({ store, fetch: request });
  const refreshing = first.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  const switching = second.switchAccount('9823456789').then(() => {
    order.push('switch');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['refresh']);
  allowRefresh();
  await Promise.all([refreshing, switching]);
  assert.deepEqual(order, ['refresh', 'switch']);
  const final = await store.load();
  assert.equal(final?.account?.msisdn, '9823456789');
  assert.equal(final?.otherAccounts[0]?.account.accessToken, 'rotated');
});
