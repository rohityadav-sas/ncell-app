import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CommanderError } from 'commander';
import { NcellApp } from '../src/app.js';
import { MemorySessionStore, NcellError } from '../src/core/index.js';
import { ScriptExecutionError, ScriptLibrary } from '../src/scripts.js';
import { parseCommand } from '../src/cli/parse.js';
import { openDocs } from '../src/cli/open.js';
import { confirmSubscribe, errorOutput, runCli } from '../src/cli/program.js';

const primary = '9800000000';
const secondary = '9800000001';
const quiet = { out: () => {}, err: () => {} };
const parse = (args: string[]) => parseCommand(args, quiet);

function harness() {
  const store = new MemorySessionStore({
    deviceId: 'device-a',
    account: {
      msisdn: primary,
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
      authenticatedAt: '2026-10-12T15:48:14Z',
    },
    otherAccounts: [
      {
        deviceId: 'device-b',
        account: {
          msisdn: secondary,
          accessToken: 'access-b',
          refreshToken: 'refresh-b',
          authenticatedAt: '2026-10-12T15:48:14Z',
        },
      },
    ],
  });
  const requests: Array<{ url: string; init: RequestInit; data: Record<string, unknown> }> = [];
  let tokens = 100;
  let output = '';
  let stderr = '';
  let prompts = 0;
  let custom:
    | ((url: string, init: RequestInit) => Response | undefined | Promise<Response | undefined>)
    | undefined;
  const ok = (value: Record<string, unknown>) =>
    Response.json({ responseHeader: { responseCode: '200' }, ...value });
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const data: Record<string, unknown> =
      typeof init.body === 'string' && init.body.startsWith('{')
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {};
    requests.push({ url, init, data });
    const special = await custom?.(url, init);
    if (special) return special;
    if (url.includes('/otp/generate')) return ok({});
    if (url.includes('/otp/validate'))
      return ok({
        validateOTPResponse: {
          accessToken: 'new-access',
          refreshToken: 'new-refresh',
          expiresIn: 3600,
        },
      });
    if (url.includes('/refresh/token'))
      return ok({
        userAuthResponse: {
          accessToken: 'rotated-access',
          refreshToken: 'rotated-refresh',
          expiresIn: 3600,
        },
      });
    if (url.includes('/balance/query'))
      return ok({
        queryBalanceResponse: {
          creditBalanceDetail: { balance: 28.42179038, expiryDate: 'Oct 12 2026 23:59:59' },
        },
      });
    if (url.includes('/profile/query'))
      return ok({
        querySubscriberProfileResponse: {
          accountName: 'Test Account',
          simType: '4G',
          status: 'B01',
        },
      });
    if (url.includes('/product-catalog/tags'))
      return ok({
        tags: [{ id: 50, name: 'SMS', categories: [{ name: 'GSM_SMS', displayName: 'SMS' }] }],
      });
    if (url.includes('-plans'))
      return ok({
        availablePackages: [
          {
            id: '2',
            ncellName: 'Second',
            displayInfo: { displayName: 'Second plan' },
            productOfferingPrice: { price: '50.00' },
            techInfo: { subscriptionCode: 'second', validity: 30, validityUom: 'DAY' },
          },
          {
            id: '1',
            ncellName: 'First',
            displayInfo: { displayName: 'First plan' },
            productOfferingPrice: { price: '15.00' },
            techInfo: { subscriptionCode: 'first', validity: 1, validityUom: 'DAY' },
          },
        ],
      });
    if (url.includes('/product/subscribe'))
      return ok({ productSubscriptionSummaryResponse: { status: 'success' } });
    if (url.includes('/free/sms/send')) return ok({ sendFreeSMSResponse: { status: 'success' } });
    if (url.includes('/third-party-encryption'))
      return ok({ encryptionResponse: { msisdn: 'encrypted' } });
    if (url.includes('index.php?'))
      return new Response(
        `<input name="csrf_token" value="csrf"><span id="tokens-display">${tokens}</span>`,
        { headers: { 'Set-Cookie': 'sid=mock; Path=/' } },
      );
    if (url.endsWith('challenge_status.php'))
      return Response.json({
        success: true,
        challenges: [
          {
            id: 1,
            title: 'Check Balance',
            current_progress: 1,
            target_value: 1,
            reward_tokens: 10,
            reward_xp: 0,
            reset_type: 'daily',
            completed: true,
            rewarded: false,
          },
        ],
      });
    if (url.endsWith('ranks.php'))
      return new Response('<h1>Leaderboard</h1><div class="sticky"><p>Week 41 Rankings</p></div>');
    if (url.endsWith('checkin.php'))
      return Response.json({ success: false, message: 'Already checked in today' });
    if (url.endsWith('record_activity.php'))
      return Response.json({ success: false, error: 'Task already completed today' });
    if (url.endsWith('fetchSpinReward.php')) {
      tokens -= 25;
      return Response.json({
        value: '50',
        description: '50 Points',
        new_token_balance: tokens,
        new_week_points: 5000,
      });
    }
    if (url.endsWith('fetchScratchReward.php')) {
      tokens -= 25;
      return Response.json({
        value: '50',
        description: '50 Points',
        points_remaining: tokens,
        new_week_points: 5050,
      });
    }
    throw new Error(`Unmocked request: ${url}`);
  };
  const app = new NcellApp({ store, fetch: fetcher, baseUrl: 'https://api.test' });
  const io = {
    out: (text: string) => {
      output += text;
    },
    err: (text: string) => {
      stderr += text;
    },
    prompt: async () => {
      prompts++;
      return '123456';
    },
    color: false,
    terminal: false,
  };
  return {
    app,
    store,
    requests,
    io,
    output: () => output,
    stderr: () => stderr,
    prompts: () => prompts,
    custom: (fn: NonNullable<typeof custom>) => {
      custom = fn;
    },
    clear: () => {
      output = '';
      stderr = '';
    },
  };
}

