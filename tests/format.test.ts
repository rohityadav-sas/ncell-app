import assert from 'node:assert/strict';
import test from 'node:test';
import { Formatter, formatDate } from '../src/cli/format.js';

function capture(color = false): { formatter: Formatter; output: () => string } {
  let output = '';
  return {
    formatter: new Formatter({
      write: (text) => {
        output += text;
      },
      color,
    }),
    output: () => output,
  };
}

test('dates use Nepal time for UTC metadata and preserve server-local timestamps', () => {
  assert.equal(formatDate('2026-10-12T15:50:49.120820900Z'), 'Oct 12 2026 09:35:49 PM');
  assert.equal(formatDate('2026-10-12T15:50:49', true), 'Oct 12 2026 09:35:49 PM');
  assert.equal(formatDate('2026-10-12T21:50:50'), 'Oct 12 2026 09:50:50 PM');
  assert.equal(formatDate('Aug 15 2026 21:17:00'), 'Aug 15 2026 09:17:00 PM');
  assert.equal(formatDate('Oct 12 2026 00:00:00'), 'Oct 12 2026 12:00:00 AM');
  assert.equal(formatDate('Oct 12 2026 12:00:00'), 'Oct 12 2026 12:00:00 PM');
  assert.equal(formatDate(null), 'Unknown');
  assert.equal(formatDate('invalid'), 'invalid');
});

test('balance formats rupees, omits account and zero allowances, and uses complete separators', () => {
  const { formatter, output } = capture();
  formatter.balance({
    msisdn: '9800000000',
    creditBalanceDetail: { balance: '28.42179038', expiryDate: 'Oct 12 2026 23:59:59' },
    aggregateDataBalance: { balance: 0, initialAmount: 0, uom: 'Bytes' },
    aggregateVoiceBalance: { hasUnlimitedResource: true },
    voiceBalanceList: [
      {
        accName: 'Unlimited Night Minutes (10PM–5AM)',
        initialAmount: 420,
        expDate: 'Oct 12 2026 23:23:43',
      },
    ],
    smsBalanceList: [{ balance: 0, initialAmount: 0 }],
  });
  assert.match(output(), /^Balance:        Rs\. 28\.42\nExpires:        Oct 12 2026 11:59:59 PM\n/);
  assert.doesNotMatch(output(), /9800000000|Bytes|SMS|Voice:/);
  assert.match(output(), /Unlimited Night Minutes.*Unlimited.*11:23:43 PM/);
  const lines = output().trimEnd().split('\n');
  const separator = lines.find((line) => /^-+$/.test(line));
  assert.ok(separator);
  assert.ok(
    separator.length >=
      Math.max(...lines.slice(lines.indexOf(separator) + 1).map((line) => [...line].length)),
  );
});

test('balance hides aggregate redundancy and formats nonzero allowances', () => {
  const { formatter, output } = capture();
  formatter.balance({
    creditBalanceDetail: { balance: 0 },
    aggregateDataBalance: { balance: 56.64, initialAmount: 60, uom: 'GB' },
    dataBalanceList: [
      {
        accName: 'Free_Data',
        balance: 56.64,
        initialAmount: 60,
        uom: 'GB',
        expDate: 'Oct 19 2026 10:59:59',
      },
    ],
    aggregateSmsBalance: { balance: 100, initialAmount: 100, uom: 'SMS-Items' },
  });
  assert.match(
    output(),
    /^Balance:        Rs\. 0\.00\nSMS:            100 \/ 100 SMS-Items \(100% left\)/,
  );
  assert.doesNotMatch(output(), /Data:/);
  assert.match(output(), /56\.64 \/ 60 GB \(94% left\)/);
});

test('status exposes only sanitized metadata with aligned labels', () => {
  const { formatter, output } = capture();
  formatter.status({
    logged_in: true,
    msisdn: '9800000000',
    authenticated_at: '2026-10-12T15:48:14Z',
    token_saved_at: null,
    access_token_expires_at: '2026-10-12T21:50:50',
    access_token: 'secret',
  });
  assert.equal(
    output(),
    'Account:       9800000000\nLogged in:     Oct 12 2026 09:33:14 PM\nToken saved:   Unknown\nToken expires: Oct 12 2026 09:50:50 PM\n',
  );
  assert.doesNotMatch(output(), /secret|validity|Times/);
});

