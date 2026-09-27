import { useCallback, useEffect, useState } from 'react';
import { api, formatMoney, todayIso, type AccountBalance, type Reference } from '../api.ts';

interface Props {
  reference: Reference;
  refreshKey: number;
  /** Compact mode drops the editing controls, for showing balances elsewhere. */
  compact?: boolean;
  toast?: (message: string) => void;
  /**
   * Called after an account is created, so the entry form's account pickers
   * pick it up without a reload.
   */
  onAccountAdded?: () => void;
}

type AccountKind = AccountBalance['kind'];

const KIND_LABEL: Record<AccountKind, string> = {
  current: 'Current account',
  credit: 'Credit card',
  cash: 'Cash',
  savings: 'Savings',
  other: 'Other',
};

const KIND_OPTIONS: AccountKind[] = ['current', 'savings', 'credit', 'cash', 'other'];

/**
 * What each kind can be picked for, mirroring the rule the server applies. It
 * is spelled out here only to say so on the form, so adding a savings account
 * does not look like it has gone missing from the expense picker.
 */
const KIND_NOTE: Record<AccountKind, string> = {
  current: 'Offered for expenses, income and transfers.',
  savings: 'Offered for transfers in and out, and for income so interest can be logged. Never offered as somewhere you spent.',
  credit: 'Offered for expenses and transfers. Its balance reads as what you owe.',
  cash: 'Offered for expenses, income and transfers.',
  other: 'Offered for expenses, income and transfers.',
};

const emptyNewAccount = () => ({
  name: '',
  kind: 'savings' as AccountKind,
  balance: '',
  on: todayIso(),
});

export function Accounts({
  reference,
  refreshKey,
  compact = false,
  toast,
  onAccountAdded,
}: Props) {
  const [accounts, setAccounts] = useState<AccountBalance[]>([]);
  const [savingsTotal, setSavingsTotal] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState({ balance: '', on: todayIso() });
  const [adding, setAdding] = useState(false);
  const [newAccount, setNewAccount] = useState(emptyNewAccount);
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

  /**
   * A starting balance is optional here: an account opened today starts at
   * nothing worth typing, and one that already holds money can have its
   * balance set afterwards like any other.
   */
  async function createAccount() {
    const name = newAccount.name.trim();
    if (name === '') {
      setError('Give the account a name');
      return;
    }
    const typedBalance = newAccount.balance.trim();
    const balance = typedBalance === '' ? null : Number(typedBalance);
    if (balance !== null && !Number.isFinite(balance)) {
      setError('Enter a number for the starting balance');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.createAccount({
        name,
        kind: newAccount.kind,
        openingBalance: balance,
        openingOn: balance === null ? null : newAccount.on,
      });
      setNewAccount(emptyNewAccount());
      setAdding(false);
      await load();
      onAccountAdded?.();
      toast?.(`${name} added`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not add the account');
    } finally {
      setBusy(false);
    }
  }

  const unset = accounts.filter((a) => a.needsOpeningBalance);

  const known = accounts.filter((a) => a.balance !== null);
  const assets = known.reduce((total, a) => total + Math.max(a.balance ?? 0, 0), 0);
  const owed = known.reduce((total, a) => total + Math.max(-(a.balance ?? 0), 0), 0);
  const net = Math.round((assets - owed) * 100) / 100;
  const complete = unset.length === 0;

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
            {known.length > 0 && (
              <tr className="total">
                <td>
                  Net position
                  {!complete && <div className="small muted">excludes accounts without a balance</div>}
                </td>
                <td className="num">
                  <span className={`money ${net < 0 ? 'neg' : ''}`}>{money(net)}</span>
                  {owed > 0 && (
                    <div className="small muted">{money(assets)} less {money(owed)} owed</div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {!compact &&
        (adding ? (
          <div className="card stack" style={{ marginTop: 12 }}>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="new-account-name">Name</label>
              <input
                id="new-account-name"
                type="text"
                autoFocus
                placeholder="e.g. EBS Family Savings Account"
                value={newAccount.name}
                onChange={(event) =>
                  setNewAccount((a) => ({ ...a, name: event.target.value }))
                }
              />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label htmlFor="new-account-kind">Kind</label>
              <select
                id="new-account-kind"
                value={newAccount.kind}
                onChange={(event) =>
                  setNewAccount((a) => ({ ...a, kind: event.target.value as AccountKind }))
                }
              >
                {KIND_OPTIONS.map((kind) => (
                  <option key={kind} value={kind}>
                    {KIND_LABEL[kind]}
                  </option>
                ))}
              </select>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              {KIND_NOTE[newAccount.kind]}
            </p>
            <div className="row">
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="new-account-balance">Starting balance</label>
                <input
                  id="new-account-balance"
                  type="text"
                  inputMode="decimal"
                  placeholder={newAccount.kind === 'credit' ? '-432.10' : 'optional'}
                  value={newAccount.balance}
                  onChange={(event) =>
                    setNewAccount((a) => ({
                      ...a,
                      balance: event.target.value.replace(/[^\d.-]/g, ''),
                    }))
                  }
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="new-account-on">At end of</label>
                <input
                  id="new-account-on"
                  type="date"
                  value={newAccount.on}
                  max={todayIso()}
                  disabled={newAccount.balance.trim() === ''}
                  onChange={(event) => setNewAccount((a) => ({ ...a, on: event.target.value }))}
                />
              </div>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              Leave the balance blank if the account is new or you would rather look it up later —
              it will show as not set until you fill it in, never as zero.
              {newAccount.kind === 'savings' &&
                ' Total saved needs every savings account to have one, so it will read as blank' +
                  ' until this account has a balance too.'}
            </p>
            <div className="spread">
              <button
                type="button"
                className="btn secondary small"
                onClick={() => {
                  setAdding(false);
                  setNewAccount(emptyNewAccount());
                  setError(null);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn small"
                disabled={busy}
                onClick={() => void createAccount()}
              >
                Add account
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn secondary small"
            style={{ marginTop: 12 }}
            onClick={() => {
              setAdding(true);
              setError(null);
            }}
          >
            Add an account
          </button>
        ))}

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
