import pc from 'picocolors';
import { sortPlans } from '../plans.js';

type Data = Record<string, unknown>;
type Alignment = 'left' | 'right';
interface Column {
  title: string;
  width?: number;
  align?: Alignment;
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nepalDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Kathmandu',
  month: 'short',
  day: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: true,
});

const record = (value: unknown): Data =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Data) : {};
const items = (value: unknown): Data[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const truth = (value: unknown): boolean => value === true || value === 1;
const numeric = (value: unknown): number | undefined => {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
};
const number = (value: unknown): string => {
  const result = numeric(value);
  return result === undefined ? '-' : result.toLocaleString('en-US');
};

/** Human price for a plan pack, shared by the list and the buy prompt. */
export function planPrice(offering: unknown): string {
  const price = record(offering);
  return price.priceUom === 'FREE' ? 'Free' : `Rs. ${text(price.price).replace(/\.00$/, '')}`;
}
const width = (value: string): number => [...value].length;
const pad = (value: string, size: number, align: Alignment = 'left'): string => {
  const space = ' '.repeat(Math.max(0, size - width(value)));
  return align === 'right' ? space + value : value + space;
};

/** Convert zoned dates to Nepal time; timezone-less server dates already use Nepal time. */
export function formatDate(value: unknown, assumeUtc = false): string {
  if (value === null || value === undefined || value === '') return 'Unknown';
  const source = value instanceof Date ? value.toISOString() : text(value);
  const iso =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/i.exec(
      source,
    );
  if (iso && (iso[7] || assumeUtc)) {
    const date = new Date(source.replace(' ', 'T') + (iso[7] ? '' : 'Z'));
    if (!Number.isNaN(date.valueOf())) {
      const parts = Object.fromEntries(
        nepalDate.formatToParts(date).map(({ type, value: part }) => [type, part]),
      );
      return `${parts.month} ${parts.day} ${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod}`;
    }
  }
  const local = iso
    ? [months[Number(iso[2]) - 1], iso[3], iso[1], iso[4], iso[5], iso[6]]
    : /^([A-Z][a-z]{2}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(source)?.slice(1);
  if (local && local[0]) {
    const hour = Number(local[3]);
    if (hour >= 0 && hour < 24) {
      return `${local[0]} ${local[1]?.padStart(2, '0')} ${local[2]} ${String(hour % 12 || 12).padStart(2, '0')}:${local[4]}:${local[5]} ${hour < 12 ? 'AM' : 'PM'}`;
    }
  }
  return source || 'Unknown';
}

function allowanceEmpty(value: Data): boolean {
  const zero = (item: unknown): boolean =>
    item === null || item === undefined || numeric(item) === 0;
  return !truth(value.hasUnlimitedResource) && zero(value.balance) && zero(value.initialAmount);
}

function allowance(value: Data, unit: string): string {
  if (truth(value.hasUnlimitedResource)) return 'Unlimited';
  let result = text(value.balance, '-');
  if (value.initialAmount !== null && value.initialAmount !== undefined)
    result += ` / ${text(value.initialAmount, '-')}`;
  if (text(value[unit])) result += ` ${text(value[unit])}`;
  const left = numeric(value.balance);
  const total = numeric(value.initialAmount);
  if (left !== undefined && total !== undefined && total > 0) {
    result += ` (${Math.round(Math.min(100, Math.max(0, (left / total) * 100)))}% left)`;
  }
  return result;
}

export interface FormatterOptions {
  write?: (text: string) => void;
  color?: boolean;
}

/** Terminal-only presentation shared by direct commands and the script runner. */
export class Formatter {
  private readonly write: (text: string) => void;
  private readonly colors: ReturnType<typeof pc.createColors>;

  constructor({
    write = (value) => process.stdout.write(value),
    color = process.stdout.isTTY === true,
  }: FormatterOptions = {}) {
    this.write = write;
    this.colors = pc.createColors(color);
  }

  message(value: string): void {
    this.write(`${value}\n`);
  }

  json(value: unknown): void {
    this.message(JSON.stringify(value, null, 2) ?? 'null');
  }

  progress(label: string): void {
    const split = label.indexOf(' · ');
    this.message(
      split < 0
        ? this.colors.cyan(this.colors.bold(label))
        : `${this.colors.cyan(this.colors.bold(label.slice(0, split)))} ${this.colors.dim('·')} ${this.colors.yellow(label.slice(split + 3))}`,
    );
  }

  private table(
    columns: Column[],
    rows: string[][],
    color?: (row: string, index: number) => string,
  ): void {
    const sizes = columns.map((column, index) =>
      Math.max(
        column.width ?? 0,
        width(column.title),
        ...rows.map((row) => width(row[index] ?? '')),
      ),
    );
    const line = (row: string[]): string =>
      columns
        .map((column, index) => pad(row[index] ?? '', sizes[index] ?? 0, column.align))
        .join('  ')
        .trimEnd();
    const header = line(columns.map((column) => column.title));
    this.message(header);
    this.message(
      '-'.repeat(sizes.reduce((sum, size) => sum + size, 0) + Math.max(0, columns.length - 1) * 2),
    );
    rows.forEach((row, index) => this.message(color ? color(line(row), index) : line(row)));
  }

  balance(raw: Data): void {
    const data = record(raw.queryBalanceResponse ?? raw);
    const kinds = [
      ['Data', 'aggregateDataBalance', 'dataBalanceList'],
      ['Voice', 'aggregateVoiceBalance', 'voiceBalanceList'],
      ['SMS', 'aggregateSmsBalance', 'smsBalanceList'],
      ['Bonus', '', 'bonusBalanceList'],
    ] as const;
    const credit = record(data.creditBalanceDetail);
    if (Object.keys(credit).length) {
      const amount = numeric(credit.balance);
      this.message(
        `${pad('Balance:', 15)} Rs. ${amount === undefined ? text(credit.balance, '-') : amount.toFixed(2)}`,
      );
    }
    for (const [kind, aggregateKey, listKey] of kinds) {
      const aggregate = record(data[aggregateKey]);
      if (
        aggregateKey &&
        Object.keys(aggregate).length &&
        !allowanceEmpty(aggregate) &&
        !items(data[listKey]).length
      ) {
        this.message(`${pad(`${kind}:`, 15)} ${allowance(aggregate, 'uom')}`);
      }
    }
    for (const [label, key] of [
      ['Last recharge', 'lastRechargeDate'],
      ['Expires', 'expiryDate'],
    ] as const) {
      if (text(credit[key])) this.message(`${pad(`${label}:`, 15)} ${formatDate(credit[key])}`);
    }
    const rows = kinds.flatMap(([kind, aggregateKey, listKey]) => {
      const packs = items(data[listKey]);
      return packs
        .filter((pack) => !allowanceEmpty(pack))
        .map((pack) => {
          const details = { ...pack };
          if (packs.length === 1) {
            const aggregate = record(data[aggregateKey]);
            for (const key of ['balance', 'uom', 'hasUnlimitedResource']) {
              if (details[key] === null || details[key] === undefined)
                details[key] = aggregate[key];
            }
          }
          return [
            kind,
            text(pack.accName) || text(pack.ncellName, '-'),
            allowance(details, 'uom'),
            formatDate(pack.expDate ?? '-'),
          ];
        });
    });
    if (rows.length) {
      this.message('');
      this.table(
        [
          { title: 'Type', width: 6 },
          { title: 'Pack' },
          { title: 'Remaining / Initial', width: 32 },
          { title: 'Expires' },
        ],
        rows,
      );
    }
  }

  profile(raw: Data): void {
    const data = record(raw.querySubscriberProfileResponse ?? raw);
    const states: Record<string, string> = {
      B01: 'Active (B01)',
      B03: 'All Services Blocked (B03)',
      B04: 'Outgoing Blocked (B04)',
    };
    const state = text(data.status);
    for (const [label, value] of [
      ['Number', text(raw.msisdn ?? data.msisdn ?? data.number)],
      ['Name', text(data.accountName)],
      ['SIM', text(data.simType)],
      ['Status', states[state] ?? state],
      ['Plan', text(record(data.subscriberDetail).ratePlanDisplayName)],
      ['Payment', text(record(data.paymentDetail).paidMode)],
    ]) {
      if (value) this.message(`${label}: ${value}`);
    }
  }

  status(raw: Data): void {
    if (
      raw.logged_in === false ||
      raw.loggedIn === false ||
      !text(raw.account ?? raw.msisdn ?? raw.number)
    ) {
      this.message('Not logged in.');
      return;
    }
    for (const [label, value, utc] of [
      ['Account', raw.account ?? raw.msisdn ?? raw.number, false],
      ['Logged in', raw.authenticated_at ?? raw.authenticatedAt, true],
      ['Token saved', raw.token_saved_at ?? raw.tokenSavedAt, true],
      ['Token expires', raw.access_token_expires_at ?? raw.accessTokenExpiresAt, false],
    ] as const) {
      this.message(
        `${pad(`${label}:`, 14)} ${label === 'Account' ? text(value, 'Unknown') : formatDate(value, utc)}`,
      );
    }
  }

  accounts(
    raw:
      | { accounts: Array<{ number: string; active: boolean }> }
      | Array<{ number: string; active: boolean }>,
  ): void {
    const accounts = Array.isArray(raw) ? raw : raw.accounts;
    if (!accounts.length) {
      this.message('No saved accounts.');
      return;
    }
    this.table(
      [{ title: 'Number', width: 12 }, { title: 'Status' }],
      accounts.map((account) => [account.number, account.active ? 'Active' : '']),
    );
  }

  categories(raw: Data): void {
    this.table(
      [{ title: 'ID', width: 6 }, { title: 'Category', width: 22 }, { title: 'Type' }],
      items(raw.tags).map((tag) => [
        text(tag.id),
        text(tag.name).trim(),
        items(tag.categories)
          .map((category) => text(category.displayName))
          .join(', '),
      ]),
    );
  }

  plans(raw: Data, sort = 'price'): void {
    const plans = items(sortPlans(raw, sort).availablePackages);
    if (!plans.length) {
      this.message('No plans available for this category and account.');
      return;
    }
    this.table(
      [
        { title: 'ID', width: 6 },
        { title: 'Plan' },
        { title: 'Price', width: 12, align: 'right' },
        { title: 'Validity', width: 10, align: 'right' },
      ],
      plans.map((plan) => {
        const tech = record(plan.techInfo);
        return [
          text(plan.id),
          text(record(plan.displayInfo).displayName).trim(),
          planPrice(plan.productOfferingPrice),
          `${text(tech.validity)} ${text(tech.validityUom)}`,
        ];
      }),
    );
  }

  taskStatus(raw: Data): void {
    const tasks = items(raw.challenges);
    if (!tasks.length) {
      this.message('No game tasks available.');
      return;
    }
    const states = tasks.map((task) =>
      truth(task.rewarded) ? 'Claimed' : truth(task.completed) ? 'Completed' : 'Pending',
    );
    this.table(
      [
        { title: 'ID', width: 6 },
        { title: 'Task' },
        { title: 'Progress', width: 9, align: 'right' },
        { title: 'Tokens', width: 6, align: 'right' },
        { title: 'XP', width: 6, align: 'right' },
        { title: 'Reset', width: 8 },
        { title: 'Status' },
      ],
      tasks.map((task, index) => [
        text(task.id),
        text(task.title),
        `${text(task.current_progress, '0')}/${text(task.target_value, '0')}`,
        text(task.reward_tokens, '0'),
        text(task.reward_xp, '0'),
        text(task.reset_type),
        states[index] ?? 'Pending',
      ]),
      (row, index) => {
        return states[index] === 'Claimed'
          ? this.colors.green(row)
          : states[index] === 'Completed'
            ? this.colors.cyan(row)
            : row;
      },
    );
  }

  ranks(raw: Data): void {
    this.message(this.colors.cyan(this.colors.bold(text(raw.week))));
    const current = record(raw.performance);
    if (Object.keys(current).length) {
      this.message(
        `${this.colors.bold(pad('Your performance:', 17))} Rank ${pad(`#${number(current.rank)}`, 6, 'right')} | Points ${pad(number(current.points), 8, 'right')} | Tokens ${number(current.tokens)} | Streak ${number(current.streak_days)} ${numeric(current.streak_days) === 1 ? 'day' : 'days'}`,
      );
    }
    const last = record(raw.last_week);
    if (last.rank !== null && last.rank !== undefined) {
      this.message(
        `${this.colors.bold(pad('Last week:', 17))} Rank ${pad(`#${number(last.rank)}`, 6, 'right')} | Points ${pad(number(last.points), 8, 'right')} | Prize ${text(last.prize).replace(/^[^a-z\d]+/i, '')}`,
      );
    }
    this.message(`\n${this.colors.bold('Weekly prizes')}`);
    this.table(
      [
        { title: 'Rank range', width: 14 },
        { title: 'Reward', width: 6, align: 'right' },
      ],
      items(raw.prizes).map((prize) => [text(prize.ranks), text(prize.reward)]),
    );
    this.message(`\n${this.colors.bold('Leaderboard')}`);
    this.table(
      [
        { title: 'Rank', width: 4, align: 'right' },
        { title: 'Player', width: 12 },
        { title: 'Points', width: 10, align: 'right' },
        { title: 'Activity' },
      ],
      items(raw.players).map((player) => [
        number(player.rank),
        text(player.number),
        number(player.points),
        `${text(player.activity)}${truth(player.is_you) || truth(player.isYou) || (player.rank !== null && player.rank !== undefined && player.rank === current.rank) ? '  (you)' : ''}`,
      ]),
    );
  }

  reward(kind: 'spin' | 'scratch', raw: Data, game = 1): void {
    // One claim-style line per game; only the math table keeps headers.
    const label = kind === 'spin' ? 'Spin' : 'Scratch';
    const tokens = kind === 'scratch' ? raw.points_remaining : raw.new_token_balance;
    this.message(
      `${label} ${game} completed. Reward awarded: ${text(raw.value, '-')}. Game tokens: ${text(tokens, '-')}. Weekly points: ${text(raw.new_week_points, '-')}.`,
    );
  }

  mathHeader(): void {
    this.table(
      [
        { title: 'Level', width: 5, align: 'right' },
        { title: 'Question', width: 28 },
        { title: 'Answer', width: 6, align: 'right' },
        { title: 'Result', width: 7 },
        { title: 'Score', width: 5, align: 'right' },
      ],
      [],
    );
  }

  mathAnswer(raw: Data): void {
    const response = record(raw.response);
    this.message(
      `${pad(number(raw.level), 5, 'right')}  ${pad(text(raw.question), 28)}  ${pad(text(raw.answer, '-'), 6, 'right')}  ${pad(text(response.result), 7)}  ${pad(number(response.score ?? response.total_score), 5, 'right')}`,
    );
  }

  mathSummary(raw: Data): void {
    this.message(
      `Math ${raw.result === 'win' || raw.win === true ? 'win' : 'game_over'} | Score ${number(raw.total_score ?? raw.score)}`,
    );
  }

  checkIn(raw: Data): void {
    const message = text(raw.message) || text(raw.error);
    if (/already checked/i.test(message)) {
      this.message('Already checked in today.');
      return;
    }
    const data = record(raw.data);
    this.message(
      `Check-in successful. Streak: ${text(data.current_streak, '-')} ${numeric(data.current_streak) === 1 ? 'day' : 'days'}. Weekly points: ${text(data.weekly_points, '-')}. Game tokens: ${text(data.game_tokens, '-')}.`,
    );
  }

  claimTask(raw: Data): void {
    const response = record(raw.response ?? raw);
    const id = text(raw.id ?? response.id, '-');
    this.message(
      response.success === true
        ? `Task ${id} claimed. Reward awarded: ${text(response.points_awarded, '-')}. Game tokens: ${text(response.new_token_balance, '-')}. Weekly points: ${text(response.new_week_points, '-')}.`
        : `Task ${id}: ${text(response.message) || text(response.error) || 'Claim failed'}`,
    );
  }
}
