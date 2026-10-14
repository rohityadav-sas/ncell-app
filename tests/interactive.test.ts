import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Option } from 'commander';
import { NcellApp } from '../src/app.js';
import { MemorySessionStore } from '../src/core/index.js';
import { ScriptLibrary } from '../src/scripts.js';
import { CompletionEngine, cleanLabel } from '../src/cli/completion.js';
import type { Completion } from '../src/cli/completion.js';
import { InteractiveEditor } from '../src/cli/interactive-editor.js';
import { InteractiveTheme, cellWidth } from '../src/cli/interactive-view.js';
import { viewport } from '../src/cli/interactive.js';
import { createProgram, parseCommand } from '../src/cli/parse.js';
import { runCli } from '../src/cli/program.js';

const quiet = { out: () => {}, err: () => {} };
const engine = () =>
  new CompletionEngine({
    categories: async () => ({ tags: [] }),
    scripts: { directory: '', list: async () => [] },
  });
const names = (completion: Completion) => completion.items.map((item) => item.value);

test('completion schema follows Commander metadata, including future commands and options', async () => {
  const program = createProgram(() => {}, quiet);
  program
    .command('future')
    .description('New metadata command')
    .argument('<target>', 'Metadata target')
    .addOption(new Option('--mode <mode>', 'Metadata mode').choices(['fast', 'slow']));
  const completion = new CompletionEngine({
    categories: async () => ({}),
    scripts: { directory: '', list: async () => [] },
    program,
  });
  const root = await completion.suggest('fu');
  assert.equal(root.items[0]?.description, 'New metadata command');
  assert.equal(
    (await completion.suggest('future ', undefined, true)).hint,
    '<target>  ·  Metadata target · Required',
  );
  assert.deepEqual(names(await completion.suggest('future --mode ', undefined, true)), [
    'fast',
    'slow',
  ]);
  for (const command of program.commands.filter((command) => command.name() !== 'interactive')) {
    const rootItem = (await completion.suggest('', 0, true)).items.find(
      (item) => item.value === command.name(),
    );
    assert.equal(rootItem?.description, command.description());
    for (const child of command.commands) {
      const suggestion = (
        await completion.suggest(`${command.name()} `, undefined, true)
      ).items.find((item) => item.value === child.name());
      assert.equal(suggestion?.description, child.description());
    }
  }
});

test('blank and generic whitespace menus stay hidden, and local flags precede help/json', async () => {
  const completion = engine();
  assert.deepEqual(names(await completion.suggest('')), []);
  assert.deepEqual(names(await completion.suggest('plans ')), []);
  assert.ok(names(await completion.suggest('', 0, true)).includes('game'));
  assert.deepEqual(names(await completion.suggest('plans -')), [
    '--category',
    '--sort',
    '--json',
    '--help',
  ]);
  assert.deepEqual(names(await completion.suggest('game spin --')), [
    '--count',
    '--delay',
    '--json',
    '--help',
  ]);
  assert.deepEqual(names(await completion.suggest('login --')), ['--help']);
  assert.deepEqual(names(await completion.suggest('ncell game sp')), ['spin']);
});

test('used flags, invalid command order and variadic all never produce invalid suggestions', async () => {
  const completion = engine();
  assert.ok(!names(await completion.suggest('login 9800000000 --verify --')).includes('--verify'));
  assert.ok(
    !names(await completion.suggest('plans --category 66 ', undefined, true)).includes('search'),
  );
  assert.deepEqual(names(await completion.suggest('account --json --help add ')), []);
  assert.deepEqual(names(await completion.suggest('game claim-task 1 a')), []);
  assert.deepEqual(names(await completion.suggest('game claim-task all a')), []);
  assert.deepEqual(names(await completion.suggest('game claim-task a')), ['all']);
});

