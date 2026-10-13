import { acceptSuggestion } from './completion.js';
import type { Completion } from './completion.js';

export interface EditorKey {
  name?: string | undefined;
  ctrl?: boolean | undefined;
  meta?: boolean | undefined;
  text?: string;
}
export type EditorEffect =
  { kind: 'render' } | { kind: 'exit' } | { kind: 'submit'; command: string };

export class InteractiveEditor {
  input = '';
  cursor = 0;
  selected = 0;
  explicit = false;
  dismissed = false;
  allSelected = false;
  history: string[] = [];
  #historyIndex = -1;
  #draft = '';

  reset(): void {
    if (this.input.trim() && this.history.at(-1) !== this.input) this.history.push(this.input);
    this.input = '';
    this.cursor = 0;
    this.selected = 0;
    this.explicit = false;
    this.dismissed = false;
    this.allSelected = false;
    this.#historyIndex = -1;
  }

  key(key: EditorKey, completion: Completion): EditorEffect {
    const text = key.text ?? '';
    if (key.ctrl && ['c', 'd'].includes(key.name ?? '')) return { kind: 'exit' };
    if (key.ctrl && key.name === 'a') {
      this.allSelected = this.input.length > 0;
      this.cursor = this.input.length;
      this.dismissed = true;
      return { kind: 'render' };
    }
    if (
      (key.ctrl && ['space', 'spacebar', '@', '`'].includes(key.name ?? '')) ||
      (text === '\0' &&
        (['', 'null', 'none', '0'].includes(key.name ?? '') || (key.ctrl && key.name === 'd2')))
    ) {
      this.explicit = true;
      this.dismissed = false;
      this.selected = 0;
      return { kind: 'render' };
    }
    if (key.name === 'escape') {
      this.dismissed = true;
      this.explicit = false;
      return { kind: 'render' };
    }
    const typing = !!text && !key.ctrl && !key.meta && !/[\p{Cc}\p{Cf}]/u.test(text);
    if (this.allSelected) {
      if (
        typing ||
        ['backspace', 'delete'].includes(key.name ?? '') ||
        (key.ctrl && key.name === 'w')
      ) {
        this.input = '';
        this.cursor = 0;
      }
      if (key.name === 'left' || key.name === 'home') this.cursor = 0;
      this.allSelected = false;
      if (['left', 'right', 'home', 'end'].includes(key.name ?? '')) return { kind: 'render' };
    }
    const matches = this.dismissed ? [] : completion.items;
    if (key.name === 'up' || key.name === 'down') {
      if (matches.length)
        this.selected =
          (this.selected + (key.name === 'up' ? -1 : 1) + matches.length) % matches.length;
      else if (this.history.length) {
        if (this.#historyIndex < 0) this.#draft = this.input;
        this.#historyIndex = Math.max(
          -1,
          Math.min(this.history.length - 1, this.#historyIndex + (key.name === 'up' ? 1 : -1)),
        );
        this.input =
          this.#historyIndex < 0
            ? this.#draft
            : this.history[this.history.length - 1 - this.#historyIndex]!;
        this.cursor = this.input.length;
        this.dismissed = true;
      }
      return { kind: 'render' };
    }
    const suggestion = matches[Math.min(this.selected, Math.max(0, matches.length - 1))];
    if ((key.name === 'tab' || key.name === 'return') && suggestion) {
      const exact = this.input.slice(completion.start, completion.end) === suggestion.value;
      if (
        key.name === 'tab' ||
        !exact ||
        suggestion.branch ||
        suggestion.subscriptionCategory !== undefined
      ) {
        Object.assign(this, acceptSuggestion(this.input, completion, suggestion));
        this.selected = 0;
        this.explicit = !!suggestion.branch;
        this.dismissed = !this.explicit;
        return { kind: 'render' };
      }
    }
    if (key.name === 'return') {
      if (this.input.trim() === 'exit') return { kind: 'exit' };
      return this.input.trim()
        ? { kind: 'submit', command: this.input.trim() }
        : { kind: 'render' };
    }
    if ((key.ctrl && ['backspace', 'w'].includes(key.name ?? '')) || text === '\x17') {
      const left = this.input.slice(0, this.cursor).replace(/\S*\s*$/, '');
      this.input = left + this.input.slice(this.cursor);
      this.cursor = left.length;
    } else if (key.name === 'backspace' && this.cursor > 0) {
      const char = [...this.input.slice(0, this.cursor)].at(-1)!;
      this.input = this.input.slice(0, this.cursor - char.length) + this.input.slice(this.cursor);
      this.cursor -= char.length;
    } else if (key.name === 'delete') {
      const char = [...this.input.slice(this.cursor)][0];
      this.input =
        this.input.slice(0, this.cursor) + this.input.slice(this.cursor + (char?.length ?? 0));
    } else if (key.name === 'left')
      this.cursor = Math.max(
        0,
        this.cursor - ([...this.input.slice(0, this.cursor)].at(-1)?.length ?? 1),
      );
    else if (key.name === 'right')
      this.cursor = Math.min(
        this.input.length,
        this.cursor + ([...this.input.slice(this.cursor)][0]?.length ?? 1),
      );
    else if (key.name === 'home') this.cursor = 0;
    else if (key.name === 'end' || (key.ctrl && key.name === 'e')) this.cursor = this.input.length;
    else if (typing) {
      this.input = this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
      this.cursor += text.length;
    }
    this.selected = 0;
    this.explicit = false;
    this.dismissed = false;
    return { kind: 'render' };
  }
}
