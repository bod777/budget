import { useEffect, useMemo, useState } from 'react';
import { api, formatMoney, type Entry, type Reference } from '../api.ts';

interface Props {
  entry: Entry;
  reference: Reference;
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
}

/**
 * Edits an entry in place. Correcting a mistyped date should not mean deleting
 * the entry and typing the whole thing again, which is what the spreadsheet
 * forced and what people do by habit afterwards.
 */
export function EntryEditor({ entry, reference, onClose, onSaved, onDeleted }: Props) {
  const [occurredOn, setOccurredOn] = useState(entry.occurredOn);
  const [description, setDescription] = useState(entry.description);
  const [counterparty, setCounterparty] = useState(entry.counterparty ?? '');
  const [amount, setAmount] = useState(String(entry.amount));
  const [categoryId, setCategoryId] = useState(entry.categoryId);
  const [accountId, setAccountId] = useState<number | null>(entry.accountId);
  const [toAccountId, setToAccountId] = useState<number | null>(entry.toAccountId);
  const [note, setNote] = useState(entry.note ?? '');
  const isTransfer = entry.kind === 'transfer';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const categories = useMemo(
    () => reference.categories.filter((c) => c.kind === entry.kind),
    [reference.categories, entry.kind],
  );
  const accounts = useMemo(
    () => reference.accounts.filter((c) => entry.kind === 'transfer' || c.usableFor.includes(entry.kind)),
    [reference.accounts, entry.kind],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Stop the list behind the sheet from scrolling under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const valid =
    description.trim() !== '' &&
    Number.isFinite(Number(amount)) &&
    Number(amount) >= 0 &&
    (!isTransfer || (accountId !== null && toAccountId !== null && accountId !== toAccountId));

  const changed =
    occurredOn !== entry.occurredOn ||
    description !== entry.description ||
    counterparty !== (entry.counterparty ?? '') ||
    Number(amount) !== entry.amount ||
    categoryId !== entry.categoryId ||
    accountId !== entry.accountId ||
    toAccountId !== entry.toAccountId ||
    note !== (entry.note ?? '');

  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.updateEntry(entry.id, {
        kind: entry.kind,
        occurredOn,
        description: description.trim(),
        counterparty: isTransfer ? null : counterparty.trim() || null,
        amount: Number(amount),
        categoryId: isTransfer ? null : categoryId,
        accountId,
        toAccountId: isTransfer ? toAccountId : null,
        note: note.trim() || null,
      });
      onSaved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteEntry(entry.id);
      onDeleted();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not delete');
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onPointerDown={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${entry.description}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="sheet-head spread">
          <strong>Edit {entry.kind}</strong>
          <button type="button" className="btn secondary small" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sheet-body">
          {entry.note && (
            <div className="banner warn" style={{ marginBottom: 12 }}>
              {entry.note}
            </div>
          )}

          <div className="field">
            <label htmlFor="edit-date">Date</label>
            <input
              id="edit-date"
              type="date"
              value={occurredOn}
              onChange={(event) => setOccurredOn(event.target.value || entry.occurredOn)}
            />
          </div>

          <div className="field">
            <label htmlFor="edit-desc">Description</label>
            <input
              id="edit-desc"
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {!isTransfer && (
          <div className="field">
            <label htmlFor="edit-payee">{entry.kind === 'expense' ? 'Payee' : 'Payer'}</label>
            <input
              id="edit-payee"
              type="text"
              value={counterparty}
              autoComplete="off"
              onChange={(event) => setCounterparty(event.target.value)}
            />
          </div>
          )}

          <div className="field">
            <label htmlFor="edit-amount">Amount</label>
            <input
              id="edit-amount"
              className="amount-input money"
              type="text"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value.replace(/[^\d.]/g, ''))}
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
                  aria-pressed={categoryId === category.id}
                  onClick={() => setCategoryId(category.id)}
                >
                  {category.name}
                </button>
              ))}
            </div>
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
                  aria-pressed={accountId === account.id}
                  disabled={isTransfer && toAccountId === account.id}
                  onClick={() =>
                    setAccountId(accountId === account.id && !isTransfer ? null : account.id)
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
                    aria-pressed={toAccountId === account.id}
                    disabled={accountId === account.id}
                    onClick={() => setToAccountId(account.id)}
                  >
                    {account.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="field">
            <label htmlFor="edit-note">Note</label>
            <input
              id="edit-note"
              type="text"
              value={note}
              placeholder="Optional"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          {error && <div className="banner warn">{error}</div>}
        </div>

        <div className="sheet-foot stack">
          <button
            type="button"
            className="btn"
            disabled={!valid || !changed || busy}
            onClick={() => void save()}
          >
            {busy ? 'Saving…' : changed ? 'Save changes' : 'No changes'}
          </button>

          {confirmingDelete ? (
            <div className="spread">
              <span className="small muted">
                Delete {formatMoney(entry.amount, reference.currency, reference.locale)} entry?
              </span>
              <span style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  className="btn secondary small"
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn danger small"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  Delete
                </button>
              </span>
            </div>
          ) : (
            <button
              type="button"
              className="btn secondary"
              onClick={() => setConfirmingDelete(true)}
            >
              Delete entry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