test('required hints follow complete numbers and quoted text without losing open-quote whitespace', async () => {
  const completion = engine();
  assert.match((await completion.suggest('sms send-free ')).hint ?? '', /<number>/);
  assert.match((await completion.suggest('sms send-free 9800000000')).hint ?? '', /<text>/);
  assert.match((await completion.suggest('sms send-free +9779800000000')).hint ?? '', /<text>/);
  assert.match((await completion.suggest('sms send-free 9800000000 "hello ')).hint ?? '', /<text>/);
  assert.equal(
    (await completion.suggest('sms send-free 9800000000 "hello world"')).hint,
    undefined,
  );
  assert.equal((await completion.suggest('login 9800000000')).hint, undefined);
});

test('categories load lazily without blocking editing, cache and invalidate after an account change', async () => {
  let calls = 0;
  let resolve: (value: unknown) => void = () => {};
  const completion = new CompletionEngine({
    categories: () => {
      calls++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    scripts: { directory: '', list: async () => [] },
  });
  await completion.suggest('plans --');
  assert.equal(calls, 0);
  assert.equal(
    (await completion.suggest('plans --category ', undefined, true)).notice,
    'Loading categories…',
  );
  assert.equal(calls, 1);
  resolve({
    tags: [{ id: 50, name: '\x1b[31mSMS\x1b[0m', categories: [{ displayName: 'Messages' }] }],
  });
  await completion.categorySuggestions();
  const loaded = await completion.suggest('plans --category 5');
  assert.deepEqual(names(loaded), ['50']);
  assert.equal(loaded.items[0]?.description, 'SMS · Messages');
  assert.deepEqual(names(await completion.suggest('plans --category=5')), ['--category=50']);
  assert.equal(calls, 1);
  completion.invalidate();
  assert.equal(
    (await completion.suggest('plans --category ', undefined, true)).notice,
    'Loading categories…',
  );
  assert.equal(calls, 2);
  resolve({ tags: [] });
  await completion.categorySuggestions();
});

test('category failures are concise and throttled without exposing raw API errors', async () => {
  let calls = 0;
  const completion = new CompletionEngine({
    categories: async () => {
      calls++;
      throw new Error('secret access token and response body');
    },
    scripts: { directory: '', list: async () => [] },
  });
  await completion.suggest('plans --category ', undefined, true);
  await assert.rejects(completion.categorySuggestions(), /Could not load categories/);
  const failed = await completion.suggest('plans --category 6');
  assert.equal(calls, 1);
  assert.doesNotMatch(failed.notice ?? '', /secret|token|body/);
});

test('sort completions include only directions, preserve commas and omit repeated fields', async () => {
  const completion = engine();
  assert.deepEqual(names(await completion.suggest('plans --sort ', undefined, true)), [
    'price:asc',
    'price:desc',
    'validity:asc',
    'validity:desc',
  ]);
  const options = await completion.suggest('plans --sort price:asc,');
  assert.deepEqual(names(options), ['price:asc,validity:asc', 'price:asc,validity:desc']);
  assert.equal(options.sortHint, 'add , for another field (price:asc,validity:asc)');
  for (const item of options.items)
    assert.doesNotThrow(() => parseCommand(['plans', '--sort', item.value], quiet));
  const editor = new InteractiveEditor();
  editor.input = 'plans --sort price:asc,';
  editor.cursor = editor.input.length;
  editor.key({ name: 'tab' }, options);
  assert.equal(editor.input, 'plans --sort price:asc,validity:asc');
  assert.equal(editor.key({ name: 'return' }, options).kind, 'submit');
});

test('clear empties the screen without executing, alongside exit', async () => {
  const completion = engine();
  const root = await completion.suggest('', undefined, true);
  assert.ok(names(root).includes('exit'));
  assert.ok(names(root).includes('clear'));
  const editor = new InteractiveEditor();
  editor.input = 'clear';
  editor.cursor = editor.input.length;
  assert.equal(editor.key({ name: 'return' }, await completion.suggest('clear')).kind, 'clear');
  const exiting = new InteractiveEditor();
  exiting.input = 'exit';
  exiting.cursor = exiting.input.length;
  assert.equal(exiting.key({ name: 'return' }, await completion.suggest('exit')).kind, 'exit');
});

test('file completions follow each command storage rules and quote paths', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell-completions-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'cwd'),
    library = join(root, 'library');
  await mkdir(cwd);
  await mkdir(library);
  await mkdir(join(cwd, 'nested'));
  await writeFile(join(library, 'saved.ncell'), 'status');
  await writeFile(join(cwd, 'local file.ncell'), 'status');
  await writeFile(join(cwd, 'ignore.txt'), 'status');
  await writeFile(join(cwd, 'nested', 'deep.ncell'), 'status');
  const completion = new CompletionEngine({
    categories: async () => ({}),
    scripts: new ScriptLibrary(library),
    cwd,
  });
  assert.deepEqual(names(await completion.suggest('script run ', undefined, true)), [
    '"local file.ncell"',
    'saved.ncell',
    '--help',
  ]);
  assert.deepEqual(names(await completion.suggest('script edit ', undefined, true)), [
    'saved.ncell',
    '--help',
  ]);
  assert.deepEqual(names(await completion.suggest('script delete ', undefined, true)), [
    'saved.ncell',
    '--help',
  ]);
  assert.deepEqual(names(await completion.suggest('script run ./n')), [
    `./nested${process.platform === 'win32' ? '\\' : '/'}`,
  ]);
  assert.deepEqual(names(await completion.suggest('script run "local ')), ['"local file.ncell"']);
  assert.deepEqual(names(await completion.suggest('script create ')), []);
  assert.deepEqual(names(await completion.suggest('script delete ./')), []);
});

