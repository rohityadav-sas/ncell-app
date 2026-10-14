import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createInterface, cursorTo, clearScreenDown, emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import type { Completion, CompletionEngine } from './completion.js';
import { InteractiveEditor, trace } from './interactive-editor.js';
import type { EditorKey } from './interactive-editor.js';
import { InteractiveTheme, cellWidth, fit } from './interactive-view.js';

export interface InteractiveSession {
  completion: CompletionEngine;
  execute: (command: string) => Promise<void>;
  out: (text: string) => void;
  color: boolean;
}

// Console.ReadKey exposes Ctrl+Space and modifier keys reliably in Windows
// PowerShell. It owns the console only while editing, never during OTP prompts.
const windowsReader = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$previous = [Console]::TreatControlCAsInput
try {
  [Console]::TreatControlCAsInput = $true
  while ($true) {
    $pressed = [Console]::ReadKey($true)
    $event = @{
      name = $pressed.Key.ToString().ToLowerInvariant()
      text = $pressed.KeyChar.ToString()
      ctrl = [bool]($pressed.Modifiers -band [ConsoleModifiers]::Control)
      meta = [bool]($pressed.Modifiers -band [ConsoleModifiers]::Alt)
    }
    [Console]::Out.WriteLine(($event | ConvertTo-Json -Compress))
  }
} finally { [Console]::TreatControlCAsInput = $previous }
`;

const windowsNames: Record<string, string> = {
  spacebar: 'space',
  enter: 'return',
  uparrow: 'up',
  downarrow: 'down',
  leftarrow: 'left',
  rightarrow: 'right',
};

/** Start/stop are paired around every dispatch so the normal CLI owns input. */
class Keyboard {
  #child: ChildProcess | undefined;
  #lines: ReturnType<typeof createInterface> | undefined;
  #listener: ((text: string, key: Key) => void) | undefined;
  #stopping = false;

  start(onKey: (key: EditorKey) => void, fail: (error: Error) => void): void {
    this.#stopping = false;
    if (process.platform === 'win32') {
      const child = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          Buffer.from(windowsReader, 'utf16le').toString('base64'),
        ],
        { windowsHide: true, stdio: ['inherit', 'pipe', 'pipe'] },
      );
      this.#child = child;
      const lines = createInterface({ input: child.stdout! });
      this.#lines = lines;
      lines.on('line', (line) => {
        if (this.#stopping) return;
        try {
          const key = JSON.parse(line) as EditorKey;
          if (key.name) key.name = windowsNames[key.name] ?? key.name;
          onKey(key);
        } catch {
          fail(new Error('Could not read a keyboard event'));
        }
      });
      child.once('error', () => fail(new Error('Could not start the Windows keyboard reader')));
      child.once('exit', () => {
        if (!this.#stopping) fail(new Error('Windows keyboard reader stopped unexpectedly'));
      });
    } else {
      emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      this.#listener = (text, key) => onKey({ ...key, text });
      process.stdin.on('keypress', this.#listener);
      process.stdin.resume();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#lines?.close();
    this.#lines = undefined;
    const child = this.#child;
    this.#child = undefined;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.once('error', () => resolve());
        if (!child.kill()) resolve();
      });
    }
    if (this.#listener) process.stdin.removeListener('keypress', this.#listener);
    this.#listener = undefined;
    // Also restore ENABLE_PROCESSED_INPUT after a terminated Console.ReadKey
    // helper, whose finally block cannot run when Windows terminates it.
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
}

export function viewport(
  input: string,
  cursor: number,
  available: number,
): { text: string; offset: number; column: number } {
  let offset = 0;
  while (cellWidth(input.slice(offset, cursor)) >= available && offset < cursor)
    offset += input.codePointAt(offset)! > 0xffff ? 2 : 1;
  return {
    text: fit(input.slice(offset), available),
    offset: cellWidth(input.slice(0, offset)),
    column: cellWidth(input.slice(offset, cursor)),
  };
}

export async function runInteractive(session: InteractiveSession): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Interactive mode requires a terminal. Use ncell --help for one-shot commands.',
    );
  const editor = new InteractiveEditor();
  const theme = new InteractiveTheme(session.color);
  const keyboard = new Keyboard();
  const prompt = '  ❯ ';
  let closed = false,
    busy = false,
    message = '',
    renderId = 0,
    keyboardGeneration = 0;
  let queue = Promise.resolve();
  let last: Completion = { items: [], start: 0, end: 0, prefix: '' };
  let finish: () => void = () => {};
  let failure: Error | undefined;

  const erase = (): void => {
    cursorTo(process.stdout, 0);
    clearScreenDown(process.stdout);
  };
  // Blank every visible row with spaces, then park at the top-left. Uses only
  // cursor moves and spaces so it works even where erase sequences are ignored.
  // Scrollback above the viewport is preserved.
  const clearViewport = (): void => {
    const columns = Math.max(9, process.stdout.columns || 80);
    const height = Math.max(1, process.stdout.rows || 24);
    let frame = '';
    for (let row = 1; row <= height; row++) frame += '\x1b' + `[${row};1H` + ' '.repeat(columns);
    frame += '\x1b' + '[1;1H';
    session.out(frame);
  };
  const render = async (): Promise<void> => {
    if (closed || busy) return;
    const revision = ++renderId;
    const completion = await session.completion.suggest(
      editor.input,
      editor.cursor,
      editor.explicit,
    );
    if (closed || busy || revision !== renderId) return;
    last = completion;
    editor.selected = Math.min(editor.selected, Math.max(0, completion.items.length - 1));
    const columns = Math.max(1, (process.stdout.columns || 80) - 1);
    const height = Math.max(1, process.stdout.rows || 24);
    const visiblePrompt = fit(prompt, columns);
    const promptWidth = cellWidth(visiblePrompt);
    const view = viewport(editor.input, editor.cursor, Math.max(1, columns - promptWidth));
    const hints = [
      completion.hint,
      completion.sortHint,
      completion.categoryPanel || completion.packPanel ? undefined : completion.notice,
      message,
    ].filter((value): value is string => !!value);
    const shown = editor.dismissed
      ? { ...completion, items: [], categoryPanel: false, packPanel: false }
      : completion;
    const anchor = promptWidth + cellWidth(editor.input.slice(0, completion.start)) - view.offset;
    const rows = theme.dropdown(
      shown,
      editor.selected,
      anchor,
      columns,
      Math.max(0, height - hints.length - 3),
    );
    for (const hint of hints)
      rows.push(
        ' '.repeat(Math.min(promptWidth, columns)) +
          (hint === message
            ? theme.warning(fit(hint, columns - promptWidth))
            : theme.muted(fit(hint, columns - promptWidth))),
      );
    erase();
    const input =
      editor.allSelected && session.color
        ? `\x1b[48;2;51;45;73m${view.text}\x1b[0m`
        : theme.command(view.text);
    // Paint the whole frame in one write inside a synchronized update, so the
    // terminal never shows a half-painted frame. Sequences used: CSI 1 G (column 0),
    // CSI 0 J (clear below), CSI n A (move up n rows). Unsupported terminals ignore
    // the synchronized-update wrapper and still benefit from the single write.
    // erase() above already moved to column 0 and cleared below; the reserve block
    // below only scrolls room into view near the terminal bottom.
    const finalColumn = Math.min(columns - 1, promptWidth + view.column);
    let frame = '\x1b[?2026h';
    // Reserve physical rows before drawing. This scrolls the prompt into view
    // near the terminal bottom rather than leaving stale menu fragments.
    if (rows.length) frame += '\n'.repeat(rows.length) + `\x1b[${rows.length}A\x1b[1G`;
    frame += theme.accent(visiblePrompt) + input;
    for (const row of rows) frame += '\n' + row;
    if (rows.length) frame += `\x1b[${rows.length}A`;
    frame += `\x1b[${finalColumn + 1}G\x1b[?2026l`;
    session.out(frame);
  };
  const close = (error?: Error): void => {
    if (closed) return;
    closed = true;
    failure = error;
    finish();
  };
  const sigint = (): void => close();
  const onKey = (key: EditorKey): void => {
    if (closed || busy) return;
    const generation = keyboardGeneration;
    queue = queue
      .then(async () => {
        if (closed || busy || generation !== keyboardGeneration) return;
        last = await session.completion.suggest(editor.input, editor.cursor, editor.explicit);
        const effect = editor.key(key, last);
        message = '';
        if (effect.kind === 'exit') {
          close();
          return;
        }
        if (effect.kind === 'clear') {
          trace('branch-clear', '');
          clearViewport();
          session.out(theme.welcome(Math.max(9, process.stdout.columns || 80)));
          editor.reset();
        }
        if (effect.kind === 'submit') {
          busy = true;
          keyboardGeneration++;
          renderId++;
          await keyboard.stop();
          process.removeListener('SIGINT', sigint);
          erase();
          session.out(theme.accent(prompt) + theme.command(effect.command) + '\n');
          try {
            await session.execute(effect.command);
            editor.reset();
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          } finally {
            busy = false;
            if (!closed) {
              process.on('SIGINT', sigint);
              keyboard.start(onKey, close);
            }
          }
          session.out('\n');
        }
        await render();
      })
      .catch((error: unknown) => close(error instanceof Error ? error : new Error(String(error))));
  };
  const resize = (): void => {
    void render().catch(close);
  };
  session.completion.onChange = resize;
  try {
    // Remember where the session started so exit can erase exactly the
    // session region without touching the outer shell above it.
    session.out('\x1b' + '[s');
    // Fresh viewport on entry so the first frame matches a cleared screen.
    clearViewport();
    session.out(theme.welcome(Math.max(9, process.stdout.columns || 80)));
    await new Promise<void>((resolve) => {
      finish = resolve;
      process.on('SIGINT', sigint);
      process.stdout.on('resize', resize);
      keyboard.start(onKey, close);
      void render().catch(close);
    });
    await queue;
    if (failure) throw failure;
  } finally {
    closed = true;
    session.completion.onChange = undefined;
    process.stdout.removeListener('resize', resize);
    process.removeListener('SIGINT', sigint);
    await keyboard.stop();
    session.out('\x1b' + '[u');
    erase();
    session.out('\x1b[0m\n');
  }
}
