import { useCallback, useEffect, useState } from 'react';
import { api, type PayOverrideRow, type PayRuleRow, type PreviewPeriod } from '../api.ts';
import { SheetMirror } from './SheetMirror.tsx';
import { Accounts } from './Accounts.tsx';

interface Props {
  toast: (message: string) => void;
  onChanged: () => void;
  reference: import('../api.ts').Reference;
  refreshKey: number;
  /** Reloads the account and category lists the entry forms are built from. */
  onReferenceChanged: () => void;
}

const DAY_OPTIONS: (number | 'last')[] = ['last', 28, 27, 26, 25, 15, 1];

function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IE', {
    month: 'long',
    year: 'numeric',
  });
}

function dayLabel(dayRule: 'last' | number): string {
  if (dayRule === 'last') return 'Last day of the month';
  const suffix =
    dayRule % 10 === 1 && dayRule !== 11
      ? 'st'
      : dayRule % 10 === 2 && dayRule !== 12
        ? 'nd'
        : dayRule % 10 === 3 && dayRule !== 13
          ? 'rd'
          : 'th';
  return `${dayRule}${suffix} of the month`;
}

function rangeLabel(start: string, end: string): string {
  const fmt = (iso: string) =>
    new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', { day: 'numeric', month: 'short' });
  const last = new Date(`${end}T00:00:00`);
  last.setDate(last.getDate() - 1);
  const lastIso = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, '0')}-${String(
    last.getDate(),
  ).padStart(2, '0')}`;
  return `${fmt(start)} – ${fmt(lastIso)}`;
}

function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function today(): string {
  const now = new Date();
  return `${thisMonth()}-${String(now.getDate()).padStart(2, '0')}`;
}

function dateLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, m, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function PaySchedule({
  toast,
  onChanged,
  reference,
  refreshKey,
  onReferenceChanged,
}: Props) {
  const [rules, setRules] = useState<PayRuleRow[]>([]);
  const [overrides, setOverrides] = useState<PayOverrideRow[]>([]);
  const [preview, setPreview] = useState<PreviewPeriod[]>([]);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<{ effectiveFrom: string; dayRule: 'last' | number; note: string }>(
    { effectiveFrom: thisMonth(), dayRule: 'last', note: '' },
  );
  const [error, setError] = useState<string | null>(null);
  const [oneOff, setOneOff] = useState<{ month: string; paidOn: string; note: string }>({
    month: thisMonth(),
    paidOn: today(),
    note: '',
  });

  const load = useCallback(async () => {
    const result = await api.paySchedule();
    setRules(result.rules);
    setOverrides(result.overrides ?? []);
    setPreview(result.preview ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(rule: PayRuleRow, changes: Partial<PayRuleRow>) {
    setBusy(true);
    setError(null);
    try {
      await api.updatePayRule(rule.id, {
        effectiveFrom: changes.effectiveFrom ?? rule.effectiveFrom,
        dayRule: changes.dayRule ?? rule.dayRule,
        note: changes.note ?? rule.note,
      });
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      await api.createPayRule({
        effectiveFrom: draft.effectiveFrom,
        dayRule: draft.dayRule,
        note: draft.note || null,
      });
      setAdding(false);
      setDraft({ effectiveFrom: thisMonth(), dayRule: 'last', note: '' });
      await load();
      onChanged();
      toast('Pay schedule updated');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add');
    } finally {
      setBusy(false);
    }
  }

  async function remove(rule: PayRuleRow) {
    setBusy(true);
    setError(null);
    try {
      await api.deletePayRule(rule.id);
      await load();
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete');
    } finally {
      setBusy(false);
    }
  }

  async function saveOneOff() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.setPayOverride(oneOff.month, {
        paidOn: oneOff.paidOn,
        note: oneOff.note || null,
      });
      await load();
      onChanged();
      toast(`${monthLabel(result.next.month)} now starts ${dateLabel(result.paidOn)}`);
      setOneOff({ month: thisMonth(), paidOn: today(), note: '' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function clearOneOff(month: string) {
    setBusy(true);
    setError(null);
    try {
      await api.clearPayOverride(month);
      await load();
      onChanged();
      toast(`${monthLabel(month)} is back on the usual schedule`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not remove');
    } finally {
      setBusy(false);
    }
  }

  async function rederive() {
    setBusy(true);
    try {
      const result = await api.rederivePeriods();
      await load();
      onChanged();
      toast(`${result.rederived} period${result.rederived === 1 ? '' : 's'} recalculated`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Accounts and balances</h2>
      <Accounts
        reference={reference}
        refreshKey={refreshKey}
        toast={toast}
        onAccountAdded={onReferenceChanged}
      />

      <p className="small muted" style={{ marginTop: 24 }}>
        Budget periods run from one payday to the day before the next. A payday that lands on a
        weekend or an Irish bank holiday moves back to the previous working day.
      </p>

      <h2>When you are paid</h2>
      <div className="card stack">
        {rules.map((rule) => (
          <div key={rule.id} className="rule-row">
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`from-${rule.id}`}>From</label>
              <input
                id={`from-${rule.id}`}
                type="month"
                value={rule.effectiveFrom}
                disabled={busy}
                onChange={(event) => void save(rule, { effectiveFrom: event.target.value })}
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor={`day-${rule.id}`}>Paid on</label>
              <select
                id={`day-${rule.id}`}
                value={String(rule.dayRule)}
                disabled={busy}
                onChange={(event) =>
                  void save(rule, {
                    dayRule: event.target.value === 'last' ? 'last' : Number(event.target.value),
                  })
                }
              >
                {DAY_OPTIONS.map((option) => (
                  <option key={String(option)} value={String(option)}>
                    {dayLabel(option)}
                  </option>
                ))}
                {!DAY_OPTIONS.includes(rule.dayRule) && (
                  <option value={String(rule.dayRule)}>{dayLabel(rule.dayRule)}</option>
                )}
              </select>
            </div>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy || rules.length <= 1}
              title={rules.length <= 1 ? 'At least one rule is needed' : 'Remove this rule'}
              onClick={() => void remove(rule)}
            >
              ✕
            </button>
            {rule.note && <div className="small muted rule-note">{rule.note}</div>}
          </div>
        ))}

        {adding ? (
          <div className="stack" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
            <div className="row">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="new-from">From</label>
                <input
                  id="new-from"
                  type="month"
                  value={draft.effectiveFrom}
                  onChange={(event) =>
                    setDraft((d) => ({ ...d, effectiveFrom: event.target.value }))
                  }
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="new-day">Paid on</label>
                <select
                  id="new-day"
                  value={String(draft.dayRule)}
                  onChange={(event) =>
                    setDraft((d) => ({
                      ...d,
                      dayRule: event.target.value === 'last' ? 'last' : Number(event.target.value),
                    }))
                  }
                >
                  {DAY_OPTIONS.map((option) => (
                    <option key={String(option)} value={String(option)}>
                      {dayLabel(option)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="new-note">Note</label>
              <input
                id="new-note"
                type="text"
                placeholder="e.g. new job"
                value={draft.note}
                onChange={(event) => setDraft((d) => ({ ...d, note: event.target.value }))}
              />
            </div>
            <div className="spread">
              <button type="button" className="btn secondary small" onClick={() => setAdding(false)}>
                Cancel
              </button>
              <button type="button" className="btn small" disabled={busy} onClick={() => void add()}>
                Add rule
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn secondary" onClick={() => setAdding(true)}>
            Add a change of pay date
          </button>
        )}
      </div>

      {error && <div className="banner warn" style={{ marginTop: 12 }}>{error}</div>}

      <h2>Paid early or late one month</h2>
      <div className="card stack">
        <p className="small muted" style={{ margin: 0 }}>
          Recording the day pay actually landed changes that one month only, leaving the schedule
          above alone. Naming a month closes its period on that day and opens the next one — pay
          arriving early in {monthLabel(oneOff.month)} starts the {monthLabel(nextMonth(oneOff.month))}{' '}
          budget early.
        </p>

        {overrides.map((override) => (
          <div key={override.month} className="rule-row">
            <div>
              {monthLabel(override.month)} — paid {dateLabel(override.paidOn)}
              {override.note && <div className="small muted">{override.note}</div>}
            </div>
            <button
              type="button"
              className="btn secondary small"
              disabled={busy}
              title="Back to the usual schedule"
              onClick={() => void clearOneOff(override.month)}
            >
              ✕
            </button>
          </div>
        ))}

        <div className="row">
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="oneoff-month">Pay for</label>
            <input
              id="oneoff-month"
              type="month"
              value={oneOff.month}
              onChange={(event) => setOneOff((d) => ({ ...d, month: event.target.value }))}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor="oneoff-date">Landed on</label>
            <input
              id="oneoff-date"
              type="date"
              value={oneOff.paidOn}
              onChange={(event) => setOneOff((d) => ({ ...d, paidOn: event.target.value }))}
            />
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="oneoff-note">Note</label>
          <input
            id="oneoff-note"
            type="text"
            placeholder="e.g. paid early"
            value={oneOff.note}
            onChange={(event) => setOneOff((d) => ({ ...d, note: event.target.value }))}
          />
        </div>
        <div className="spread">
          <span />
          <button type="button" className="btn small" disabled={busy} onClick={() => void saveOneOff()}>
            Record this pay date
          </button>
        </div>
      </div>

      <h2>Periods this produces</h2>
      <div className="card">
        <table className="budget-table">
          <tbody>
            {preview.map((period) => (
              <tr key={period.month}>
                <td>
                  {monthLabel(period.month)}
                  {period.isCurrent && <span className="badge-soft">now</span>}
                </td>
                <td className="num">
                  {rangeLabel(period.start, period.end)}
                  {(period.startOverridden || period.endOverridden) && (
                    <span className="badge-soft">one-off</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Already-started periods</h2>
      <div className="card stack">
        <p className="small muted" style={{ margin: 0 }}>
          A period keeps the dates it had when it was started, so changing the schedule cannot move
          history underneath you. Recalculate to make past periods follow the rules above instead.
        </p>
        <button type="button" className="btn secondary" disabled={busy} onClick={() => void rederive()}>
          Recalculate past periods
        </button>
      </div>

      <SheetMirror toast={toast} />
    </div>
  );
}