test('keyboard navigation accepts prefixes and branches, while exact Enter submits', async () => {
  const completion = engine();
  const editor = new InteractiveEditor();
  editor.key({ name: 'g', text: 'g' }, await completion.suggest(''));
  let options = await completion.suggest(editor.input);
  editor.key({ name: 'return' }, options);
  assert.equal(editor.input, 'game ');
  editor.input = 'game';
  editor.cursor = 4;
  editor.dismissed = false;
  editor.key({ name: 'return' }, await completion.suggest(editor.input));
  assert.equal(editor.input, 'game ');
  editor.input = 'game ch';
  editor.cursor = editor.input.length;
  editor.dismissed = false;
  options = await completion.suggest(editor.input);
  editor.key({ name: 'return' }, options);
  assert.equal(editor.input, 'game check-in ');
  assert.equal(
    editor.key({ name: 'return' }, await completion.suggest(editor.input)).kind,
    'submit',
  );
  editor.reset();
  editor.key({ ctrl: true, name: 'space', text: '\0' }, await completion.suggest(''));
  options = await completion.suggest('', 0, editor.explicit);
  editor.key({ name: 'down', text: '\0' }, options);
  assert.equal(editor.selected, 1);
  editor.key({ name: 'up', text: '\0' }, options);
  assert.equal(editor.selected, 0);
});

test('Ctrl+Space variants work without treating arrow NULs as suggestions shortcuts', async () => {
  for (const name of ['space', 'spacebar', '@', 'd2']) {
    const editor = new InteractiveEditor();
    editor.key({ ctrl: true, name, text: '\0' }, await engine().suggest(''));
    assert.equal(editor.explicit, true, name);
  }
  const editor = new InteractiveEditor();
  editor.key({ name: 'down', text: '\0' }, await engine().suggest(''));
  assert.equal(editor.explicit, false);
});

test('Escape only dismisses suggestions; Ctrl+A, word deletion, Unicode and history keep editing predictable', async () => {
  const completion = engine();
  const editor = new InteractiveEditor();
  editor.input = 'sms send-free ';
  editor.cursor = editor.input.length;
  const options = await completion.suggest(editor.input, editor.cursor, true);
  editor.key({ name: 'escape' }, options);
  assert.equal(editor.input, 'sms send-free ');
  assert.match((await completion.suggest(editor.input)).hint ?? '', /number/);
  editor.key({ ctrl: true, name: 'a' }, options);
  editor.key({ text: 'game spin --count all' }, options);
  assert.equal(editor.input, 'game spin --count all');
  editor.key({ ctrl: true, name: 'backspace' }, options);
  assert.equal(editor.input, 'game spin --count ');
  editor.reset();
  editor.key({ name: 'up' }, await completion.suggest(''));
  assert.equal(editor.input, 'game spin --count ');
  editor.key({ name: 'down' }, await completion.suggest(editor.input));
  assert.equal(editor.input, '');
  editor.input = 'नमस्ते 👋';
  editor.cursor = editor.input.length;
  editor.key({ name: 'backspace' }, await completion.suggest(''));
  assert.equal(editor.input, 'नमस्ते ');
});

