import { useEffect, useMemo, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  type Entry,
  type Kind,
  type Reference,
} from '../api.ts';
import { EntryEditor } from './EntryEditor.tsx';

interface Props {
  reference: Reference;
  refreshKey: number;
  onChanged: () => void;
}

/**
 * Enough to cover any realistic filtered view, but the list is still capped,
 * so the cap is said out loud rather than quietly cutting history off.
 */
const LIMIT = 200;

export function History({ reference, refreshKey, onChanged }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [accountId, setAccountId] = useState<number | 'all'>('all');
  const [categoryId, setCategoryId] = useState<number | 'all'>('all');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .entries({
          search: search || undefined,
          kind: kind === 'all' ? undefined : kind,
          accountId: accountId === 'all' ? undefined : accountId,
          categoryId: categoryId === 'all' ? undefined : categoryId,
          limit: LIMIT,
        })
        .then((r) => setEntries(r.entries))
        .catch(() => setEntries([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, kind, accountId, categoryId, refreshKey, reloadKey]);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

  // Transfers carry no category, and an expense category cannot match an
  // income entry, so the options follow whatever kind is selected.
  const categories = useMemo(
    () =>
      kind === 'transfer'
        ? []
        : reference.categories.filter((c) => kind === 'all' || c.kind === kind),
    [reference.categories, kind],
  );

  // Narrowing the kind can strand a category that is no longer on offer, which
  // would silently filter everything out.
  useEffect(() => {
    if (categoryId !== 'all' && !categories.some((c) => c.id === categoryId)) {
      setCategoryId('all');
    }
  }, [categories, categoryId]);

  const filtered = kind !== 'all' || accountId !== 'all' || categoryId !== 'all' || search !== '';

  function clearFilters() {
    setSearch('');
    setKind('all');
    setAccountId('all');
    setCategoryId('all');
  }

  /**
   * What the filtered entries come to, said the way the filter asks it. The
   * day headings net income off against spending, which is right for a mixed
   * list but reads backwards once you have narrowed to one kind -- income
   * alone would show as a large negative.
   */
  const summary = useMemo(() => {
    let spent = 0;
    let received = 0;
    let moved = 0;
    for (const entry of entries) {
      if (entry.kind === 'expense') spent += entry.amount;
      else if (entry.kind === 'income') received += entry.amount;
      else moved += entry.amount;
    }
    if (kind === 'expense') return spent === 0 ? null : `${money(spent)} spent`;
    if (kind === 'income') return received === 0 ? null : `${money(received)} in`;
    if (kind === 'transfer') return moved === 0 ? null : `${money(moved)} moved`;
    const net = spent - received;
    return net === 0 ? null : `net ${money(net)}`;
  }, [entries, kind, reference.currency, reference.locale]);

  // Grouped by day, which is how spending is actually recalled.
  const days = useMemo(() => {
    const map = new Map<string, Entry[]>();
    for (const entry of entries) {
      const list = map.get(entry.occurredOn);
      if (list) list.push(entry);
      else map.set(entry.occurredOn, [entry]);
    }
    return [...map.entries()];
  }, [entries]);

  return (
    <div>
      <div className="field">
        <input
          type="text"
          placeholder="Search description or payee"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          autoComplete="off"
        />
      </div>

      <div className="segmented" role="group" aria-label="Filter by type">
        {(['all', 'expense', 'income', 'transfer'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => setKind(option)}
          >
            {option === 'all'
              ? 'All'
              : option === 'expense'
                ? 'Expenses'
                : option === 'income'
                  ? 'Income'
                  : 'Transfers'}
          </button>
        ))}
      </div>

      <div className="row" style={{ marginTop: 10 }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="filter-account">Account</label>
          <select
            id="filter-account"
            value={String(accountId)}
            onChange={(event) =>
              setAccountId(event.target.value === 'all' ? 'all' : Number(event.target.value))
            }
          >
            <option value="all">All accounts</option>
            {reference.accounts.map((account) => (
              <option key={account.id} value={String(account.id)}>
                {account.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="filter-category">Category</label>
          <select
            id="filter-category"
            value={String(categoryId)}
            disabled={kind === 'transfer'}
            title={kind === 'transfer' ? 'Transfers have no category' : undefined}
            onChange={(event) =>
              setCategoryId(event.target.value === 'all' ? 'all' : Number(event.target.value))
            }
          >
            <option value="all">
              {kind === 'transfer' ? 'Not applicable' : 'All categories'}
            </option>
            {categories.map((category) => (
              <option key={category.id} value={String(category.id)}>
                {category.name}
                {kind === 'all' ? (category.kind === 'income' ? ' (income)' : '') : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {filtered && !loading && entries.length > 0 && (
        <div className="spread small muted" style={{ marginTop: 10 }}>
          <span>
            {entries.length}
            {entries.length === LIMIT ? '+' : ''} {entries.length === 1 ? 'entry' : 'entries'}
            {summary && <> · {summary}</>}
          </span>
          <button type="button" className="btn secondary small" onClick={clearFilters}>
            Clear filters
          </button>
        </div>
      )}

      {entries.length === LIMIT && (
        <div className="banner info" style={{ marginTop: 10 }}>
          Showing the most recent {LIMIT} matches. Narrow the filters to see further back.
        </div>
      )}

      {loading && entries.length === 0 && <div className="empty">Loading…</div>}
      {!loading && entries.length === 0 && (
        <div className="empty">
          {filtered ? 'Nothing matches those filters.' : 'Nothing found.'}
        </div>
      )}

      {days.map(([day, list]) => {
        const total = list.reduce(
          (sum, entry) =>
            entry.kind === 'transfer'
              ? sum
              : sum + (entry.kind === 'expense' ? entry.amount : -entry.amount),
          0,
        );
        return (
          <div key={day}>
            <h2 className="spread">
              <span>{formatDayLabel(day)}</span>
              <span className="money">{money(total)}</span>
            </h2>
            <div className="card">
              {list.map((entry) => (
                <button
                  type="button"
                  className="session-item row-button"
                  key={entry.id}
                  aria-label={`Edit ${entry.description}`}
                  onClick={() => setEditing(entry)}
                >
                  <span className="desc">
                    {entry.description}
                    <div className="meta">
                      {entry.kind === 'transfer'
                        ? `${entry.account ?? '?'} → ${entry.toAccount ?? '?'}`
                        : [entry.counterparty, entry.category, entry.account]
                            .filter(Boolean)
                            .join(' · ')}
                      {entry.source === 'recurring' ? ' · auto' : ''}
                      {entry.note ? ' · needs attention' : ''}
                    </div>
                  </span>
                  <span
                    className={`money ${entry.kind === 'income' ? 'pos' : ''} ${
                      entry.kind === 'transfer' ? 'muted' : ''
                    }`}
                  >
                    {entry.kind === 'income' ? '+' : ''}
                    {money(entry.amount)}
                  </span>
                  <span className="chev" aria-hidden="true">
                    ›
                  </span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {editing && (
        <EntryEditor
          entry={editing}
          reference={reference}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setReloadKey((key) => key + 1);
            onChanged();
          }}
          onDeleted={() => {
            setEditing(null);
            setReloadKey((key) => key + 1);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
