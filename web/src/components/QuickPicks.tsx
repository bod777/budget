import { useCallback, useEffect, useState } from 'react';
import { api, formatMoney, type QuickPickOption, type Reference, type SpendKind } from '../api.ts';

interface Props {
  kind: SpendKind;
  reference: Reference;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Choosing which one-tap buttons appear.
 *
 * Everything is automatic by default, so this only records deviations: force
 * something on, or keep something off. Anything left alone keeps following
 * what you actually repeat.
 */
export function QuickPicks({ kind, reference, onClose, onChanged }: Props) {
  const [options, setOptions] = useState<QuickPickOption[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

  const load = useCallback(async () => {
    try {
      const result = await api.quickOptions(kind);
      setOptions(result.options);
    } finally {
      setLoading(false);
    }
  }, [kind]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  async function set(option: QuickPickOption, pinned: boolean, hidden: boolean) {
    setBusy(option.key);
    try {
      await api.setQuickPick({ key: option.key, kind, pinned, hidden });
      setOptions((list) =>
        list.map((o) => (o.key === option.key ? { ...o, pinned, hidden } : o)),
      );
      onChanged();
    } finally {
      setBusy(null);
    }
  }

  /** Shown means: pinned, or automatic and not hidden. */
  const isShown = (o: QuickPickOption) => o.pinned || (o.automatic && !o.hidden);

  return (
    <div className="sheet-backdrop" onPointerDown={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Choose one-tap buttons"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-head spread">
          <strong>One-tap buttons</strong>
          <button type="button" className="btn secondary small" onClick={onClose}>
            Done
          </button>
        </div>

        <div className="sheet-body">
          <p className="small muted" style={{ marginTop: 0 }}>
            Buttons are chosen automatically from what you log most, with a steady amount. Tap to
            force one on or off; anything you leave alone keeps deciding for itself.
          </p>

          {loading && <div className="empty">Loading…</div>}

          {options.map((option) => {
            const shown = isShown(option);
            return (
              <div key={option.key} className="spread quick-option">
                <span className="desc">
                  <strong>{option.description}</strong>
                  <div className="meta small muted">
                    {[option.counterparty, option.category].filter(Boolean).join(' · ')} ·{' '}
                    {option.uses}× ·{' '}
                    {option.amount_varies
                      ? 'amount varies'
                      : money(option.last_amount)}
                    {option.pinned && ' · always shown'}
                    {option.hidden && ' · hidden'}
                    {!option.pinned && !option.hidden && option.automatic && ' · shown automatically'}
                  </div>
                </span>
                <button
                  type="button"
                  className={`btn small ${shown ? '' : 'secondary'}`}
                  disabled={busy === option.key}
                  aria-pressed={shown}
                  onClick={() => {
                    // Toggling flips to the explicit opposite of where it is
                    // now, so one tap always does the obvious thing.
                    if (shown) void set(option, false, true);
                    else void set(option, true, false);
                  }}
                >
                  {shown ? 'On' : 'Off'}
                </button>
              </div>
            );
          })}

          {!loading && options.length === 0 && (
            <div className="empty">Nothing logged often enough yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}