test('view anchors the dropdown at the current word, aligns labels and bounds large menus', async () => {
  const completion = await engine().suggest('game ', undefined, true);
  const theme = new InteractiveTheme(false);
  const rows = theme.dropdown(completion, 5, 9, 80, 6);
  assert.equal(rows.length, 6);
  assert.match(rows[0]!, /^ {9}┌/);
  assert.ok(rows.every((row) => cellWidth(row) <= 80));
  assert.deepEqual(theme.dropdown(completion, 0, 0, 2, 20), []);
  assert.equal(cellWidth('  A'), 3);
  assert.equal(cellWidth('界👋'), 4);
  assert.equal(cellWidth('e\u0301'), 1);
  const welcome = theme.welcome(80);
  assert.match(welcome, /interactive  ·  live commands/);
  assert.match(welcome, /Ctrl\+Space suggest   ·   Tab \/ Enter accept/);
  assert.doesNotMatch(welcome, /preview only|Ln \d/);
  assert.ok(
    theme
      .welcome(20)
      .split('\n')
      .every((row) => cellWidth(row) <= 24),
  );
  assert.equal(cleanLabel('\x1b]8;;https://bad.test\x07SMS\x1b]8;;\x07\n'), 'SMS');
  const view = viewport('plans --sort 界👋price', 20, 10);
  assert.ok(cellWidth(view.text) <= 10);
  assert.ok(view.column < 10);
});

test('interactive dispatch reuses the real app, validates before side effects and preserves normal help', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell-interactive-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0,
    prompts = 0,
    output = '';
  const app = new NcellApp({
    store: new MemorySessionStore({
      deviceId: 'test',
      pendingMsisdn: '9800000000',
      otherAccounts: [],
      account: {
        msisdn: '9800000000',
        accessToken: 'access',
        refreshToken: 'refresh',
        authenticatedAt: '2026-10-13T00:00:00Z',
      },
    }),
    fetch: async (url) => {
      requests++;
      if (String(url).includes('/otp/validate'))
        return Response.json({
          responseHeader: { responseCode: '200' },
          validateOTPResponse: { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 },
        });
      throw new Error('Unexpected network request');
    },
  });
  const scripts = new ScriptLibrary(root);
  await writeFile(join(root, 'bad.ncell'), 'logout\ninteractive');
  await runCli(['interactive'], {
    app,
    scripts,
    io: {
      out: (text) => {
        output += text;
      },
      err: () => {},
      color: false,
      prompt: async () => {
        prompts++;
        return '123456';
      },
    },
    interactive: async (session) => {
      assert.equal(requests, 0);
      await assert.rejects(session.execute('sms send-free 123 "hello"'), /10-digit/);
      await assert.rejects(session.execute('balance; logout'), /Shell operators/);
      await assert.rejects(session.execute('script run bad.ncell'), /Interactive mode cannot/);
      await session.execute('status --json');
      assert.match(output, /9800000000/);
      await session.execute('--help');
      assert.match(output, /Usage: ncell/);
      assert.equal(requests, 0);
      await session.execute('login 9800000000 --verify');
      assert.equal(prompts, 1);
      assert.equal(requests, 1);
      await assert.rejects(session.execute('interactive'), /Already in/);
    },
  });
  await assert.rejects(
    runCli(['interactive', '--json'], { app, scripts, io: quiet }),
    /does not support --json/,
  );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    await assert.rejects(
      runCli(['interactive'], { app, scripts, io: quiet }),
      /requires a terminal/,
    );
});