test('parse every CLI command family with global JSON and standard defaults', () => {
  const cases: Array<[string[], string]> = [
    [['login', primary], 'login'],
    [['account', 'add', secondary, '--verify'], 'account add'],
    [['account', 'list'], 'account list'],
    [['account', 'switch', secondary], 'account switch'],
    [['account', 'remove', secondary], 'account remove'],
    [['status'], 'status'],
    [['logout'], 'logout'],
    [['refresh'], 'refresh'],
    [['balance'], 'balance'],
    [['profile'], 'profile'],
    [['sms', 'send-free', secondary, 'hello world'], 'sms send-free'],
    [['plans'], 'plans'],
    [['plans', 'categories'], 'plans categories'],
    [
      ['plans', 'search', 'SMS', '--category', '50', '--sort', 'validity:desc,price'],
      'plans search',
    ],
    [['plans', 'subscribe', '1'], 'plans subscribe'],
    ...['check-in', 'status', 'ranks', 'spin', 'scratch', 'math'].map(
      (action): [string[], string] => [['game', action], `game ${action}`],
    ),
    [['game', 'claim-task', '1,2', '3'], 'game claim-task'],
    ...['create', 'run', 'edit', 'delete'].map((action): [string[], string] => [
      ['script', action, 'daily.ncell'],
      `script ${action}`,
    ]),
    [['script', 'list'], 'script list'],
    [['docs'], 'docs'],
  ];
  for (const [argv, command] of cases) {
    assert.equal(parse(argv).command, command);
    assert.equal(parse(['--json', ...argv]).json, true);
    assert.equal(parse([...argv, '--json']).json, true);
  }
  assert.deepEqual(parse(['game', 'claim-task', '1,2', '3']).args, ['1', '2', '3']);
  assert.equal(parse(['game', 'spin']).count, 1);
  assert.equal(parse(['game', 'spin']).delay, 0);
  assert.equal(parse(['plans', 'subscribe', '1', '--yes']).yes, true);
  assert.equal(parse(['plans', 'subscribe', '1', '--dry-run']).dryRun, true);
  assert.equal(parse(['plans', 'subscribe', '1']).yes, undefined);
  assert.equal(parse(['plans']).category, 66);
  assert.equal(parse(['plans']).sort, 'price');
  assert.equal(parse(['plans', 'search', 'SMS', '--category', '50']).category, 50);
  assert.equal(parse(['plans', 'search', 'SMS', '--sort', 'validity:desc']).sort, 'validity:desc');
  assert.equal(parse(['game', 'scratch', '--count', 'all', '--delay', '1.5h']).delay, 5400);
  assert.equal(parse(['game', 'math', '--delay', '.5s']).delay, 0.5);
});

