import { useState } from 'react';
import { compile, validateScript } from '../script/compiler';
import { useController, useEditorState } from './hooks';

/** DrawScript editor: Validate plans against the captured revision without committing; Run is one atomic transaction. */
export function ScriptDrawer() {
  const c = useController();
  const pageId = useEditorState((s) => s.pageId);
  const [source, setSource] = useState('');
  const [report, setReport] = useState<{ ok: boolean; text: string } | null>(null);
  const validate = () => {
    const snapshot = { ...c.engine.current(), pageId };
    const r = validateScript(source, { snapshot, newUuid: () => crypto.randomUUID() });
    setReport(r.ok
      ? { ok: true, text: `Valid at revision ${snapshot.revision}: ${r.value.operations.length} operation(s); would create ${r.value.created.length}, change ${r.value.changed.length}, delete ${r.value.deleted.length}.` }
      : { ok: false, text: r.error.message });
  };
  const run = async () => {
    const s = c.engine.scope();
    const r = await c.engine.executeScript({ ...s, pageId, transactionId: crypto.randomUUID(), baseRevision: s.revision, script: source }, compile);
    if (r.ok) c.recordResult(r.value);
    setReport(r.ok
      ? { ok: true, text: `Revision ${r.value.previousRevision} → ${r.value.revision}. Created ${r.value.created.length}, changed ${r.value.changed.length}, deleted ${r.value.deleted.length}.\n${JSON.stringify(r.value.operations, null, 1)}` }
      : { ok: false, text: `${r.error.code}: ${r.error.message}` });
  };
  return (
    <div className="script" data-testid="script-drawer">
      <h4>DrawScript</h4>
      <textarea data-testid="script-source" spellCheck={false} value={source} onChange={(e) => setSource(e.target.value)} placeholder={'add shape id=a type=roundedRect x=20mm y=20mm w=40mm h=15mm text="A"'} />
      <div className="row">
        <button data-testid="script-validate" onClick={validate}>Validate</button>
        <button data-testid="script-run" onClick={() => void run()}>Run</button>
      </div>
      {report && <pre data-testid="script-report" className={report.ok ? '' : 'diagnostics'}>{report.text}</pre>}
    </div>
  );
}
