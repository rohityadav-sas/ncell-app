import assert from 'node:assert/strict';
import test from 'node:test';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ScriptLibrary,
  SCRIPT_TEMPLATE,
  executeScript,
  parseScript,
  scriptDirectory,
  tokenize,
} from '../src/scripts.js';
import { parseCommand } from '../src/cli/parse.js';

const quiet = { out: () => {}, err: () => {} };
const parse = (source: string) => parseScript(source, (argv) => parseCommand(argv, quiet));

test('tokenizer supports quoted SMS, literal operators inside arguments and Windows paths', () => {
  assert.deepEqual(tokenize('ncell sms send-free 9800000001 "Hello from my script"'), [
    'ncell',
    'sms',
    'send-free',
    '9800000001',
    'Hello from my script',
  ]);
  assert.deepEqual(tokenize("sms send-free 9800000001 'Cost $5; a|b <c> & d'"), [
    'sms',
    'send-free',
    '9800000001',
    'Cost $5; a|b <c> & d',
  ]);
  assert.deepEqual(tokenize('script run "C:\\Users\\Rohit\\My scripts\\daily.ncell"'), [
    'script',
    'run',
    'C:\\Users\\Rohit\\My scripts\\daily.ncell',
  ]);
  assert.deepEqual(tokenize('sms send-free 9800000001 ""'), ['sms', 'send-free', '9800000001', '']);
});

test('tokenizer rejects shell interpretation and unclosed quotes', () => {
  for (const line of [
    'balance | status',
    'status && logout',
    'status;logout',
    'status > file',
    'status < file',
    'status `date`',
    'status $HOME',
    'status $(date)',
    'status "unclosed',
  ]) {
    assert.throws(() => tokenize(line), Error, line);
  }
});

test('parseScript preserves physical lines and commands, comments, prefixes, UTF-8 and BOM', () => {
  const steps = parse(
    '\uFEFF# नमस्ते\r\n\r\n ncell balance \r\n # Comment\r\nsms send-free 9800000001 "नमस्ते संसार"\r\n',
  );
  assert.equal(steps.length, 2);
  assert.equal(steps[0]?.line, 3);
  assert.equal(steps[0]?.command, 'ncell balance');
  assert.equal(steps[1]?.line, 5);
  assert.equal(steps[1]?.parsed.args[1], 'नमस्ते संसार');
  assert.deepEqual(parse('# Nothing\n \n'), []);
});

test('parseScript rejects nested script operations, unknown commands and invalid late commands', () => {
  for (const line of [
    'script run daily.ncell',
    'ncell script list',
    'echo hello',
    'game spin --count 0',
    'game claim-task all,1',
    'sms send-free 9800000001 ""',
  ]) {
    assert.throws(() => parse(`balance\n\n${line}\n`), /Line 3/);
  }
});

test('template retains the chosen daily reward grouping and every line validates', () => {
  const steps = parse(SCRIPT_TEMPLATE);
  assert.equal(steps.length, 14);
  assert.match(SCRIPT_TEMPLATE, /# Game Warrior reward\nncell game claim-task 18/);
  assert.match(
    SCRIPT_TEMPLATE,
    /# Math Genius reward\nncell game math --count 4\nncell game claim-task 24/,
  );
  assert.match(SCRIPT_TEMPLATE, /# Spend remaining tokens\nncell game spin --count all/);
  assert.equal(steps.at(-1)?.parsed.command, 'game ranks');
  assert.doesNotMatch(SCRIPT_TEMPLATE, /max-games/);
});

test('executeScript awaits each command and stops on the first failure', async () => {
  const steps = parse('status\n\nbalance\nprofile\n');
  const events: string[] = [];
  const failure = new Error('Mock request failed');
  await assert.rejects(
    executeScript(steps, async (step, index, total) => {
      events.push(`start:${index}:${total}:${step.line}`);
      await Promise.resolve();
      if (index === 2) throw failure;
      events.push(`end:${index}`);
    }),
    (error) =>
      error instanceof Error &&
      error.message === 'Step 2 of 3 (line 3): Mock request failed' &&
      error.cause === failure,
  );
  assert.deepEqual(events, ['start:1:3:1', 'end:1', 'start:2:3:3']);
});

test('executeScript accepts empty scripts without calling the executor', async () => {
  let calls = 0;
  await executeScript([], async () => {
    calls++;
  });
  assert.equal(calls, 0);
});

test('library creates in CLI-owned storage, opens immediately and refuses overwrites', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const directory = join(root, 'saved');
  const opened: string[] = [];
  const library = new ScriptLibrary(directory, async (file) => {
    assert.equal(await readFile(file, 'utf8'), SCRIPT_TEMPLATE);
    opened.push(file);
  });
  const file = await library.create('daily.ncell');
  assert.equal(file, join(directory, 'daily.ncell'));
  assert.deepEqual(opened, [file]);
  await assert.rejects(
    library.create('daily.ncell'),
    (error) => (error as NodeJS.ErrnoException).code === 'EEXIST',
  );
  assert.equal(opened.length, 1);
  assert.equal(await readFile(file, 'utf8'), SCRIPT_TEMPLATE);
  assert.deepEqual(await library.list(), ['daily.ncell']);
});

test('library preserves a newly created script if its editor fails', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const library = new ScriptLibrary(root, async () => {
    throw new Error('Editor unavailable');
  });
  await assert.rejects(library.create('daily.ncell'), /Editor unavailable/);
  assert.equal(await library.read('daily.ncell'), SCRIPT_TEMPLATE);
});

