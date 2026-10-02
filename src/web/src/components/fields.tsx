import { useEffect, useState } from 'react';

/** Text/number input that commits on Enter or blur (one transaction per edit, not per keystroke). */
export function Field(props: { label: string; value: string | number; onCommit: (v: string) => void; testid?: string; type?: string; disabled?: boolean }) {
  const [v, setV] = useState(String(props.value));
  useEffect(() => setV(String(props.value)), [props.value]);
  const commit = () => { if (v !== String(props.value)) props.onCommit(v); };
  return (
    <label className="field">
      <span>{props.label}</span>
      <input data-testid={props.testid} type={props.type ?? 'text'} value={v} disabled={props.disabled}
        onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }} />
    </label>
  );
}

export function Check(props: { label: string; checked: boolean; onChange: (v: boolean) => void; testid?: string; disabled?: boolean }) {
  return (
    <label className="check">
      <input data-testid={props.testid} type="checkbox" checked={props.checked} disabled={props.disabled} onChange={(e) => props.onChange(e.target.checked)} />
      {props.label}
    </label>
  );
}

export function Select<T extends string>(props: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void; testid?: string; disabled?: boolean }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select data-testid={props.testid} value={props.value} disabled={props.disabled} onChange={(e) => props.onChange(e.target.value as T)}>
        {props.options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
}

const round = (n: number) => +n.toFixed(3);
export { round };
