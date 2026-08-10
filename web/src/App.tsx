import { useCallback, useEffect, useState } from 'react';
import { api, type Reference } from './api.ts';
import { EntryForm } from './components/EntryForm.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { History } from './components/History.tsx';
import { Recurring } from './components/Recurring.tsx';

type Tab = 'add' | 'month' | 'history' | 'auto';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'add', label: 'Add', glyph: '＋' },
  { id: 'month', label: 'Month', glyph: '◒' },
  { id: 'history', label: 'History', glyph: '☰' },
  { id: 'auto', label: 'Recurring', glyph: '↻' },
];

interface Toast {
  message: string;
  undo?: () => void | Promise<void>;
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div className="app">
      <div className="topbar">
        <h1>Budget</h1>
      </div>
      <form
        className="card stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.logIn(password);
            onDone();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Could not sign in');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error && <div className="banner warn">{error}</div>}
        <button type="submit" className="btn" disabled={busy || password === ''}>
          {busy ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [reference, setReference] = useState<Reference | null>(null);
  const [tab, setTab] = useState<Tab>('add');
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const showToast = useCallback((message: string, undo?: () => void | Promise<void>) => {
    setToast({ message, undo });
  }, []);

  useEffect(() => {
    api
      .session()
      .then((s) => setAuthed(s.authenticated))
      .catch(() => setAuthed(false));
  }, []);

  useEffect(() => {
    if (!authed) return;
    api.reference().then(setReference).catch(() => setReference(null));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    api
      .pending()
      .then((p) => setPendingCount(p.pending.length))
      .catch(() => setPendingCount(0));
  }, [authed, refreshKey, tab]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (authed === null) return <div className="empty">Loading…</div>;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  if (!reference) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="app">
        <div className="topbar">
          <h1>
            {tab === 'add'
              ? 'Add'
              : tab === 'month'
                ? 'This month'
                : tab === 'history'
                  ? 'History'
                  : 'Recurring'}
          </h1>
        </div>

        {tab === 'add' && (
          <>
            {pendingCount > 0 && (
              <div className="banner info">
                <div className="spread">
                  <span>
                    {pendingCount} recurring {pendingCount === 1 ? 'item is' : 'items are'} waiting
                    to be confirmed.
                  </span>
                  <button type="button" className="btn small" onClick={() => setTab('auto')}>
                    Review
                  </button>
                </div>
              </div>
            )}
            <EntryForm reference={reference} onSaved={refresh} toast={showToast} />
          </>
        )}

        {tab === 'month' && <Dashboard reference={reference} refreshKey={refreshKey} />}

        {tab === 'history' && (
          <History reference={reference} refreshKey={refreshKey} onChanged={refresh} />
        )}

        {tab === 'auto' && (
          <Recurring reference={reference} onChanged={refresh} toast={showToast} />
        )}
      </div>

      {toast && (
        <div className="toast" role="status">
          <span style={{ flex: 1 }}>{toast.message}</span>
          {toast.undo && (
            <button
              type="button"
              onClick={async () => {
                await toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      )}

      <nav className="tabbar">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            aria-current={tab === item.id ? 'page' : undefined}
            onClick={() => setTab(item.id)}
          >
            <span className="glyph" aria-hidden="true">
              {item.glyph}
            </span>
            <span>
              {item.label}
              {item.id === 'auto' && pendingCount > 0 && (
                <>
                  {' '}
                  <span className="badge">{pendingCount}</span>
                </>
              )}
            </span>
          </button>
        ))}
      </nav>
    </>
  );
}