test('library list contains only saved regular script files in stable alphabetical order', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const library = new ScriptLibrary(join(root, 'saved'), async () => {});
  assert.deepEqual(await library.list(), []);
  await library.create('Zulu.ncell');
  await library.create('alpha.ncell');
  await library.create('Beta.NCELL');
  await writeFile(join(library.directory, 'notes.txt'), 'not a script', 'utf8');
  await mkdir(join(library.directory, 'folder.ncell'));
  assert.deepEqual(await library.list(), ['alpha.ncell', 'Beta.NCELL', 'Zulu.ncell']);
});

test('library edit and delete affect only saved scripts and keep unrelated files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const opened: string[] = [];
  const library = new ScriptLibrary(join(root, 'saved'), async (file) => {
    opened.push(file);
  });
  const file = await library.create('daily.ncell');
  await library.edit('daily.ncell');
  assert.deepEqual(opened, [file, file]);
  await writeFile(join(root, 'daily.ncell'), 'local copy', 'utf8');
  await library.delete('daily.ncell');
  assert.equal(await readFile(join(root, 'daily.ncell'), 'utf8'), 'local copy');
  await assert.rejects(access(file), (error) => (error as NodeJS.ErrnoException).code === 'ENOENT');
  await assert.rejects(library.edit('missing.ncell'));
  await assert.rejects(library.delete('missing.ncell'));
});

test('saved scripts take priority, with current-folder and explicit-path run support', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const current = join(root, 'current');
  await mkdir(current);
  const library = new ScriptLibrary(join(root, 'saved'), async () => {});
  await library.create('daily.ncell');
  await writeFile(join(current, 'daily.ncell'), 'balance\n', 'utf8');
  await writeFile(join(current, 'local only.ncell'), 'status\n', 'utf8');
  await writeFile(join(current, 'commands.txt'), 'profile\n', 'utf8');
  assert.equal(await library.read('daily.ncell', current), SCRIPT_TEMPLATE);
  assert.equal(await library.read('local only.ncell', current), 'status\n');
  assert.equal(await library.read('commands.txt', current), 'profile\n');
  assert.equal(await library.read('./daily.ncell', current), 'balance\n');
  assert.equal(await library.read(join(current, 'daily.ncell'), current), 'balance\n');
});

test('creation, editing and deletion reject path traversal and invalid extensions', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const library = new ScriptLibrary(root, async () => {});
  for (const name of [
    '../outside.ncell',
    '..\\outside.ncell',
    'folder/daily.ncell',
    'folder\\daily.ncell',
    'C:\\daily.ncell',
    'daily.txt',
    'daily',
    '',
    '.ncell',
    'nul\0.ncell',
  ]) {
    await assert.rejects(library.create(name), Error, name);
    await assert.rejects(library.edit(name), Error, name);
    await assert.rejects(library.delete(name), Error, name);
  }
});

test('script files require valid UTF-8, preserving BOM and non-ASCII argument contents', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ncell scripts test '));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const library = new ScriptLibrary(root, async () => {});
  await writeFile(join(root, 'utf8.ncell'), '\uFEFFsms send-free 9800000001 "नमस्ते"\n', 'utf8');
  assert.equal(parse(await library.read('utf8.ncell'))[0]?.parsed.args[1], 'नमस्ते');
  await writeFile(join(root, 'invalid.ncell'), new Uint8Array([0xff, 0xfe, 0x00]));
  await assert.rejects(library.read('invalid.ncell'), /encoded data|encoding/i);
});

test('default script directory is an absolute CLI data path', () => {
  assert.ok(isAbsolute(scriptDirectory()));
  assert.match(scriptDirectory(), /ncell-cli[/\\]scripts$/);
});
