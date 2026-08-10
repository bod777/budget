import { useEffect, useMemo, useState } from 'react';
import {
  api,
  formatDayLabel,
  formatMoney,
  type Entry,
  type Kind,
  type Reference,
} from '../api.ts';

interface Props {
  reference: Reference;
  refreshKey: number;
  onChanged: () => void;
}

export function History({ reference, refreshKey, onChanged }: Props) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .entries({
          search: search || undefined,
          kind: kind === 'all' ? undefined : kind,
          limit: 200,
        })
        .then((r) => setEntries(r.entries))
        .catch(() => setEntries([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(timer);
  }, [search, kind, refreshKey]);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

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

  async function remove(entry: Entry) {
    await api.deleteEntry(entry.id);
    setEntries((list) => list.filter((e) => e.id !== entry.id));
    onChanged();
  }

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
        {(['all', 'expense', 'income'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => setKind(option)}
          >
            {option === 'all' ? 'All' : option === 'expense' ? 'Expenses' : 'Income'}
          </button>
        ))}
      </div>

      {loading && entries.length === 0 && <div className="empty">Loading…</div>}
      {!loading && entries.length === 0 && <div className="empty">Nothing found.</div>}

      {days.map(([day, list]) => {
        const total = list.reduce(
          (sum, entry) => sum + (entry.kind === 'expense' ? entry.amount : -entry.amount),
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
                <div className="session-item" key={entry.id}>
                  <span className="desc">
                    {entry.description}
                    <div className="meta">
                      {[entry.counterparty, entry.category, entry.channel]
                        .filter(Boolean)
                        .join(' · ')}
                      {entry.source === 'recurring' ? ' · auto' : ''}
                    </div>
                  </span>
                  <span className={`money ${entry.kind === 'income' ? 'pos' : ''}`}>
                    {entry.kind === 'income' ? '+' : ''}
                    {money(entry.amount)}
                  </span>
                  <button
                    type="button"
                    className="btn secondary small"
                    aria-label={`Delete ${entry.description}`}
                    onClick={() => void remove(entry)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
