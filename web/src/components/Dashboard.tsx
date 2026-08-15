import { useEffect, useMemo, useState } from 'react';
import { api, formatMoney, type MonthView, type Reference } from '../api.ts';

interface Props {
  reference: Reference;
  refreshKey: number;
}

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IE', {
    month: 'long',
    year: 'numeric',
  });
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(y, m - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Periods run payday to payday, so "the current period" is not simply today's
 * calendar month — after the last payday of the month you are already spending
 * the next one. The server works it out from the pay schedule.
 */
function fallbackMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** "26 Jun – 30 Jul": the end is exclusive, so show the last day included. */
function periodLabel(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
  const lastDay = new Date(`${end}T00:00:00`);
  lastDay.setDate(lastDay.getDate() - 1);
  const lastIso = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(
    lastDay.getDate(),
  ).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(lastIso)}`;
}

export function Dashboard({ reference, refreshKey }: Props) {
  const [month, setMonth] = useState(fallbackMonth);
  const [latestMonth, setLatestMonth] = useState(fallbackMonth);
  const [view, setView] = useState<MonthView | null>(null);
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);

  // Land on the period today actually falls in, which after the last payday of
  // a month is already the next one.
  useEffect(() => {
    let cancelled = false;
    api
      .paySchedule()
      .then((schedule) => {
        if (cancelled) return;
        setLatestMonth(schedule.current.month);
        setMonth((current) => (current === fallbackMonth() ? schedule.current.month : current));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    api
      .month(month)
      .then((result) => {
        setView(result);
        setDrafts(
          Object.fromEntries(result.lines.map((line) => [line.categoryId, String(line.budget)])),
        );
      })
      .catch(() => setView(null));
  }, [month, refreshKey]);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

  const groups = useMemo(() => {
    if (!view) return [];
    const expense = view.lines.filter((l) => l.kind === 'expense');
    return [
      { label: 'Fixed', lines: expense.filter((l) => l.bucket === 'fixed') },
      { label: 'Variable', lines: expense.filter((l) => l.bucket === 'variable') },
    ];
  }, [view]);

  if (!view) {
    return <div className="empty">Loading {monthLabel(month)}…</div>;
  }

  const { totals } = view;
  const hasBudget = view.lines.some((l) => l.budget > 0);

  async function saveBudget() {
    setBusy(true);
    try {
      await api.saveMonth(month, {
        lines: Object.entries(drafts).map(([categoryId, amount]) => ({
          categoryId: Number(categoryId),
          amount: Number(amount) || 0,
        })),
      });
      const updated = await api.month(month);
      setView(updated);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  }

  async function startMonth() {
    setBusy(true);
    try {
      await api.initMonth(month);
      const updated = await api.month(month);
      setView(updated);
      setDrafts(
        Object.fromEntries(updated.lines.map((line) => [line.categoryId, String(line.budget)])),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="spread" style={{ marginBottom: 12 }}>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => setMonth(shiftMonth(month, -1))}
          aria-label="Previous month"
        >
          ←
        </button>
        <span className="center">
          <strong>{monthLabel(month)}</strong>
          <div className="small muted">{periodLabel(view.periodStart, view.periodEnd)}</div>
        </span>
        <button
          type="button"
          className="btn secondary small"
          onClick={() => setMonth(shiftMonth(month, 1))}
          aria-label="Next period"
          disabled={month >= latestMonth}
        >
          →
        </button>
      </div>

      <div className="stat-grid">
        <div className="stat">
          <div className="label">Spent</div>
          <div className="value money">{money(totals.expenseActual)}</div>
          {hasBudget && (
            <div className={`small ${totals.expenseDifference >= 0 ? 'pos' : 'neg'}`}>
              {totals.expenseDifference >= 0 ? 'under' : 'over'} by{' '}
              {money(Math.abs(totals.expenseDifference))}
            </div>
          )}
        </div>
        <div className="stat">
          <div className="label">Received</div>
          <div className="value money">{money(totals.incomeActual)}</div>
          {hasBudget && (
            <div className={`small ${totals.incomeDifference >= 0 ? 'pos' : 'neg'}`}>
              {totals.incomeDifference >= 0 ? '+' : ''}
              {money(totals.incomeDifference)} vs plan
            </div>
          )}
        </div>
        <div className="stat">
          <div className="label">This month</div>
          <div className={`value money ${totals.thisMonthActual >= 0 ? 'pos' : 'neg'}`}>
            {money(totals.thisMonthActual)}
          </div>
          <div className="small muted">after savings</div>
        </div>
        <div className="stat">
          <div className="label">Closing surplus</div>
          <div className={`value money ${totals.closingActual >= 0 ? 'pos' : 'neg'}`}>
            {money(totals.closingActual)}
          </div>
          <div className="small muted">opened at {money(view.openingSurplus)}</div>
        </div>
      </div>

      {!view.exists && (
        <div className="banner info" style={{ marginTop: 14 }}>
          <div className="spread">
            <span>
              No budget set for {monthLabel(month)}. Start it from the previous month&apos;s
              plan and carry the surplus forward.
            </span>
            <button
              type="button"
              className="btn small"
              onClick={() => void startMonth()}
              disabled={busy}
            >
              Start
            </button>
          </div>
        </div>
      )}

      <div className="spread" style={{ marginTop: 22 }}>
        <h2 style={{ margin: 0 }}>Expenses</h2>
        {editing ? (
          <span style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              className="btn secondary small"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn small"
              onClick={() => void saveBudget()}
              disabled={busy}
            >
              Save
            </button>
          </span>
        ) : (
          <button type="button" className="btn secondary small" onClick={() => setEditing(true)}>
            Edit budget
          </button>
        )}
      </div>

      <div className="card">
        <table className="budget-table">
          <thead>
            <tr>
              <th>Category</th>
              <th>Budget</th>
              <th>Actual</th>
              <th>Left</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <>
                <tr className="group-label" key={group.label}>
                  <td colSpan={4}>{group.label}</td>
                </tr>
                {group.lines.map((line) => {
                  const ratio =
                    line.budget > 0 ? Math.min(line.actual / line.budget, 1) : line.actual > 0 ? 1 : 0;
                  const over = line.budget > 0 && line.actual > line.budget;
                  return (
                    <tr key={line.categoryId}>
                      <td>
                        <span className="cat-cell">
                          <span
                            className={`cat-bar${over ? ' over' : ''}`}
                            style={{ right: `${(1 - ratio) * 100}%` }}
                            aria-hidden="true"
                          />
                          <span className="cat-name">{line.name}</span>
                        </span>
                      </td>
                      <td className="num">
                        {editing ? (
                          <input
                            type="text"
                            inputMode="decimal"
                            style={{ minHeight: 34, padding: '4px 6px', textAlign: 'right' }}
                            value={drafts[line.categoryId] ?? ''}
                            onChange={(event) =>
                              setDrafts((current) => ({
                                ...current,
                                [line.categoryId]: event.target.value.replace(/[^\d.]/g, ''),
                              }))
                            }
                          />
                        ) : (
                          money(line.budget)
                        )}
                      </td>
                      <td className="num">{money(line.actual)}</td>
                      <td className={`num ${line.difference >= 0 ? 'pos' : 'neg'}`}>
                        {money(line.difference)}
                      </td>
                    </tr>
                  );
                })}
              </>
            ))}
            <tr className="total">
              <td>Total</td>
              <td className="num">{money(totals.expenseBudget)}</td>
              <td className="num">{money(totals.expenseActual)}</td>
              <td className={`num ${totals.expenseDifference >= 0 ? 'pos' : 'neg'}`}>
                {money(totals.expenseDifference)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <h2>Income</h2>
      <div className="card">
        <table className="budget-table">
          <thead>
            <tr>
              <th>Source</th>
              <th>Budget</th>
              <th>Actual</th>
              <th>Diff</th>
            </tr>
          </thead>
          <tbody>
            {view.lines
              .filter((line) => line.kind === 'income')
              .map((line) => (
                <tr key={line.categoryId}>
                  <td>{line.name}</td>
                  <td className="num">
                    {editing ? (
                      <input
                        type="text"
                        inputMode="decimal"
                        style={{ minHeight: 34, padding: '4px 6px', textAlign: 'right' }}
                        value={drafts[line.categoryId] ?? ''}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [line.categoryId]: event.target.value.replace(/[^\d.]/g, ''),
                          }))
                        }
                      />
                    ) : (
                      money(line.budget)
                    )}
                  </td>
                  <td className="num">{money(line.actual)}</td>
                  <td className={`num ${line.difference >= 0 ? 'pos' : 'neg'}`}>
                    {money(line.difference)}
                  </td>
                </tr>
              ))}
            <tr className="total">
              <td>Total</td>
              <td className="num">{money(totals.incomeBudget)}</td>
              <td className="num">{money(totals.incomeActual)}</td>
              <td className={`num ${totals.incomeDifference >= 0 ? 'pos' : 'neg'}`}>
                {money(totals.incomeDifference)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {view.savings.length > 0 && (
        <>
          <h2>Savings</h2>
          <div className="card">
            <table className="budget-table">
              <tbody>
                {view.savings.map((line) => (
                  <tr key={line.id}>
                    <td>{line.name}</td>
                    <td className="num">{money(line.budget)}</td>
                    <td className="num">{money(line.actual)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
