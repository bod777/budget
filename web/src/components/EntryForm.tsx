import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  shiftIso,
  todayIso,
  type Entry,
  type Kind,
  type PaydayPreview,
  type Reference,
  type SpendKind,
  type Template,
} from '../api.ts';
import { Autocomplete } from './Autocomplete.tsx';
import { QuickPicks } from './QuickPicks.tsx';

interface Props {
  reference: Reference;
  onSaved: () => void;
  toast: (message: string, undo?: () => void | Promise<void>) => void;
}

interface Draft {
  kind: Kind;
  occurredOn: string;
  description: string;
  counterparty: string;
  amount: string;
  categoryId: number | null;
  accountId: number | null;
  toAccountId: number | null;
}

function emptyDraft(kind: Kind, occurredOn: string): Draft {
  return {
    kind,
    occurredOn,
    description: '',
    counterparty: '',
    amount: '',
    categoryId: null,
    accountId: null,
    toAccountId: null,
  };
}

function monthName(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IE', {
    month: 'long',
    year: 'numeric',
  });
}

function dayText(iso: string, offsetDays = 0): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + offsetDays);
  return date.toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
}

/** The end is exclusive, so the range is shown up to the last day inside it. */
function rangeText(start: string, end: string): string {
  return `${dayText(start)} – ${dayText(end, -1)}`;
}

const KIND_LABEL: Record<Kind, string> = {
  expense: 'Expense',
  income: 'Income',
  transfer: 'Transfer',
};

