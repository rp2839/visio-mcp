import { fail } from '../model/result';

export type Span = { line: number; column: number; length: number };
export type Token =
  | { kind: 'word'; text: string; span: Span }
  | { kind: 'string'; text: string; span: Span }
  | { kind: 'kv'; key: string; value: Token; span: Span };

export const MAX_SCRIPT_BYTES = 1024 * 1024;

const WORD = /[A-Za-z0-9_.\-+:~%]/;

/** Tokenises one physical line. `#` outside quotes starts a comment; strings use JSON escapes. */
export function lexLine(text: string, line: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  const err = (msg: string, col: number): never => fail('invalid_request', `line ${line}, column ${col}: ${msg}`, { line, column: col });
  const readString = (): Token => {
    const start = i;
    let j = i + 1;
    let escaped = false;
    while (j < text.length) {
      const ch = text[j];
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') break;
      j++;
    }
    if (j >= text.length) err('unterminated string', start + 1);
    const raw = text.slice(i, j + 1);
    let value: string;
    try {
      value = JSON.parse(raw);
    } catch {
      return err('invalid string escape', start + 1);
    }
    i = j + 1;
    return { kind: 'string', text: value, span: { line, column: start + 1, length: raw.length } };
  };
  const readWord = (): Token => {
    const start = i;
    while (i < text.length && WORD.test(text[i])) i++;
    if (i === start) err(`unexpected character "${text[i]}"`, start + 1);
    return { kind: 'word', text: text.slice(start, i), span: { line, column: start + 1, length: i - start } };
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '#') break; // comment to end of line
    const start = i;
    const head = ch === '"' ? readString() : readWord();
    if (text[i] === '=') {
      if (head.kind !== 'word') return err('a key must be a bare word', start + 1);
      const key = head.text;
      i++;
      if (i >= text.length || text[i] === ' ' || text[i] === '#') err(`missing value for ${key}=`, i + 1);
      const value = text[i] === '"' ? readString() : readWord();
      out.push({ kind: 'kv', key, value, span: { line, column: start + 1, length: i - start } });
    } else out.push(head);
  }
  return out;
}

export function splitLines(source: string): string[] {
  if (new TextEncoder().encode(source).length > MAX_SCRIPT_BYTES) fail('limit_exceeded', 'script exceeds 1 MiB');
  return source.split('\n');
}