test('required values come before options until every argument is complete', async () => {
  const completion = engine();
  for (const input of [
    'sms send-free ',
    'sms send-free 9829493372',
    'sms send-free 9829493372 ',
    'sms send-free 9829493372 "hello',
    'login ',
  ]) {
    assert.ok(!names(await completion.suggest(input, undefined, true)).includes('--json'), input);
  }
  assert.deepEqual(names(await completion.suggest('sms send-free ', undefined, true)), ['--help']);
  assert.ok(
    names(await completion.suggest('sms send-free 9829493372 "hello" ', undefined, true)).includes(
      '--json',
    ),
  );
  assert.ok(
    names(await completion.suggest('login 9829493372 ', undefined, true)).includes('--verify'),
  );
});

test('argument and option slots stay quiet until typing or Ctrl+Space', async () => {
  const completion = engine();
  for (const input of [
    'sms send-free ',
    'login ',
    'script run ',
    'game spin --count ',
    'plans --sort ',
    'plans --category ',
    'balance ',
  ]) {
    const result = await completion.suggest(input);
    assert.deepEqual(names(result), [], input);
    assert.equal(result.notice, undefined, input);
  }
  assert.match((await completion.suggest('sms send-free ')).hint ?? '', /<number>/);
  assert.deepEqual(names(await completion.suggest('game spin --count a')), ['all']);
  for (const input of ['sms send-fr', 'game spin --co', 'log']) {
    const editor = new InteractiveEditor();
    editor.input = input;
    editor.cursor = input.length;
    editor.key({ name: 'tab' }, await completion.suggest(input));
    assert.equal(editor.explicit, false);
    assert.deepEqual(names(await completion.suggest(editor.input)), [], editor.input);
  }
  const editor = new InteractiveEditor();
  editor.input = 'gam';
  editor.cursor = 3;
  editor.key({ name: 'tab' }, await completion.suggest(editor.input));
  assert.equal(editor.explicit, true);
  assert.ok(
    (await completion.suggest(editor.input, editor.cursor, editor.explicit)).items.some(
      (item) => item.value === 'spin',
    ),
  );
});

test('category loading stays inside a fixed dropdown without shifting results or hints', () => {
  const theme = new InteractiveTheme(false);
  const loading: Completion = {
    items: [],
    start: 17,
    end: 17,
    prefix: '',
    categoryPanel: true,
    notice: 'Loading categories…',
  };
  const loaded: Completion = {
    ...loading,
    items: [
      { value: '50', description: 'SMS', kind: 'value' },
      { value: '66', description: 'Data and voice packs with a longer description', kind: 'value' },
    ],
  };
  for (const [columns, available] of [
    [80, 12],
    [40, 8],
    [24, 5],
  ]) {
    const before = theme.dropdown(loading, 0, 21, columns!, available!);
    const after = theme.dropdown(loaded, 1, 21, columns!, available!);
    assert.equal(before.length, after.length);
    assert.equal(before[0], after[0]);
    assert.equal(cellWidth(before.at(-1)!), cellWidth(after.at(-1)!));
    assert.deepEqual(before.map(cellWidth), after.map(cellWidth));
    assert.ok(before.every((row) => cellWidth(row) <= columns!));
  }
  assert.ok(
    theme.dropdown(loading, 0, 21, 80, 12).some((row) => row.includes('Loading categories…')),
  );
  assert.equal(loading.items.length, 0);
});

test('category footer shows total and range while arrows can reach every result', () => {
  const theme = new InteractiveTheme(false);
  const result: Completion = {
    start: 17,
    end: 17,
    prefix: '',
    categoryPanel: true,
    items: Array.from({ length: 20 }, (_, index) => ({
      value: String(index + 1),
      description: 'Category',
      kind: 'value',
    })),
  };
  assert.match(theme.dropdown(result, 0, 21, 80, 12).at(-1)!, /1–10 of 20/);
  const last = theme.dropdown(result, 19, 21, 80, 12);
  assert.match(last.at(-1)!, /11–20 of 20/);
  assert.ok(last.some((row) => row.includes('20')));
});
