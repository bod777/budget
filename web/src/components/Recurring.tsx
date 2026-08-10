import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  type PendingEntry,
  type RecurringRule,
  type RecurringSuggestion,
  type Reference,
} from '../api.ts';

interface Props {
  reference: Reference;
  onChanged: () => void;
  toast: (message: string) => void;
}

const CADENCE_LABEL: Record<RecurringRule['cadence'], string> = {
  weekly: 'Weekly',
  fortnightly: 'Fortnightly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

export function Recurring({ reference, onChanged, toast }: Props) {
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

  const load = useCallback(async () => {
    const [p, r, s] = await Promise.all([
      api.pending(),
      api.recurring(),
      api.recurringSuggestions(),
    ]);
    setPending(p.pending);
    setRules(r.rules);
    setSuggestions(s.suggestions);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm(entry: PendingEntry) {
    const typed = amounts[entry.id];
    const amount = typed !== undefined && typed !== '' ? Number(typed) : entry.amount;
    if (amount === null || !Number.isFinite(amount)) {
      toast('Enter an amount first');
      return;
    }
    setBusy(true);
    try {
      await api.confirmPending(entry.id, { amount });
      await load();
      onChanged();
      toast(`Logged ${entry.description}`);
    } finally {
      setBusy(false);
    }
  }

  async function skip(entry: PendingEntry) {
    setBusy(true);
    try {
      await api.skipPending(entry.id);
      await load();
      toast(`Skipped ${entry.description}`);
    } finally {
      setBusy(false);
    }
  }

  async function accept(suggestion: RecurringSuggestion) {
    setBusy(true);
    try {
      await api.createRecurring({
        kind: suggestion.kind,
        description: suggestion.description,
        counterparty: suggestion.counterparty,
        amount: suggestion.amount,
        categoryId: suggestion.categoryId,
        channelId: suggestion.channelId,
        cadence: suggestion.cadence,
        anchorDate: suggestion.anchorDate,
      });
      await load();
      toast(`${suggestion.description} will now be logged automatically`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Waiting for you</h2>
      {pending.length === 0 ? (
        <div className="empty">Nothing due. Recurring items appear here on their date.</div>
      ) : (
        <div className="card stack">
          {pending.map((entry) => (
            <div key={entry.id} style={{ borderBottom: '1px solid var(--border)', paddingBottom: 10 }}>
              <div className="spread">
                <span className="desc">
                  <strong>{entry.description}</strong>
                  <div className="meta small muted">
                    {formatDayLabel(entry.dueOn)}
                    {entry.counterparty ? ` · ${entry.counterparty}` : ''} · {entry.category}
                  </div>
                </span>
                <span className="money">
                  {entry.amount !== null ? money(entry.amount) : '—'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                <input
                  type="text"
                  inputMode="decimal"
                  placeholder={entry.amount !== null ? String(entry.amount) : 'Amount'}
                  value={amounts[entry.id] ?? ''}
                  style={{ minHeight: 40, maxWidth: 120 }}
                  onChange={(event) =>
                    setAmounts((current) => ({
                      ...current,
                      [entry.id]: event.target.value.replace(/[^\d.]/g, ''),
                    }))
                  }
                />
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => void confirm(entry)}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy}
                  onClick={() => void skip(entry)}
                >
                  Skip
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {suggestions.length > 0 && (
        <>
          <h2>Spotted in your history</h2>
          <p className="small muted" style={{ marginTop: -4 }}>
            These already repeat on a regular schedule. Turn one on and it will appear above on
            its date instead of being typed out.
          </p>
          <div className="card stack">
            {suggestions.slice(0, 12).map((suggestion) => (
              <div className="spread" key={`${suggestion.description}-${suggestion.counterpartyId}`}>
                <span className="desc">
                  <strong>{suggestion.description}</strong>
                  <div className="meta small muted">
                    {CADENCE_LABEL[suggestion.cadence]}
                    {suggestion.counterparty ? ` · ${suggestion.counterparty}` : ''} ·{' '}
                    {suggestion.occurrences}× ·{' '}
                    {suggestion.amount !== null ? money(suggestion.amount) : 'amount varies'}
                  </div>
                </span>
                <button
                  type="button"
                  className="btn small"
                  disabled={busy}
                  onClick={() => void accept(suggestion)}
                >
                  Automate
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Automated</h2>
      {rules.length === 0 ? (
        <div className="empty">Nothing automated yet.</div>
      ) : (
        <div className="card stack">
          {rules.map((rule) => (
            <div className="spread" key={rule.id}>
              <span className="desc">
                <strong>{rule.description}</strong>
                <div className="meta small muted">
                  {CADENCE_LABEL[rule.cadence]}
                  {rule.counterparty ? ` · ${rule.counterparty}` : ''} · {rule.category} ·{' '}
                  {rule.amount !== null ? money(rule.amount) : 'asks each time'}
                  {!rule.active && ' · paused'}
                </div>
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy}
                  onClick={async () => {
                    await api.updateRecurring(rule.id, { active: !rule.active });
                    await load();
                  }}
                >
                  {rule.active ? 'Pause' : 'Resume'}
                </button>
                <button
                  type="button"
                  className="btn secondary small"
                  disabled={busy}
                  onClick={async () => {
                    await api.deleteRecurring(rule.id);
                    await load();
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
