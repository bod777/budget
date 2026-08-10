import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  shiftIso,
  todayIso,
  type Entry,
  type Kind,
  type Reference,
  type Template,
} from '../api.ts';
import { Autocomplete } from './Autocomplete.tsx';

interface Props {
  reference: Reference;
  onSaved: () => void;
  toast: (message: string, undo?: () => void) => void;
}

interface Draft {
  kind: Kind;
  occurredOn: string;
  description: string;
  counterparty: string;
  amount: string;
  categoryId: number | null;
  channelId: number | null;
}

function emptyDraft(kind: Kind, occurredOn: string): Draft {
  return {
    kind,
    occurredOn,
    description: '',
    counterparty: '',
    amount: '',
    categoryId: null,
    channelId: null,
  };
}

export function EntryForm({ reference, onSaved, toast }: Props) {
  const [draft, setDraft] = useState<Draft>(() => emptyDraft('expense', todayIso()));
  const [quick, setQuick] = useState<Template[]>([]);
  const [duplicates, setDuplicates] = useState<Entry[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Entries added in this sitting. Batch entry is the normal case, so showing
  // the running list makes it obvious where you are in a bank statement.
  const [session, setSession] = useState<Entry[]>([]);

  const amountRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLInputElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);

  const categories = useMemo(
    () => reference.categories.filter((c) => c.kind === draft.kind),
    [reference.categories, draft.kind],
  );
  const channels = useMemo(
    () => reference.channels.filter((c) => c.kinds.includes(draft.kind)),
    [reference.channels, draft.kind],
  );

  useEffect(() => {
    api
      .quick(draft.kind, 8)
      .then((r) => setQuick(r.quick))
      .catch(() => setQuick([]));
  }, [draft.kind, session.length]);

  // Live duplicate check. Runs only once the entry is complete enough to be
  // comparable, so it never fires mid-typing.
  useEffect(() => {
    const amount = Number(draft.amount);
    if (!draft.description || !draft.amount || !Number.isFinite(amount) || amount <= 0) {
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
  ]);

  const applyTemplate = useCallback((template: Template) => {
    setDraft((current) => ({
      ...current,
      description: template.description,
      counterparty: template.counterparty ?? '',
      categoryId: template.category_id,
      channelId: template.channel_id,
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
    (query: string) => api.suggest(draft.kind, query, 8).then((r) => r.templates),
    [draft.kind],
  );

  const fetchCounterparties = useCallback(
    (query: string) =>
      api.counterparties(draft.kind, query, 8).then((r) => r.counterparties),
    [draft.kind],
  );

  const valid =
    draft.description.trim() !== '' &&
    draft.categoryId !== null &&
    Number.isFinite(Number(draft.amount)) &&
    Number(draft.amount) > 0;

  async function save(force = false) {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    try {
      const { entry } = await api.createEntry({
        kind: draft.kind,
        occurredOn: draft.occurredOn,
        description: draft.description.trim(),
        counterparty: draft.counterparty.trim() || null,
        amount: Number(draft.amount),
        categoryId: draft.categoryId,
        channelId: draft.channelId,
        force,
      });

      setSession((list) => [entry, ...list]);
      // The date is deliberately kept: a batch is nearly always several
      // entries from the same day or a short run of days.
      setDraft((current) => ({
        ...emptyDraft(current.kind, current.occurredOn),
        channelId: current.channelId,
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
        {(['expense', 'income'] as Kind[]).map((kind) => (
          <button
            key={kind}
            type="button"
            aria-pressed={draft.kind === kind}
            onClick={() =>
              setDraft((current) => ({ ...emptyDraft(kind, current.occurredOn) }))
            }
          >
            {kind === 'expense' ? 'Expense' : 'Income'}
          </button>
        ))}
      </div>

      {quick.length > 0 && draft.description === '' && (
        <>
          <h2>One tap</h2>
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
                  {[template.counterparty, template.category, template.channel]
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
          keyOf={(t) => `${t.description}|${t.counterparty_id}|${t.category_id}|${t.channel_id}`}
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

        <div className="field">
          <label>Channel</label>
          <div className="chips">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                className="chip selectable"
                aria-pressed={draft.channelId === channel.id}
                onClick={() =>
                  setDraft((c) => ({
                    ...c,
                    channelId: c.channelId === channel.id ? null : channel.id,
                  }))
                }
              >
                {channel.name}
              </button>
            ))}
          </div>
        </div>
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
                    {entry.counterparty ? ` · ${entry.counterparty}` : ''} · {entry.category}
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
