import { useCallback, useEffect, useState } from 'react';
import { api, formatMoney, todayIso, type AccountBalance, type Reference } from '../api.ts';

interface Props {
  reference: Reference;
  refreshKey: number;
  /** Compact mode drops the editing controls, for showing balances elsewhere. */
  compact?: boolean;
  toast?: (message: string) => void;
}

const KIND_LABEL: Record<AccountBalance['kind'], string> = {
  current: 'Current account',
  credit: 'Credit card',
  cash: 'Cash',
  savings: 'Savings',
  other: 'Other',
};

export function Accounts({ reference, refreshKey, compact = false, toast }: Props) {
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [savingsTotal, setSavingsTotal] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ balance: '', on: todayIso() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);

  const load = useCallback(async () => {
    try {
      const result = await api.accounts();
      setAccounts(result.accounts.filter((a) => !a.archived));
      setSavingsTotal(result.savingsTotal);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  async function saveOpening(account: AccountBalance) {
    const balance = Number(draft.balance);
    if (!Number.isFinite(balance)) {
      setError('Enter a number');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateAccount(account.id, { openingBalance: balance, openingOn: draft.on });
      setEditing(null);
      await load();
      toast?.(`${account.name} balance set`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const unset = accounts.filter((a) => a.needsOpeningBalance);

  return (
    <div>
      {!compact && savingsTotal !== null && (
        <div className="stat" style={{ marginBottom: 12 }}>
          <div className="label">Total saved</div>
          <div className="value money pos">{money(savingsTotal)}</div>
        </div>
      )}

      {!compact && unset.length > 0 && (
        <div className="banner warn">
          {unset.length} account{unset.length === 1 ? '' : 's'} still{' '}
          {unset.length === 1 ? 'needs' : 'need'} a starting balance. Until then{' '}
          {unset.length === 1 ? 'its' : 'their'} balance shows as not set rather than as zero. Tap
          Set below and enter what the account holds today.
        </div>
      )}

      <div className="card">
        <table className="budget-table">
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <span className="cat-name">{account.name}</span>
                  <div className="small muted">
                    {KIND_LABEL[account.kind]}
                    {account.openingOn ? ` · balance at end of ${account.openingOn}` : ''}
                  </div>
                  {!compact && editing === account.id && (
                    <div className="stack" style={{ marginTop: 8 }}>
                      <div className="row">
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label htmlFor={`bal-${account.id}`}>Closing balance</label>
                          <input
                            id={`bal-${account.id}`}
                            type="text"
                            inputMode="decimal"
                            value={draft.balance}
                            placeholder={account.kind === 'credit' ? '-432.10' : '0.00'}
                            onChange={(event) =>
                              setDraft((d) => ({
                                ...d,
                                balance: event.target.value.replace(/[^\d.-]/g, ''),
                              }))
                            }
                          />
                        </div>
                        <div className="field" style={{ marginBottom: 0 }}>
                          <label htmlFor={`on-${account.id}`}>At end of</label>
                          <input
                            id={`on-${account.id}`}
                            type="date"
                            value={draft.on}
                            max={todayIso()}
                            onChange={(event) => setDraft((d) => ({ ...d, on: event.target.value }))}
                          />
                        </div>
                      </div>
                      <p className="small muted" style={{ margin: 0 }}>
                          The balance at the close of that day, including anything already spent on
                          it. Only entries dated after it move the balance.
                          {account.kind === 'credit' &&
                          ' A card you owe money on is negative — enter −432.10 if you owe €432.10.'}
                      </p>
                      <div className="spread">
                        <button
                          type="button"
                          className="btn secondary small"
                          onClick={() => setEditing(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={busy}
                          onClick={() => void saveOpening(account)}
                        >
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </td>
                <td className="num">
                  {account.balance === null ? (
                    <span className="muted small">not set</span>
                  ) : account.owed !== null && account.owed > 0 ? (
                    <span className="money neg">{money(account.owed)} owed</span>
                  ) : (
                    <span className={`money ${account.balance < 0 ? 'neg' : ''}`}>
                      {money(account.balance)}
                    </span>
                  )}
                  {!compact && (
                    <div>
                      <button
                        type="button"
                        className="btn secondary small"
                        style={{ marginTop: 6 }}
                        onClick={() => {
                          setEditing(editing === account.id ? null : account.id);
                          setDraft({
                            balance:
                              account.openingBalance === null ? '' : String(account.openingBalance),
                            on: account.openingOn ?? todayIso(),
                          });
                        }}
                      >
                        {account.needsOpeningBalance ? 'Set' : 'Adjust'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && (
        <div className="banner warn" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}

      {!compact && (
        <p className="small muted">
          Balances are worked out from the starting figure plus everything logged since, so they are
          never typed in twice. If one drifts from your real statement, something is missing — which
          is the point of tracking them.
        </p>
      )}
    </div>
  );
}
