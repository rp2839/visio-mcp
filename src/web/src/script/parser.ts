import { fail } from '../model/result';
import { lexLine, splitLines, type Span, type Token } from './lexer';

export type ScriptCommand = {
  /** Verb words, e.g. ["add","shape"], ["page","use"], ["set"]. */
  verb: string[];
  positional: Token[];
  named: Map<string, Token>;
  span: Span;
};

const TWO_WORD = new Set(['page', 'add', 'layer', 'asset']);
const VERBS = new Set(['page', 'add', 'connect', 'group', 'ungroup', 'set', 'move', 'resize', 'rotate', 'delete', 'duplicate', 'align', 'distribute', 'set-gap', 'z', 'layer', 'asset']);

/** Deterministic line parser: one command per physical line, no expressions or control flow. */
export function parse(source: string): ScriptCommand[] {
  const commands: ScriptCommand[] = [];
  splitLines(source).forEach((text, idx) => {
    const line = idx + 1;
    const tokens = lexLine(text, line);
    if (tokens.length === 0) return;
    const first = tokens[0];
    if (first.kind !== 'word' || !VERBS.has(first.text)) fail('invalid_request', `line ${line}, column ${first.span.column}: unknown command "${first.kind === 'kv' ? first.key : first.text}"`, { line, column: first.span.column });
    const verb = [first.text];
    let rest = tokens.slice(1);
    if (TWO_WORD.has(first.text)) {
      const sub = rest[0];
      if (!sub || sub.kind !== 'word') fail('invalid_request', `line ${line}: "${first.text}" needs a sub-command`, { line, column: first.span.column });
      verb.push(sub.text);
      rest = rest.slice(1);
    }
    const named = new Map<string, Token>();
    const positional: Token[] = [];
    for (const t of rest) {
      if (t.kind === 'kv') {
        if (named.has(t.key)) fail('invalid_request', `line ${line}, column ${t.span.column}: ${t.key}= given twice`, { line, column: t.span.column });
        named.set(t.key, t.value);
        (t.value as any).keySpan = t.span;
      } else positional.push(t);
    }
    const last = tokens[tokens.length - 1].span;
    commands.push({ verb, positional, named, span: { line, column: first.span.column, length: last.column + last.length - first.span.column } });
  });
  return commands;
}