test('status accepts the public SDK metadata and recognizes an empty session', () => {
  const { formatter, output } = capture();
  formatter.status({ account: '9800000000', authenticatedAt: '2026-10-12T15:48:14Z' });
  formatter.status({});
  assert.match(output(), /^Account:       9800000000\nLogged in:     Oct 12 2026 09:33:14 PM/);
  assert.match(output(), /Not logged in\.\n$/);
});

test('profile includes readable SIM status and skips absent fields', () => {
  const { formatter, output } = capture();
  formatter.profile({
    msisdn: '9800000000',
    accountName: 'Example',
    simType: '4G',
    status: 'B04',
    subscriberDetail: { ratePlanDisplayName: 'Prepaid' },
    paymentDetail: { paidMode: 'PRE' },
  });
  assert.equal(
    output(),
    'Number: 9800000000\nName: Example\nSIM: 4G\nStatus: Outgoing Blocked (B04)\nPlan: Prepaid\nPayment: PRE\n',
  );
});

test('plans align price and validity to the right and sort without modifying the response', () => {
  const { formatter, output } = capture();
  const plans = [
    {
      id: '2',
      displayInfo: { displayName: 'Long plan' },
      productOfferingPrice: { price: '50.00' },
      techInfo: { validity: 30, validityUom: 'DAY' },
    },
    {
      id: '1',
      displayInfo: { displayName: 'Short' },
      productOfferingPrice: { price: '15.00' },
      techInfo: { validity: 1, validityUom: 'DAY' },
    },
  ];
  formatter.plans({ availablePackages: plans });
  const lines = output().trimEnd().split('\n');
  assert.match(lines[2] ?? '', /^1\s+Short\s+Rs\. 15\s+1 DAY$/);
  assert.match(lines[3] ?? '', /^2\s+Long plan\s+Rs\. 50\s+30 DAY$/);
  assert.equal(lines[2]?.length, lines[3]?.length);
  assert.equal(plans[0]?.id, '2');
  assert.equal((lines[0] ?? '').lastIndexOf('Validity') + 'Validity'.length, lines[2]?.length);
});

