import { useController, useEditorState } from './hooks';

export function TransactionDrawer() {
  const c = useController();
  const transactions = useEditorState((s) => s.transactions);
  const last = useEditorState((s) => s.lastResult);
  return (
    <div className="transactions" data-testid="transactions">
      <h4>Transactions</h4>
      {last && (
        <div className="last-result" data-testid="last-result">
          <div>revision {last.previousRevision} → {last.revision}{last.noChange ? ' (no change)' : ''}</div>
          <div>created: <code>{last.created.join(', ') || '—'}</code></div>
          <div>changed: <code>{last.changed.join(', ') || '—'}</code></div>
          <div>deleted: <code>{last.deleted.join(', ') || '—'}</code></div>
          {last.warnings.length > 0 && <div>warnings: {last.warnings.map((w) => w.detail).join('; ')}</div>}
        </div>
      )}
      <ol reversed>
        {[...transactions].reverse().map((t) => (
          <li key={`${t.revision}-${t.transactionId}`} data-testid={`tx-${t.revision}`}>
            <span className={`source ${t.source}`}>{t.source}</span> r{t.revision} {t.description}
            <small> +{t.created.length} ~{t.changed.length} −{t.deleted.length}</small>
            {/* Only the global stack head can be undone (no selective undo over later edits). */}
            <button data-testid={`tx-undo-${t.revision}`} disabled={!c.engine.canUndo(t.transactionId)} onClick={() => void c.undo()}>Undo</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
