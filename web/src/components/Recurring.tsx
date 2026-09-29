import { useCallback, useEffect, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  todayIso,
  type Kind,
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

const CADENCES: RecurringRule['cadence'][] = ['weekly', 'fortnightly', 'monthly', 'yearly'];

const emptyDraft = () => ({
  kind: 'expense' as Kind,
  description: '',
  counterparty: '',
  amount: '',
  categoryId: '' as number | '',
  accountId: '' as number | '',
  toAccountId: '' as number | '',
  cadence: 'monthly' as RecurringRule['cadence'],
  firstDueOn: '',
});

export function Recurring({ reference, onChanged, toast }: Props) {
  const [pending, setPending] = useState<PendingEntry[]>([]);
  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [suggestions, setSuggestions] = useState<RecurringSuggestion[]>([]);
  const [amounts, setAmounts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(emptyDraft);
  const [preview, setPreview] = useState<{ dates: string[]; matchesRequest: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const isTransfer = draft.kind === 'transfer';
  const spendKind = draft.kind === 'income' ? 'income' : 'expense';

  const categories = reference.categories.filter((c) => c.kind === spendKind);
  const accounts = isTransfer
    ? reference.accounts
    : reference.accounts.filter((a) => a.usableFor.includes(spendKind));

  // Switching the kind can strand a category or account that is no longer on
  // offer, which would be submitted without ever having been visible.
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      categoryId: categories.some((c) => c.id === d.categoryId) ? d.categoryId : '',
      accountId: accounts.some((a) => a.id === d.accountId) ? d.accountId : '',
      toAccountId: isTransfer ? d.toAccountId : '',
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind]);

  // The anchor is exclusive and month lengths shift the day, so the dates come
  // from the server rather than being guessed at in the form.
  useEffect(() => {
    if (!draft.firstDueOn) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    api
      .recurringPreview(draft.cadence, draft.firstDueOn)
      .then((r) => {
        if (!cancelled) setPreview({ dates: r.dates, matchesRequest: r.matchesRequest });
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [draft.cadence, draft.firstDueOn]);

  async function createRule() {
    const description = draft.description.trim();
    if (description === '') return setError('Give it a description');
    if (!draft.firstDueOn) return setError('Say when it is next due');
    if (isTransfer) {
      if (draft.accountId === '' || draft.toAccountId === '') {
        return setError('A transfer needs both accounts');
      }
      if (draft.accountId === draft.toAccountId) {
        return setError('A transfer needs two different accounts');
      }
    } else if (draft.categoryId === '') {
      return setError('Pick a category');
    }
    const amount = draft.amount.trim() === '' ? null : Number(draft.amount);
    if (amount !== null && !Number.isFinite(amount)) return setError('Enter a number for the amount');

    setBusy(true);
    setError(null);
    try {
      await api.createRecurring({
        kind: draft.kind,
        description,
        counterparty: isTransfer || draft.counterparty.trim() === '' ? null : draft.counterparty.trim(),
        amount,
        categoryId: isTransfer ? null : draft.categoryId,
        accountId: draft.accountId === '' ? null : draft.accountId,
        toAccountId: isTransfer ? draft.toAccountId : null,
        cadence: draft.cadence,
        firstDueOn: draft.firstDueOn,
      });
      setDraft(emptyDraft());
      setAdding(false);
      setPreview(null);
      await load();
      onChanged();
      toast(`${description} will now be logged automatically`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save it');
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
        accountId: suggestion.accountId,
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

      <h2 className="spread">
        <span>Automated</span>
        {!adding && (
          <button
            type="button"
            className="btn secondary small"
            onClick={() => {
              setAdding(true);
              setError(null);
              setDraft((d) => ({ ...d, firstDueOn: d.firstDueOn || todayIso() }));
            }}
          >
            Set one up
          </button>
        )}
      </h2>

      {adding && (
        <div className="card stack" style={{ marginBottom: 12 }}>
          <div className="segmented" role="group" aria-label="What kind of item">
            {(['expense', 'income', 'transfer'] as Kind[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={draft.kind === option}
                onClick={() => setDraft((d) => ({ ...d, kind: option }))}
              >
                {option === 'expense' ? 'Expense' : option === 'income' ? 'Income' : 'Transfer'}
              </button>
            ))}
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="rule-desc">Description</label>
            <input
              id="rule-desc"
              type="text"
              autoFocus
              placeholder={isTransfer ? 'e.g. Monthly Savings' : 'e.g. Monthly Rent'}
              value={draft.description}
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </div>

          {!isTransfer && (
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rule-payee">Payee</label>
              <input
                id="rule-payee"
                type="text"
                placeholder="optional"
                value={draft.counterparty}
                onChange={(e) => setDraft((d) => ({ ...d, counterparty: e.target.value }))}
              />
            </div>
          )}

          <div className="row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rule-amount">Amount</label>
              <input
                id="rule-amount"
                type="text"
                inputMode="decimal"
                placeholder="varies"
                value={draft.amount}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, amount: e.target.value.replace(/[^\d.]/g, '') }))
                }
              />
            </div>
            {!isTransfer && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rule-category">Category</label>
                <select
                  id="rule-category"
                  value={String(draft.categoryId)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      categoryId: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">Pick one…</option>
                  {categories.map((c) => (
                    <option key={c.id} value={String(c.id)}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Leave the amount blank if it changes each time — it will ask instead of prefilling.
          </p>

          <div className="row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rule-account">{isTransfer ? 'From' : 'Account'}</label>
              <select
                id="rule-account"
                value={String(draft.accountId)}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    accountId: e.target.value === '' ? '' : Number(e.target.value),
                  }))
                }
              >
                <option value="">Pick one…</option>
                {accounts.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            {isTransfer && (
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="rule-to-account">To</label>
                <select
                  id="rule-to-account"
                  value={String(draft.toAccountId)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      toAccountId: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                >
                  <option value="">Pick one…</option>
                  {reference.accounts.map((a) => (
                    <option key={a.id} value={String(a.id)}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          <div className="row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rule-cadence">How often</label>
              <select
                id="rule-cadence"
                value={draft.cadence}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    cadence: e.target.value as RecurringRule['cadence'],
                  }))
                }
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABEL[c]}
                  </option>
                ))}
              </select>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="rule-first-due">Next due</label>
              <input
                id="rule-first-due"
                type="date"
                value={draft.firstDueOn}
                onChange={(e) => setDraft((d) => ({ ...d, firstDueOn: e.target.value }))}
              />
            </div>
          </div>

          {preview && preview.dates.length > 0 && (
            <div className={preview.matchesRequest ? 'banner info' : 'banner warn'}>
              {preview.matchesRequest ? (
                <>Will be logged on {preview.dates.map(formatDayLabel).join(', ')}, and on from there.</>
              ) : (
                <>
                  No month is long enough for that day every time, so this would fall on{' '}
                  {preview.dates.map(formatDayLabel).join(', ')} instead. Pick an earlier day in the
                  month to keep it exact.
                </>
              )}
            </div>
          )}

          {error && <div className="banner warn">{error}</div>}

          <div className="spread">
            <button
              type="button"
              className="btn secondary small"
              onClick={() => {
                setAdding(false);
                setDraft(emptyDraft());
                setPreview(null);
                setError(null);
              }}
            >
              Cancel
            </button>
            <button type="button" className="btn small" disabled={busy} onClick={() => void createRule()}>
              Automate it
            </button>
          </div>
        </div>
      )}

      {rules.length === 0 ? (
        <div className="empty">Nothing automated yet.</div>
      ) : (
        <div className="card stack">
          {rules.map((rule) => (
            <div className="spread" key={rule.id}>
              <span className="desc">
                <strong>{rule.description}</strong>
                <div className="meta small muted">
                  {[
                    CADENCE_LABEL[rule.cadence],
                    // A transfer has no category or payee; what it does is
                    // where the money goes.
                    rule.kind === 'transfer'
                      ? `${rule.account ?? '?'} → ${rule.toAccount ?? '?'}`
                      : rule.counterparty,
                    rule.kind === 'transfer' ? null : rule.category,
                    rule.amount !== null ? money(rule.amount) : 'asks each time',
                    rule.active ? null : 'paused',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
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
