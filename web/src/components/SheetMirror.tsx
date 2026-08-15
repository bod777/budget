import { useCallback, useEffect, useState } from 'react';
import { api, type SheetSyncStatus } from '../api.ts';

interface Props {
  toast: (message: string) => void;
}

function whenLabel(at: string): string {
  const date = new Date(at);
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} h ago`;
  return date.toLocaleDateString('en-IE', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function SheetMirror({ toast }: Props) {
  const [status, setStatus] = useState<SheetSyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.sheetSyncStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.runSheetSync();
      toast(`Mirrored ${result.expenses} expenses and ${result.income} income rows`);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Sync failed');
      await load();
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <>
      <h2>Google Sheets backup</h2>

      {!status.configured ? (
        <div className="card stack">
          <p className="small muted" style={{ margin: 0 }}>
            Not set up. A copy of every entry, plus a period-by-period summary, can be mirrored into
            a Google Sheet you own — useful as a backup and for pivots the dashboard does not do.
            It is one-way: the sheet never writes back, so nothing here can be overwritten by an
            edit made there.
          </p>
          <p className="small muted" style={{ margin: 0 }}>
            Setting it up needs a Google service account and a spreadsheet shared with it. The
            README has the steps.
          </p>
        </div>
      ) : (
        <div className="card stack">
          <div className="spread">
            <span>
              <strong>
                {status.lastRun?.status === 'ok'
                  ? 'Last mirrored'
                  : status.lastRun?.status === 'failed'
                    ? 'Last attempt failed'
                    : 'Never run'}
              </strong>
              <div className="small muted">
                {status.lastRun?.at ? whenLabel(status.lastRun.at) : 'no runs yet'}
                {status.lastRun?.detail ? ` · ${status.lastRun.detail}` : ''}
              </div>
            </span>
            <button type="button" className="btn small" disabled={busy} onClick={() => void run()}>
              {busy ? 'Mirroring…' : 'Mirror now'}
            </button>
          </div>

          {status.lastRun?.status === 'failed' && !error && (
            <div className="banner warn">{status.lastRun.detail}</div>
          )}
          {error && <div className="banner warn">{error}</div>}

          <p className="small muted" style={{ margin: 0 }}>
            Runs automatically once a day. Each run replaces the sheet contents, so it cannot drift
            — and edits made in the sheet are never read back.
          </p>

          {status.spreadsheetId && (
            <a
              className="btn secondary"
              href={`https://docs.google.com/spreadsheets/d/${status.spreadsheetId}/edit`}
              target="_blank"
              rel="noreferrer"
            >
              Open the sheet
            </a>
          )}
        </div>
      )}
    </>
  );
}