export function EntryForm({ reference, onSaved, toast }: Props) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft('expense', todayIso()));
  const [quick, setQuick] = useState<Template[]>([]);
  const [duplicates, setDuplicates] = useState<Entry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Entries added in this sitting. Batch entry is the normal case, so showing
  // the running list makes it obvious where you are in a bank statement.
  const [session, setSession] = useState<Entry[]>([]);
  // Off by default: closing a budget period is not something to do by accident.
  const [marksPayday, setMarksPayday] = useState(false);
  const [paydayPreview, setPaydayPreview] = useState<PaydayPreview | null>(null);
  const [choosingQuick, setChoosingQuick] = useState(false);
  const [quickKey, setQuickKey] = useState(0);

  const amountRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const isTransfer = draft.kind === 'transfer';
  const spendKind: SpendKind = draft.kind === 'income' ? 'income' : 'expense';

  const categories = useMemo(
    () => reference.categories.filter((c) => c.kind === spendKind),
    [reference.categories, spendKind],
  );
  // A transfer can involve any account; spending and income are limited to the
  // accounts that make sense (no income onto a credit card, for instance).
  const accounts = useMemo(
    () =>
      isTransfer
        ? reference.accounts
        : reference.accounts.filter((a) => a.usableFor.includes(spendKind)),
    [reference.accounts, isTransfer, spendKind],
  );

  useEffect(() => {
    if (draft.kind !== 'income') {
      setMarksPayday(false);
      setPaydayPreview(null);
    }
  }, [draft.kind]);

  // What ticking the box would do, worked out by the server so the form can
  // say it before anything is saved.
  useEffect(() => {
    if (!marksPayday || draft.kind !== 'income') {
      setPaydayPreview(null);
      return;
    }
    let cancelled = false;
    api
      .paydayPreview(draft.occurredOn)
      .then((result) => {
        if (!cancelled) setPaydayPreview(result);
      })
      .catch(() => {
        if (!cancelled) setPaydayPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [marksPayday, draft.kind, draft.occurredOn]);

  useEffect(() => {
    if (isTransfer) {
      setQuick([]);
      return;
    }
    api
      .quick(spendKind, 8)
      .then((r) => setQuick(r.quick))
      .catch(() => setQuick([]));
  }, [spendKind, isTransfer, session.length, quickKey]);

  // Live duplicate check. Transfers between your own accounts are legitimately
  // repetitive, so they are left out of it.
  useEffect(() => {
    const amount = Number(draft.amount);
    if (isTransfer || !draft.description || !draft.amount || !Number.isFinite(amount) || amount <= 0) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .checkDuplicate({
          kind: draft.kind,
          occurredOn: draft.occurredOn,
          description: draft.description,
          counterparty: draft.counterparty || null,
          amount,
          categoryId: draft.categoryId ?? categories[0]?.id,
        })
        .then((r) => {
          if (!cancelled) setDuplicates(r.duplicates);
        })
        .catch(() => {
          if (!cancelled) setDuplicates([]);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    draft.kind,
    draft.occurredOn,
    draft.description,
    draft.counterparty,
    draft.amount,
    draft.categoryId,
    categories,
    isTransfer,
  ]);

  const applyTemplate = useCallback((template: Template) => {
    setDraft((current) => ({
      ...current,
      description: template.description,
      counterparty: template.counterparty ?? '',
      categoryId: template.category_id,
      accountId: template.account_id,
      amount: template.last_amount != null ? String(template.last_amount) : '',
    }));

    // If the amount reliably repeats, the entry is already complete -- go
    // straight to saving. If it moves around, the amount is the one thing
    // that still needs attention.
    requestAnimationFrame(() => {
      if (template.amount_varies) {
        amountRef.current?.focus();
        amountRef.current?.select();
      } else {
        saveRef.current?.focus();
      }
    });
  }, []);

  const fetchTemplates = useCallback(
    (query: string) => api.suggest(spendKind, query, 8).then((r) => r.templates),
    [spendKind],
  );

  const fetchCounterparties = useCallback(
    (query: string) => api.counterparties(spendKind, query, 8).then((r) => r.counterparties),
    [spendKind],
  );

  const amountValue = Number(draft.amount);
  const valid =
    draft.description.trim() !== '' &&
    Number.isFinite(amountValue) &&
    amountValue > 0 &&
    (isTransfer
      ? draft.accountId !== null && draft.toAccountId !== null && draft.accountId !== draft.toAccountId
      : draft.categoryId !== null);

  async function save(force = false) {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { entry } = await api.createEntry({
        kind: draft.kind,
        occurredOn: draft.occurredOn,
        description: draft.description.trim(),
        counterparty: isTransfer ? null : draft.counterparty.trim() || null,
        amount: amountValue,
        categoryId: isTransfer ? null : draft.categoryId,
        accountId: draft.accountId,
        toAccountId: isTransfer ? draft.toAccountId : null,
        marksPayday: draft.kind === 'income' ? marksPayday : false,
        force,
      });

      setSession((list) => [entry, ...list]);
      // The date and the accounts are deliberately kept: a batch is nearly
      // always several entries from the same day, and transfers repeat between
      // the same pair of accounts.
      setDraft((current) => ({
        ...emptyDraft(current.kind, current.occurredOn),
        accountId: current.accountId,
        toAccountId: current.kind === 'transfer' ? current.toAccountId : null,
      }));
      setDuplicates([]);
      onSaved();
      toast(`Added ${entry.description}`, async () => {
        await api.deleteEntry(entry.id);
        setSession((list) => list.filter((e) => e.id !== entry.id));
        onSaved();
      });
      requestAnimationFrame(() => descriptionRef.current?.focus());
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Could not save';
      if (message === 'possible duplicate') {
        setError('This looks like something already logged — check below, then save anyway.');
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  const sessionTotal = session.reduce((total, entry) => total + entry.amount, 0);

  return (
    <div>
      <div className="segmented" role="group" aria-label="Entry type">
        {(['expense', 'income', 'transfer'] as Kind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={draft.kind === kind}
            onClick={() => setDraft(() => emptyDraft(kind, draft.occurredOn))}
          >
            {KIND_LABEL[kind]}
          </button>
        ))}
      </div>

      {isTransfer && (
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Moving your own money between accounts. It counts as neither spending nor income —
          taking out cash, or paying into savings.
        </p>
      )}

      {!isTransfer && draft.description === '' && (
        <>
          <div className="spread">
            <h2 style={{ marginBottom: 8 }}>One tap</h2>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setChoosingQuick(true)}
            >
              Choose
            </button>
          </div>
          <div className="chips">
            {quick.map((template) => (
              <button
                key={`${template.description}-${template.counterparty_id}-${template.category_id}`}
                type="button"
                className="chip"
                onClick={() => applyTemplate(template)}
              >
                <span>{template.description}</span>
                <span className="amt">
                  {formatMoney(template.last_amount, reference.currency, reference.locale)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}

      {choosingQuick && (
        <QuickPicks
          kind={spendKind}
          reference={reference}
          onClose={() => setChoosingQuick(false)}
          onChanged={() => setQuickKey((k) => k + 1)}
        />
      )}

      <h2>Details</h2>
      <div className="card">
        <div className="field">
          <label htmlFor="date-input">Date</label>
          <div className="chips" style={{ marginBottom: 8 }}>
            {[0, -1, -2, -3].map((offset) => {
              const iso = shiftIso(todayIso(), offset);
              return (
                <button
                  key={offset}
                  type="button"
                  className="chip selectable"
                  aria-pressed={draft.occurredOn === iso}
                  onClick={() => setDraft((c) => ({ ...c, occurredOn: iso }))}
                >
                  {formatDayLabel(iso)}
                </button>
              );
            })}
          </div>
          <input
            id="date-input"
            type="date"
            value={draft.occurredOn}
            max={todayIso()}
            onChange={(event) =>
              setDraft((c) => ({ ...c, occurredOn: event.target.value || todayIso() }))
            }
          />
        </div>

        {isTransfer ? (
          <div className="field">
            <label htmlFor="transfer-desc">Description</label>
            <input
              id="transfer-desc"
              ref={descriptionRef}
              type="text"
              placeholder="e.g. Monthly saving, Cash out"
              value={draft.description}
              autoComplete="off"
              onChange={(event) => setDraft((c) => ({ ...c, description: event.target.value }))}
            />
          </div>
        ) : (
          <>
            <Autocomplete<Template>
              label="Description"
              value={draft.description}
              onChange={(value) => setDraft((c) => ({ ...c, description: value }))}
              onPick={applyTemplate}
              fetchItems={fetchTemplates}
              renderItem={(template) => (
                <>
                  <span className="suggestion-main">
                    <span className="suggestion-title">{template.description}</span>
                    <span className="suggestion-meta">
                      {[template.counterparty, template.category, template.account]
                        .filter(Boolean)
                        .join(' · ')}
                      {` · ${template.uses}×`}
                    </span>
                  </span>
                  <span className="suggestion-amount money">
                    {formatMoney(template.last_amount, reference.currency, reference.locale)}
                    {template.amount_varies && <span className="muted small">{' ~'}</span>}
                  </span>
                </>
              )}
              keyOf={(t) => `${t.description}|${t.counterparty_id}|${t.category_id}|${t.account_id}`}
              placeholder="What was it?"
              inputRef={descriptionRef}
              autoFocus
            />

            <Autocomplete<{ id: number; name: string; uses: number }>
              label={draft.kind === 'expense' ? 'Payee' : 'Payer'}
              value={draft.counterparty}
              onChange={(value) => setDraft((c) => ({ ...c, counterparty: value }))}
              onPick={(item) => setDraft((c) => ({ ...c, counterparty: item.name }))}
              fetchItems={fetchCounterparties}
              renderItem={(item) => (
                <>
                  <span className="suggestion-main">
                    <span className="suggestion-title">{item.name}</span>
                  </span>
                  <span className="suggestion-meta">{item.uses}×</span>
                </>
              )}
              keyOf={(item) => String(item.id)}
              placeholder={draft.kind === 'expense' ? 'Who was paid?' : 'Who paid?'}
            />
          </>
        )}

        <div className="field">
          <label htmlFor="amount-input">Amount</label>
          <input
            id="amount-input"
            ref={amountRef}
            className="amount-input money"
            type="text"
            inputMode="decimal"
            placeholder="0.00"
            value={draft.amount}
            onChange={(event) =>
              setDraft((c) => ({ ...c, amount: event.target.value.replace(/[^\d.]/g, '') }))
            }
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void save();
              }
            }}
          />
        </div>

        {!isTransfer && (
          <div className="field">
            <label>Category</label>
            <div className="chips">
              {categories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="chip selectable"
                  aria-pressed={draft.categoryId === category.id}
                  onClick={() => setDraft((c) => ({ ...c, categoryId: category.id }))}
                >
                  {category.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {draft.kind === 'income' && (
          <div className="field">
            <label className="checkline">
              <input
                type="checkbox"
                checked={marksPayday}
                onChange={(event) => setMarksPayday(event.target.checked)}
              />
              <span>
                This is my payday — close this budget and start the next
                <span className="small muted" style={{ display: 'block' }}>
                  Leave off for any other income. Only tick it for the pay that starts a period.
                </span>
              </span>
            </label>

            {marksPayday && paydayPreview && (
              <div className={`banner ${paydayPreview.alreadyScheduled ? 'info' : 'warn'}`}>
                {paydayPreview.alreadyScheduled ? (
                  <>
                    That is already the scheduled payday, so nothing moves.{' '}
                    {monthName(paydayPreview.nextMonth)} runs{' '}
                    {rangeText(paydayPreview.opens.start, paydayPreview.opens.end)}.
                  </>
                ) : (
                  <>
                    {monthName(paydayPreview.month)} will close on{' '}
                    {dayText(paydayPreview.closes.end, -1)} instead of{' '}
                    {dayText(paydayPreview.scheduled, -1)}, and{' '}
                    {monthName(paydayPreview.nextMonth)} will run{' '}
                    {rangeText(paydayPreview.opens.start, paydayPreview.opens.end)} — back to the
                    usual end date.
                  </>
                )}
              </div>
            )}
          </div>
        )}

        <div className="field">
          <label>{isTransfer ? 'From' : 'Account'}</label>
          <div className="chips">
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className="chip selectable"
                aria-pressed={draft.accountId === account.id}
                disabled={isTransfer && draft.toAccountId === account.id}
                onClick={() =>
                  setDraft((c) => ({
                    ...c,
                    accountId: c.accountId === account.id && !isTransfer ? null : account.id,
                  }))
                }
              >
                {account.name}
              </button>
            ))}
          </div>
        </div>

        {isTransfer && (
          <div className="field">
            <label>To</label>
            <div className="chips">
              {accounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  className="chip selectable"
                  aria-pressed={draft.toAccountId === account.id}
                  disabled={draft.accountId === account.id}
                  onClick={() => setDraft((c) => ({ ...c, toAccountId: account.id }))}
                >
                  {account.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {duplicates.length > 0 && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          <strong>Already logged?</strong>
          <div className="stack small" style={{ marginTop: 6 }}>
            {duplicates.map((entry) => (
              <div key={entry.id}>
                {formatDayLabel(entry.occurredOn)} · {entry.description}
                {entry.counterparty ? ` · ${entry.counterparty}` : ''} ·{' '}
                {formatMoney(entry.amount, reference.currency, reference.locale)}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      <div style={{ marginTop: 14 }} className="stack">
        <button
          ref={saveRef}
          type="button"
          className="btn"
          disabled={!valid || saving}
          onClick={() => void save(false)}
        >
          {saving ? 'Saving…' : `Save ${draft.kind}`}
        </button>
        {(duplicates.length > 0 || error) && valid && (
          <button
            type="button"
            className="btn secondary"
            disabled={saving}
            onClick={() => void save(true)}
          >
            Save anyway
          </button>
        )}
      </div>

      {session.length > 0 && (
        <>
          <h2>
            Added just now · {session.length} ·{' '}
            <span className="money">
              {formatMoney(sessionTotal, reference.currency, reference.locale)}
            </span>
          </h2>
          <div className="card">
            {session.map((entry) => (
              <div className="session-item" key={entry.id}>
                <span className="desc">
                  {entry.description}
                  <div className="meta">
                    {formatDayLabel(entry.occurredOn)}
                    {entry.kind === 'transfer'
                      ? ` · ${entry.account} → ${entry.toAccount}`
                      : `${entry.counterparty ? ` · ${entry.counterparty}` : ''} · ${entry.category}`}
                  </div>
                </span>
                <span className="money">
                  {formatMoney(entry.amount, reference.currency, reference.locale)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