test('docs opens the packaged documentation without a browser side effect in tests', async () => {
  let opened = '';
  const file = await openDocs(async (target) => {
    opened = target;
  });
  assert.match(file, /docs.index\.html$/);
  assert.match(opened, /^file:.*docs.index\.html$/);
});

test('invalid commands, counts, delays, destinations and task IDs fail before execution', () => {
  const invalid = [
    [],
    ['account', 'lis'],
    ['balance', 'unexpected'],
    ['game', 'spin', '--max-games', '5'],
    ['game', 'spin', '--count', '0'],
    ['game', 'spin', '--count', '-1'],
    ['game', 'spin', '--count', '1.5'],
    ['game', 'spin', '--count', 'Infinity'],
    ['game', 'spin', '--count', '9007199254740992'],
    ['game', 'spin', '--delay', '-1'],
    ['game', 'spin', '--delay', '1d'],
    ['game', 'spin', '--delay', 'NaN'],
    ['game', 'spin', '--delay', 'Infinity'],
    ['game', 'claim-task', 'all,1'],
    ['game', 'claim-task', '1,,2'],
    ['game', 'claim-task', '0'],
    ['game', 'claim-task', '-1'],
    ['game', 'claim-task', '1.5'],
    ['plans', '--sort', 'name'],
    ['plans', '--sort', 'price:up'],
    ['plans', '--category', '-1'],
    ['plans', 'search', '   '],
    ['plans', 'subscribe', ''],
    ['plans', '--category', '50', 'categories'],
    ['login', '1234'],
    ['account', 'switch', 'example'],
    ['sms', 'send-free', secondary, '   '],
  ];
  for (const argv of invalid) assert.throws(() => parse(argv), Error, argv.join(' '));
});

test('help and version are successful parser exits for every family', async () => {
  const { version } = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  for (const argv of [
    ['--help'],
    ['--version'],
    ['account', '--help'],
    ['game', '--help'],
    ['plans', '--help'],
    ['sms', '--help'],
    ['script', '--help'],
  ]) {
    let stdout = '';
    assert.throws(
      () =>
        parseCommand(argv, {
          out: (text) => {
            stdout += text;
          },
          err: () => {},
        }),
      (error) => error instanceof CommanderError && error.exitCode === 0,
    );
    assert.ok(stdout.trim());
    if (argv[0] === '--version') assert.equal(stdout.trim(), version);
  }
});

