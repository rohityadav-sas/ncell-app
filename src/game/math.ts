import { NcellError } from '../core/index.js';

type Question = Record<string, unknown>;

/** Evaluate only numeric arithmetic and avg(); server text is never executable code. */
export function evaluateMath(source: string): number {
  const expression = source
    .replaceAll('×', '*')
    .replaceAll('÷', '/')
    .replaceAll('−', '-')
    .replace(/%\s*of\s*/gi, '/100 * ');
  if (expression.length > 2_000) throw unsupported();
  const tokens: string[] = [];
  const scanner =
    /\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z]+)|([+\-*/%^(),]))/gy;
  let offset = 0;
  while (offset < expression.trimEnd().length) {
    scanner.lastIndex = offset;
    const match = scanner.exec(expression);
    if (!match) throw unsupported();
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    if (tokens.length > 500) throw unsupported();
    offset = scanner.lastIndex;
  }
  let cursor = 0;
  let depth = 0;
  const peek = () => tokens[cursor];
  const take = (value: string) => {
    if (peek() !== value) return false;
    cursor++;
    return true;
  };
  const sum = (): number => {
    if (++depth > 64) throw unsupported();
    let value = product();
    while (peek() === '+' || peek() === '-') {
      const operator = tokens[cursor++];
      const next = product();
      value = operator === '+' ? value + next : value - next;
    }
    depth--;
    return value;
  };
  const product = (): number => {
    let value = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = tokens[cursor++];
      const next = unary();
      value = operator === '*' ? value * next : operator === '/' ? value / next : value % next;
    }
    return value;
  };
  const unary = (): number => {
    if (take('+')) return unary();
    if (take('-')) return -unary();
    const value = atom();
    return take('^') ? value ** unary() : value;
  };
  const atom = (): number => {
    if (take('(')) {
      const value = sum();
      if (!take(')')) throw unsupported();
      return value;
    }
    if (take('avg')) {
      if (!take('(')) throw unsupported();
      const values = [sum()];
      while (take(',')) values.push(sum());
      if (!take(')')) throw unsupported();
      return values.reduce((total, value) => total + value, 0) / values.length;
    }
    const token = tokens[cursor++];
    if (!token || !/^(?:\d|\.)/.test(token)) throw unsupported();
    return Number(token);
  };
  const result = sum();
  if (cursor !== tokens.length || !Number.isFinite(result)) throw unsupported();
  return result;
}

function unsupported(): NcellError {
  return new NcellError('Unsupported math question; no answer submitted', {
    code: 'UNSUPPORTED_MATH',
  });
}

export function mathOptions(question: Question): number[] {
  if (typeof question.question !== 'string' || !Array.isArray(question.options)) {
    throw new NcellError('Ncell returned an invalid math question', { code: 'INVALID_RESPONSE' });
  }
  const options = question.options;
  if (
    !options.every((value): value is number => typeof value === 'number' && Number.isFinite(value))
  ) {
    throw new NcellError('Ncell returned invalid math options', { code: 'INVALID_RESPONSE' });
  }
  return options;
}

export function matchMathAnswer(question: Question, value: number): string {
  const option = mathOptions(question).find((candidate) => Math.abs(candidate - value) < 1e-8);
  if (option === undefined) {
    throw new NcellError('Calculated answer is not among the options; no answer submitted', {
      code: 'UNSUPPORTED_MATH',
    });
  }
  return String(option);
}

export function solveMath(question: Question): string {
  mathOptions(question);
  return matchMathAnswer(question, evaluateMath(question.question as string));
}
