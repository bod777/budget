import { useCallback, useEffect, useState } from 'react';
import { api, type Reference } from './api.ts';
import { EntryForm } from './components/EntryForm.tsx';
import { Dashboard } from './components/Dashboard.tsx';
import { History } from './components/History.tsx';
import { Recurring } from './components/Recurring.tsx';
import { Trends } from './components/Trends.tsx';
import { PaySchedule } from './components/PaySchedule.tsx';

type Tab = 'add' | 'month' | 'trends' | 'history' | 'auto';

const TABS: { id: Tab; label: string; glyph: string }[] = [
  { id: 'add', label: 'Add', glyph: '＋' },
  { id: 'month', label: 'Budget', glyph: '◒' },
  { id: 'trends', label: 'Trends', glyph: '↗' },
  { id: 'history', label: 'History', glyph: '☰' },
  { id: 'auto', label: 'Recurring', glyph: '↻' },
];

interface Toast {
  message: string;
  undo?: () => void | Promise<void>;
}

function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.34 0-4.33-1.58-5.04-3.71H.96v2.33A9 9 0 0 0 9 18z"
      />
      <path
        fill="#FBBC05"
        d="M3.96 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l3-2.33z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l3 2.33C4.67 5.16 6.66 3.58 9 3.58z"
      />
    </svg>
  );
}

function Login({
  methods,
  onDone,
}: {
  methods: { password: boolean; google: boolean };
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A rejected sign-in comes back as a redirect, not a fetch response.
  const [redirectError] = useState(() => {
    const value = new URLSearchParams(window.location.search).get('auth_error');
    if (value) window.history.replaceState({}, '', window.location.pathname);
    return value;
  });

  return (
    <div className="app">
      <div className="topbar">
        <h1>Budget</h1>
      </div>

      {(error || redirectError) && (
        <div className="banner warn">{error ?? redirectError}</div>
      )}

      <div className="card stack">
        {methods.google && (
          <a className="btn google" href="/api/auth/google">
            <GoogleMark />
            <span>Continue with Google</span>
          </a>
        )}

        {methods.google && methods.password && (
          <div className="divider">
            <span>or</span>
          </div>
        )}

        {methods.password && (
          <form
            className="stack"
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
            <button
              type="submit"
              className="btn secondary"
              disabled={busy || password === ''}
            >
              {busy ? 'Checking…' : 'Sign in with password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [methods, setMethods] = useState({ password: true, google: false });
  const [reference, setReference] = useState<Reference | null>(null);
  const [tab, setTab] = useState<Tab>('add');
  const [refreshKey, setRefreshKey] = useState(0);
  const [pendingCount, setPendingCount] = useState(0);
  const [toast, setToast] = useState<Toast | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(() => setRefreshKey((key) => key + 1), []);

  const showToast = useCallback((message: string, undo?: () => void | Promise<void>) => {
    setToast({ message, undo });
  }, []);

  useEffect(() => {
    api
      .session()
      .then((s) => {
        setAuthed(s.authenticated);
        if (s.methods) setMethods(s.methods);
      })
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
  if (!authed) return <Login methods={methods} onDone={() => setAuthed(true)} />;
  if (!reference) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="app">
        <div className="topbar spread">
          <h1>
            {settingsOpen
              ? 'Settings'
              : tab === 'add'
                ? 'Add'
                : tab === 'month'
                  ? 'Budget'
                  : tab === 'trends'
                    ? 'Trends'
                    : tab === 'history'
                      ? 'History'
                      : 'Recurring'}
          </h1>
          <button
            type="button"
            className="icon-button"
            aria-label={settingsOpen ? 'Close settings' : 'Settings'}
            aria-pressed={settingsOpen}
            onClick={() => setSettingsOpen((open) => !open)}
          >
            {settingsOpen ? '✕' : '⚙'}
          </button>
        </div>

        {settingsOpen && (
          <PaySchedule
            toast={showToast}
            onChanged={refresh}
            reference={reference}
            refreshKey={refreshKey}
          />
        )}

        {!settingsOpen && tab === 'add' && (
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

        {!settingsOpen && tab === 'month' && <Dashboard reference={reference} refreshKey={refreshKey} />}

        {!settingsOpen && tab === 'trends' && (
          <Trends reference={reference} refreshKey={refreshKey} />
        )}

        {!settingsOpen && tab === 'history' && (
          <History reference={reference} refreshKey={refreshKey} onChanged={refresh} />
        )}

        {!settingsOpen && tab === 'auto' && (
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
            onClick={() => {
              setSettingsOpen(false);
              setTab(item.id);
            }}
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