test('real SDK executes account, read-only, free-SMS and purchase command families through mocks', async () => {
  const h = harness();
  for (const argv of [
    ['balance'],
    ['profile', '--json'],
    ['plans', 'categories'],
    ['plans'],
    ['plans', 'search', 'SMS', '--category', '50'],
    ['sms', 'send-free', secondary, 'A quoted message with spaces'],
    ['plans', 'subscribe', '1', '--yes'],
    ['game', 'status'],
    ['game', 'ranks'],
    ['game', 'check-in'],
    ['game', 'claim-task', '1,2'],
    ['game', 'spin'],
    ['game', 'scratch'],
    ['refresh'],
    ['account', 'list'],
    ['account', 'switch', secondary],
    ['status'],
    ['account', 'remove', primary],
    ['logout'],
    ['status'],
  ])
    await runCli(argv, { app: h.app, io: h.io });
  assert.match(h.output(), /Balance:        Rs\. 28\.42/);
  assert.match(h.output(), /SMS sent to 9800000001\./);
  assert.match(h.output(), /Subscribed to First plan\./);
  assert.match(h.output(), /Already checked in today\./);
  assert.match(h.output(), /Task 1: Task already completed today/);
  assert.match(h.output(), /Account:       9800000001/);
  assert.match(h.output(), /Not logged in\.\n$/);
  const sms = h.requests.find((request) => request.url.includes('/free/sms/send'));
  assert.deepEqual(sms?.data.sendSMSFreeRequest, {
    destination: secondary,
    content: 'A quoted message with spaces',
    isConfirm: 0,
  });
  const purchase = h.requests.find((request) => request.url.includes('/product/subscribe'));
  assert.equal(
    (purchase?.data.productSubscriptionSummaryRequest as Record<string, unknown>)?.subscriptionCode,
    'first',
  );
  assert.equal(
    (purchase?.data.productSubscriptionSummaryRequest as Record<string, unknown>)?.deviceId,
    'device-a',
  );
  assert.equal(h.requests.filter((request) => request.url.includes('index.php?')).length, 1);
  assert.equal(
    h.requests.filter((request) => request.url.includes('/third-party-encryption')).length,
    1,
  );
  assert.equal(h.prompts(), 0);
  assert.equal(h.stderr(), '');
});

test('plans subscribe confirms on a terminal, refuses pipes and supports dry runs', async () => {
  const prompt = { asked: 0, answer: 'y' };
  const io = {
    out: () => {},
    err: () => {},
    prompt: async () => {
      prompt.asked++;
      return prompt.answer;
    },
    color: false,
    terminal: true,
  };
  await confirmSubscribe(io, 'First plan', 'Rs. 15', false, true);
  assert.equal(prompt.asked, 1);
  await confirmSubscribe(io, 'First plan', 'Rs. 15', true, true);
  assert.equal(prompt.asked, 1);
  await assert.rejects(confirmSubscribe(io, 'First plan', 'Rs. 15', false, false), /without --yes/);
  prompt.answer = 'n';
  await assert.rejects(
    confirmSubscribe(io, 'First plan', 'Rs. 15', false, true),
    /Subscription cancelled/,
  );
  const h = harness();
  await runCli(['plans', 'subscribe', '1', '--dry-run'], { app: h.app, io: h.io });
  assert.match(h.output(), /Would subscribe to First plan for Rs\. 15\./);
  assert.equal(
    h.requests.filter((request) => request.url.includes('/product/subscribe')).length,
    0,
  );
  await assert.rejects(
    runCli(['plans', 'subscribe', '1'], { app: h.app, io: h.io }),
    /without --yes/,
  );
  assert.equal(
    h.requests.filter((request) => request.url.includes('/product/subscribe')).length,
    0,
  );
});

test('login requests and verifies OTP while account add keeps the active account', async () => {
  const h = harness();
  await runCli(['account', 'add', secondary], { app: h.app, io: h.io });
  assert.equal((await h.app.status()).account, primary);
  assert.equal(h.prompts(), 1);
  assert.deepEqual(
    h.requests
      .filter((r) => /otp\/(generate|validate)/.test(r.url))
      .map((r) => r.url.split('/').at(-1)),
    ['generate', 'validate'],
  );
  await h.app.requestOtp(secondary);
  const before = h.requests.length;
  await runCli(['login', secondary, '--verify'], { app: h.app, io: h.io });
  assert.equal((await h.app.status()).account, secondary);
  assert.equal(h.requests.length, before + 1);
  assert.ok(h.requests.at(-1)?.url.endsWith('/otp/validate'));
  assert.equal((await h.app.listAccounts()).length, 2);
});