test('task rows are entirely colored while headers remain plain', () => {
  const { formatter, output } = capture(true);
  formatter.taskStatus({
    challenges: [
      {
        id: 1,
        title: 'Claimed task',
        current_progress: 1,
        target_value: 1,
        reward_tokens: 25,
        reward_xp: 0,
        reset_type: 'daily',
        rewarded: 1,
      },
      {
        id: 2,
        title: 'Ready task',
        current_progress: 1,
        target_value: 1,
        reward_tokens: 25,
        reward_xp: 0,
        reset_type: 'daily',
        completed: true,
      },
      {
        id: 3,
        title: 'Pending task',
        current_progress: 0,
        target_value: 1,
        reward_tokens: 25,
        reward_xp: 0,
        reset_type: 'daily',
      },
    ],
  });
  const lines = output().trimEnd().split('\n');
  assert.doesNotMatch(lines[0] ?? '', /\x1b/);
  assert.match(lines[2] ?? '', /^\x1b\[32m1 .*Claimed\x1b\[39m$/);
  assert.match(lines[3] ?? '', /^\x1b\[36m2 .*Completed\x1b\[39m$/);
  assert.doesNotMatch(lines[4] ?? '', /\x1b/);
});

test('rankings put prizes before leaderboard and identify the current player without top-three coloring', () => {
  const { formatter, output } = capture(true);
  formatter.ranks({
    week: 'Week 41 Rankings',
    performance: { rank: 2, points: 6565, tokens: 260, streak_days: 1 },
    last_week: { rank: 10, points: 32721, prize: '🥇 50GB' },
    prizes: [{ ranks: '1 - 10', reward: '50GB' }],
    players: [
      { rank: 1, number: '9827***481', points: 11840, activity: '2 days active' },
      { rank: 2, number: '9829***372', points: 6565, activity: '2 days active', is_you: true },
    ],
  });
  assert.ok(output().indexOf('Weekly prizes') < output().indexOf('Leaderboard'));
  assert.match(output(), /Points\s+6,565 \| Tokens 260 \| Streak 1 day/);
  assert.match(output(), /Prize 50GB/);
  assert.match(output(), /9829\*\*\*372.*\(you\)/);
  const rows = output()
    .split('\n')
    .filter((line) => /982[79]\*\*\*/.test(line));
  assert.ok(rows.every((line) => !line.includes('\x1b')));
  assert.ok(!output().startsWith('\n'));
  assert.ok(!output().endsWith('\n\n'));
});

test('math is streamed as an aligned table and bg_reward is hidden only in normal output', () => {
  const { formatter, output } = capture();
  formatter.mathHeader();
  formatter.mathAnswer({
    level: 1,
    question: '9 + 4',
    answer: '13',
    response: { result: 'correct', score: 5 },
  });
  formatter.mathAnswer({
    level: 20,
    question: 'avg(17, 11, 23)',
    answer: '17',
    response: { result: 'win', total_score: 165 },
  });
  formatter.mathSummary({ result: 'win', total_score: 165, bg_reward: 10 });
  assert.match(output(), /^Level  Question\s+Answer  Result\s+Score\n-+\n/);
  const rows = output().trimEnd().split('\n');
  assert.equal(rows[2]?.indexOf('correct'), rows[3]?.indexOf('win'));
  assert.match(output(), /Math win \| Score 165\n$/);
  assert.doesNotMatch(output(), /bg_reward|Tokens awarded/);
  formatter.json({ bg_reward: 10 });
  assert.match(output(), /\{\n  "bg_reward": 10\n\}\n$/);
});

test('reward results read as single lines and script progress distinguishes index and command', () => {
  const { formatter, output } = capture(true);
  formatter.progress('Step 1 of 3 · ncell game spin --count 3');
  formatter.reward('spin', {
    value: '250',
    description: '250 Points',
    new_token_balance: 60,
    new_week_points: 8720,
  });
  formatter.reward(
    'scratch',
    {
      value: '50',
      description: '50 Points',
      points_remaining: 35,
      new_week_points: 8770,
    },
    2,
  );
  assert.match(output(), /\x1b\[36m.*Step 1 of 3/);
  assert.match(output(), /\x1b\[33mncell game spin --count 3\x1b\[39m/);
  assert.match(
    output(),
    /Spin 1 completed\. Reward awarded: 250\. Game tokens: 60\. Weekly points: 8720\./,
  );
  assert.match(
    output(),
    /Scratch 2 completed\. Reward awarded: 50\. Game tokens: 35\. Weekly points: 8770\./,
  );
});

test('empty states and already-completed rewards remain clear', () => {
  const { formatter, output } = capture();
  formatter.accounts({ accounts: [] });
  formatter.status({ logged_in: false });
  formatter.plans({ availablePackages: [] });
  formatter.taskStatus({ challenges: [] });
  formatter.checkIn({ success: false, message: 'Already checked in today' });
  formatter.claimTask({
    id: 1,
    response: { success: false, error: 'Task already completed today' },
  });
  assert.equal(
    output(),
    'No saved accounts.\nNot logged in.\nNo plans available for this category and account.\nNo game tasks available.\nAlready checked in today.\nTask 1: Task already completed today\n',
  );
});

test('categories, accounts and successful claims preserve conventional output', () => {
  const { formatter, output } = capture();
  formatter.categories({
    tags: [{ id: 50, name: 'SMS', categories: [{ displayName: 'All-net' }] }],
  });
  formatter.accounts([
    { number: '9800000000', active: true },
    { number: '9800000001', active: false },
  ]);
  formatter.claimTask({
    id: 22,
    response: { success: true, points_awarded: 50, new_token_balance: 75, new_week_points: 6695 },
  });
  formatter.checkIn({
    success: true,
    data: { current_streak: 1, weekly_points: 6695, game_tokens: 75 },
  });
  assert.match(output(), /50\s+SMS\s+All-net/);
  assert.match(output(), /9800000000\s+Active/);
  assert.match(
    output(),
    /Task 22 claimed\. Reward awarded: 50\. Game tokens: 75\. Weekly points: 6695\./,
  );
  assert.match(
    output(),
    /Check-in successful\. Streak: 1 day\. Weekly points: 6695\. Game tokens: 75\./,
  );
});
