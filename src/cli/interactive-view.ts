import { cleanLabel } from './completion.js';
import type { Completion } from './completion.js';

/** Display cells, rather than UTF-16 units (emoji and full-width scripts use two). */
export function cellWidth(value: string): number {
  let width = 0;
  for (const char of cleanLabel(value)) {
    const code = char.codePointAt(0)!;
    if (/\p{Mark}/u.test(char)) continue;
    width +=
      code >= 0x1100 &&
      (code <= 0x115f ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        code >= 0x1f300)
        ? 2
        : 1;
  }
  return width;
}

export function fit(value: string, cells: number): string {
  let result = '',
    width = 0;
  for (const char of cleanLabel(value)) {
    const next = cellWidth(char);
    if (width + next > cells) break;
    result += char;
    width += next;
  }
  return result;
}

/** Split a notice into display-cell-bounded lines without breaking words. */
function wrapNotice(value: string, cells: number): string[] {
  const lines: string[] = [];
  let line = '';
  const cut = (word: string): void => {
    let piece = '';
    for (const char of word) {
      if (piece && cellWidth(piece + char) > cells) {
        lines.push(piece);
        piece = '';
      }
      piece += char;
    }
    if (piece) lines.push(piece);
  };
  for (const word of value.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (cellWidth(candidate) <= cells) {
      line = candidate;
    } else {
      if (line) {
        lines.push(line);
        line = '';
      }
      if (cellWidth(word) <= cells) line = word;
      else cut(word);
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

export class InteractiveTheme {
  constructor(readonly color = true) {}
  paint(rgb: string, value: string): string {
    return this.color ? `\x1b[38;2;${rgb}m${value}\x1b[0m` : value;
  }
  accent = (value: string): string => this.paint('132;202;190', value);
  muted = (value: string): string => this.paint('137;145;161', value);
  lavender = (value: string): string => this.paint('190;174;242', value);
  border = (value: string): string => this.paint('86;77;109', value);
  blue = (value: string): string => this.paint('142;193;235', value);
  warning = (value: string): string => this.paint('232;179;115', value);

  command(value: string): string {
    let position = 0;
    return value.replace(/"[^"]*"|'[^']*'|\S+/g, (token) => {
      const index = position++;
      if (/^["']/.test(token)) return this.accent(token);
      if (token.startsWith('--')) return this.blue(token);
      if (/^\d|:asc|:desc|\.ncell$/.test(token)) return this.paint('224;192;137', token);
      return index < 2 ? this.lavender(token) : token;
    });
  }

  welcome(columns: number): string {
    const letters = [
      ['██    ██', '███   ██', '████  ██', '██ ██ ██', '██  ████', '██   ███', '██    ██'],
      [' ██████ ', '██      ', '██      ', '██      ', '██      ', '██      ', ' ██████ '],
      ['███████', '██     ', '██     ', '██████ ', '██     ', '██     ', '███████'],
      ['██     ', '██     ', '██     ', '██     ', '██     ', '██     ', '███████'],
      ['██     ', '██     ', '██     ', '██     ', '██     ', '██     ', '███████'],
    ];
    const palette = ['132;202;190', '146;198;207', '160;190;224', '175;182;235', '190;174;242'];
    const inner = Math.min(53, Math.max(5, columns - 4));
    const indent = ' '.repeat(Math.max(0, Math.floor((columns - inner - 2) / 2)));
    const frame = (value: string, length: number): string => {
      const left = Math.max(0, Math.floor((inner - length) / 2));
      return (
        indent +
        this.border('│') +
        ' '.repeat(left) +
        value +
        ' '.repeat(Math.max(0, inner - length - left)) +
        this.border('│')
      );
    };
    const rows = [indent + this.border('╭' + '─'.repeat(inner) + '╮'), frame('', 0)];
    if (inner >= 45) {
      for (let row = 0; row < 7; row++)
        rows.push(
          frame(
            letters.map((letter, index) => this.paint(palette[index]!, letter[row]!)).join('  '),
            45,
          ),
        );
    } else rows.push(frame(this.lavender('NCELL'), 5));
    rows.push(frame('', 0));
    const subtitle = fit('interactive  ·  live commands', inner);
    rows.push(
      frame(this.accent(subtitle), cellWidth(subtitle)),
      frame('', 0),
      indent + this.border('╰' + '─'.repeat(inner) + '╯'),
      '',
    );
    const help = fit(
      columns >= 43
        ? 'Ctrl+Space suggest   ·   Tab / Enter accept'
        : columns >= 26
          ? 'Ctrl+Space  ·  Tab / Enter'
          : 'Ctrl+Space · Tab/↵',
      columns,
    );
    rows.push(
      ' '.repeat(Math.max(0, Math.floor((columns - cellWidth(help)) / 2))) + this.blue(help),
    );
    return '\n' + rows.join('\n') + '\n\n';
  }

  dropdown(
    completion: Completion,
    selected: number,
    anchor: number,
    columns: number,
    maxRows: number,
  ): string[] {
    const { items } = completion;
    if (
      (!items.length && !(completion.categoryPanel || completion.packPanel)) ||
      maxRows < 3 ||
      columns < 8
    )
      return [];
    const slots =
      completion.categoryPanel || completion.packPanel
        ? Math.min(10, maxRows - 2)
        : Math.min(items.length, maxRows - 2);
    const count = Math.min(items.length, slots);
    const first = Math.max(0, Math.min(selected - count + 1, items.length - count));
    const visible = items.slice(first, first + count);
    const nameWidth = Math.max(0, ...items.map((item) => cellWidth(item.value)));
    // Pack rows carry the price inside the description ("Name · Rs. 22.00").
    // Split it into its own column so prices line up across rows.
    const parts = items.map((item) => {
      const marker = ' · Rs. ';
      const at = item.description.lastIndexOf(marker);
      return at < 0
        ? { head: item.description, price: '' }
        : { head: item.description.slice(0, at), price: item.description.slice(at + 3) };
    });
    const priceWidth = Math.max(0, ...parts.map((part) => cellWidth(part.price)));
    const headWidth = Math.max(0, ...parts.map((part) => cellWidth(part.head)));
    const inner = Math.min(
      64,
      columns - 2,
      completion.categoryPanel || completion.packPanel
        ? 64
        : Math.max(28, ...visible.map((item) => nameWidth + cellWidth(item.description) + 6)),
    );
    const noticeText =
      completion.notice ??
      (completion.packPanel ? 'No matching packs.' : 'No matching categories.');
    // Word-wrap long notices across the reserved empty rows instead of cutting
    // them off; the box keeps its fixed size so nothing shifts while typing.
    const noticeLines = !items.length ? wrapNotice(noticeText, Math.max(1, inner - 2)) : [];
    const left = Math.max(0, Math.min(anchor, columns - inner - 2));
    const indent = ' '.repeat(left);
    const rows = [indent + this.border('┌' + '─'.repeat(inner) + '┐')];
    for (const [index, item] of visible.entries()) {
      const active = first + index === selected;
      const part = parts[first + index] ?? { head: item.description, price: '' };
      const name = fit(item.value, inner - 4);
      const padding = ' '.repeat(Math.max(0, Math.min(nameWidth, inner - 4) - cellWidth(name) + 2));
      const rest = Math.max(0, inner - 4 - cellWidth(name + padding));
      let tail = '';
      let colored = '';
      if (priceWidth > 0 && rest >= priceWidth + 2) {
        const price = part.price ? fit(part.price, priceWidth) : '';
        const headCol = Math.min(headWidth, rest - priceWidth - (price ? 2 : 0));
        const head = fit(part.head, headCol);
        const gap = price ? ' '.repeat(Math.max(0, headCol - cellWidth(head) + 2)) : '';
        const pricePad = price ? ' '.repeat(Math.max(0, priceWidth - cellWidth(price))) : '';
        tail = head + gap + pricePad + price;
        if (tail)
          colored =
            (head ? this.muted(head) : '') + gap + pricePad + (price ? this.muted(price) : '');
      } else {
        tail = fit(item.description, rest);
        if (tail) colored = this.muted(tail);
      }
      const icon = item.kind === 'option' ? '◇' : item.kind === 'file' ? '▤' : '›';
      const plain = ' ' + icon + ' ' + name + (tail ? padding + tail : '');
      const background = this.color ? (active ? '\x1b[48;2;51;45;73m' : '\x1b[48;2;31;29;39m') : '';
      const foreground = this.color ? '\x1b[38;2;190;174;242m' : '';
      const content =
        background +
        foreground +
        ' ' +
        this.accent(icon) +
        background +
        foreground +
        ' ' +
        name +
        (tail ? padding + colored + background : '') +
        ' '.repeat(Math.max(0, inner - cellWidth(plain))) +
        (this.color ? '\x1b[0m' : '');
      rows.push(indent + this.border('│') + content + this.border('│'));
    }
    for (let index = count; index < slots; index++) {
      const notice =
        !items.length && index - count < noticeLines.length
          ? (noticeLines[index - count] ?? '')
          : '';
      const text = fit('  ' + notice, inner);
      rows.push(
        indent +
          this.border('│') +
          this.muted(text) +
          ' '.repeat(inner - cellWidth(text)) +
          this.border('│'),
      );
    }
    const footer =
      (completion.categoryPanel || completion.packPanel) && items.length
        ? fit(` ${first + 1}–${first + count} of ${items.length} · ↑↓ more `, inner)
        : '';
    rows.push(indent + this.border('└' + footer + '─'.repeat(inner - cellWidth(footer)) + '┘'));
    return rows;
  }
}