test('all JSON command results are pretty and never contain decorative terminal output', async () => {
  const h = harness();
  await runCli(['sms', 'send-free', secondary, 'hello', '--json'], { app: h.app, io: h.io });
  assert.match(h.output(), /^\{\n  "responseHeader": \{/);
  assert.deepEqual(JSON.parse(h.output()).sendFreeSMSResponse, { status: 'success' });
  assert.doesNotMatch(h.output(), /SMS sent|\x1b/);
});

test('JSON plan output uses the same selected sorting as human output', async () => {
  const h = harness();
  await runCli(['plans', '--sort', 'price', '--json'], { app: h.app, io: h.io });
  assert.deepEqual(
    JSON.parse(h.output()).availablePackages.map((plan: Record<string, unknown>) => plan.id),
    ['1', '2'],
  );
  h.clear();
  await runCli(['plans', 'search', 'SMS', '--sort', 'validity:desc', '--json'], {
    app: h.app,
    io: h.io,
  });
  assert.deepEqual(
    JSON.parse(h.output()).availablePackages.map((plan: Record<string, unknown>) => plan.id),
    ['2', '1'],
  );
});

test('human profile output includes the current account number', async () => {
  const h = harness();
  await runCli(['profile'], { app: h.app, io: h.io });
  assert.match(h.output(), /^Number: 9800000000\nName: Test Account/);
});

test('human spin results print one line per game without progress tables', async () => {
  const h = harness();
  await runCli(['game', 'spin', '--count', '2'], { app: h.app, io: h.io });
  assert.match(
    h.output(),
    /^Spin 1 completed\. Reward awarded: 50\. Game tokens: 75\. Weekly points: 5000\.\n/,
  );
  assert.match(
    h.output(),
    /Spin 2 completed\. Reward awarded: 50\. Game tokens: 50\. Weekly points: 5000\.\n$/,
  );
  assert.doesNotMatch(h.output(), /Game \d+ of \d/);
  assert.equal(
    h.requests.filter((request) => request.url.endsWith('fetchSpinReward.php')).length,
    2,
  );
});

test('all-token play reports an affordable total and stops without a max-games option', async () => {
  const h = harness();
  await runCli(['game', 'spin', '--count', 'all'], { app: h.app, io: h.io });
  assert.match(
    h.output(),
    /Spin 1 completed\. Reward awarded: 50\. Game tokens: 75\. Weekly points: 5000\./,
  );
  assert.match(
    h.output(),
    /Spin 4 completed\. Reward awarded: 50\. Game tokens: 0\. Weekly points: 5000\./,
  );
  assert.match(h.output(), /No tokens left for another game\.\n$/);
  assert.equal(
    h.requests.filter((request) => request.url.endsWith('fetchSpinReward.php')).length,
    4,
  );
  assert.doesNotMatch(h.output(), /limit|max-games/);
});

test('math runs through the CLI and prompts for an unsupported question', async () => {
  const h = harness();
  h.custom((url, init) => {
    if (!url.endsWith('math_challenge_api.php')) return undefined;
    assert.ok(init.body instanceof URLSearchParams);
    const form = init.body;
    if (form.get('action') === 'start_game') return Response.json({ success: true });
    if (form.get('action') === 'get_question')
      return Response.json({
        success: true,
        level: 1,
        question: 'unsupported(4)',
        options: [4, 5, 6],
        time: 20,
      });
    assert.equal(form.get('answer'), '4');
    return Response.json({ success: true, result: 'win', total_score: 165, bg_reward: 10 });
  });
  let prompt = '';
  const answers = ['999', '4'];
  await runCli(['game', 'math'], {
    app: h.app,
    io: {
      ...h.io,
      prompt: async (message) => {
        prompt = message;
        return answers.shift() ?? '';
      },
    },
  });
  assert.match(prompt, /unsupported\(4\).*\nOptions: 4, 5, 6/);
  assert.equal(answers.length, 0);
  assert.match(h.stderr(), /Choose one of the displayed answer values\./);
  assert.match(h.output(), /^Level  Question\s+Answer  Result\s+Score/);
  assert.match(h.output(), /Math win \| Score 165/);
  assert.doesNotMatch(h.output(), /bg_reward|Tokens awarded/);
  assert.equal(
    h.requests.filter((request) => request.url.endsWith('math_challenge_api.php')).length,
    3,
  );
});

test('delay countdown uses stderr for terminals and stays out of structured JSON', async () => {
  const h = harness();
  await runCli(['game', 'spin', '--count', '2', '--delay', '.15s'], {
    app: h.app,
    io: { ...h.io, terminal: true },
  });
  assert.match(h.stderr(), /Next game in/);
  assert.doesNotMatch(h.output(), /Next game in/);
  h.clear();
  await runCli(['game', 'scratch', '--count', '2', '--delay', '.01s', '--json'], {
    app: h.app,
    io: { ...h.io, terminal: true },
  });
  assert.equal(h.stderr(), '');
  assert.doesNotMatch(h.output(), /Next game in|\x1b/);
});

test('script validates the entire file before requests or account changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  await writeFile(
    join(root, 'invalid.ncell'),
    `balance\naccount switch ${secondary}\ngame spin --count 0\n`,
    'utf8',
  );
  const h = harness();
  await assert.rejects(
    runCli(['script', 'run', 'invalid.ncell'], { app: h.app, scripts, io: h.io }),
    /Line 3/,
  );
  assert.equal(h.requests.length, 0);
  assert.equal((await h.app.status()).account, primary);
  assert.equal(h.output(), '');
});

test('script prevalidation rejects help and empty plan arguments before any effects', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  for (const invalid of ['game --help', 'plans search " "', 'plans subscribe ""']) {
    await writeFile(join(root, 'invalid.ncell'), `balance\n${invalid}\n`, 'utf8');
    const h = harness();
    await assert.rejects(
      runCli(['script', 'run', 'invalid.ncell'], { app: h.app, scripts, io: h.io }),
      /Line 2/,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.output(), '');
  }
});

test('script quoted SMS and purchase commands use only injected mock requests', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  await writeFile(
    join(root, 'quoted.ncell'),
    'sms send-free 9800000001 "Hello; $5 | literal text"\nplans subscribe "1" --yes\n',
    'utf8',
  );
  const h = harness();
  await runCli(['script', 'run', 'quoted.ncell'], { app: h.app, scripts, io: h.io });
  const sms = h.requests.find((request) => request.url.includes('/free/sms/send'));
  assert.equal(
    (sms?.data.sendSMSFreeRequest as Record<string, unknown>).content,
    'Hello; $5 | literal text',
  );
  assert.equal(
    h.requests.filter((request) => request.url.includes('/product/subscribe')).length,
    1,
  );
  assert.match(h.output(), /^Step 1 of 2 · sms send-free/);
  assert.match(h.output(), /\n\nStep 2 of 2 · plans subscribe "1" --yes\n\n/);
});

test('CLI create, edit, list and delete share the saved script library', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const opened: string[] = [];
  const scripts = new ScriptLibrary(root, async (file) => {
    opened.push(file);
  });
  const h = harness();
  await runCli(['script', 'create', 'daily.ncell'], { app: h.app, scripts, io: h.io });
  await runCli(['script', 'edit', 'daily.ncell'], { app: h.app, scripts, io: h.io });
  assert.deepEqual(opened, [join(root, 'daily.ncell'), join(root, 'daily.ncell')]);
  h.clear();
  await runCli(['script', 'list', '--json'], { app: h.app, scripts, io: h.io });
  assert.deepEqual(JSON.parse(h.output()), { scripts: ['daily.ncell'] });
  await runCli(['script', 'delete', 'daily.ncell'], { app: h.app, scripts, io: h.io });
  assert.deepEqual(await scripts.list(), []);
  assert.equal(h.requests.length, 0);
});

test('script failures identify step and file line, stop subsequent commands and never retry rewards', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  await writeFile(
    join(root, 'fail.ncell'),
    '# Example\nstatus\n\ngame spin\nsms send-free 9800000001 "must not send"\n',
    'utf8',
  );
  const h = harness();
  h.custom((url) =>
    url.endsWith('fetchSpinReward.php')
      ? Response.json({ success: false, error: 'Not enough points' })
      : undefined,
  );
  await assert.rejects(
    runCli(['script', 'run', 'fail.ncell'], { app: h.app, scripts, io: h.io }),
    /Step 2 of 3 \(line 4\): Not enough points/,
  );
  assert.equal(
    h.requests.filter((request) => request.url.endsWith('fetchSpinReward.php')).length,
    1,
  );
  assert.equal(h.requests.filter((request) => request.url.includes('/free/sms/send')).length, 0);
  assert.match(h.output(), /^Step 1 of 3 · status\n\nAccount:       9800000000/);
  assert.match(h.output(), /\n\nStep 2 of 3 · game spin\n\n/);
  assert.doesNotMatch(h.output(), /Step 3|Completed/);
});

test('script JSON associates pretty results with step, total, line and command', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  await writeFile(join(root, 'json.ncell'), '# Example\nstatus\n\naccount list\n', 'utf8');
  const h = harness();
  await runCli(['script', 'run', 'json.ncell', '--json'], { app: h.app, scripts, io: h.io });
  const results = JSON.parse(`[${h.output().trim().replace(/}\n\{/g, '},{')}]`) as Array<
    Record<string, unknown>
  >;
  assert.equal(results.length, 3);
  assert.deepEqual(
    Object.fromEntries(Object.entries(results[0] ?? {}).filter(([key]) => key !== 'result')),
    { event: 'result', step: 1, total: 2, line: 2, command: 'status' },
  );
  assert.equal((results[0]?.result as Record<string, unknown>).account, primary);
  assert.equal(results[1]?.line, 4);
  assert.deepEqual(results[2], { event: 'complete', steps: 2 });
  assert.doesNotMatch(h.output(), /Step 1|Account:|\x1b/);
});

test('account selection in scripts affects following requests and retains device bindings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell cli tests '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const scripts = new ScriptLibrary(root, async () => {});
  await writeFile(
    join(root, 'switch.ncell'),
    `balance\naccount switch ${secondary}\nbalance\naccount switch ${primary}\nplans subscribe 1 --yes\n`,
    'utf8',
  );
  const h = harness();
  await runCli(['script', 'run', 'switch.ncell'], { app: h.app, scripts, io: h.io });
  const balance = h.requests.filter((request) => request.url.includes('/balance/query'));
  assert.deepEqual(
    balance.map((request) => (request.data.queryBalanceRequest as Record<string, unknown>).msisdn),
    [primary, secondary],
  );
  assert.deepEqual(
    balance.map((request) => new Headers(request.init.headers).get('authorization')),
    ['Bearer access-a', 'Bearer access-b'],
  );
  const purchase = h.requests.find((request) => request.url.includes('/product/subscribe'));
  assert.equal(
    (purchase?.data.productSubscriptionSummaryRequest as Record<string, unknown>).deviceId,
    'device-a',
  );
  assert.equal((await h.app.status()).account, primary);
  assert.equal((await h.app.listAccounts()).length, 2);
});

test('error JSON preserves structured server responses through script failure causes', () => {
  const cause = new NcellError('Not enough points', {
    code: 'GAME_ERROR',
    status: 200,
    response: { error: 'Not enough points' },
  });
  const error = new ScriptExecutionError(3, 14, 6, cause);
  assert.equal(
    errorOutput(error, false),
    'Error: Step 3 of 14 (line 6): Not enough points (HTTP 200)\n',
  );
  assert.deepEqual(JSON.parse(errorOutput(error, true)), {
    error: 'Step 3 of 14 (line 6): Not enough points (HTTP 200)',
    step: 3,
    total: 14,
    line: 6,
    code: 'GAME_ERROR',
    status: 200,
    response: { error: 'Not enough points' },
  });
});
