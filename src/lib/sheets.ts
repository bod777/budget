import { clearTokenCache, getAccessToken, type ServiceAccountKey } from './google-service-account.ts';

/**
 * The slice of the Sheets API this needs: make sure a tab exists, then replace
 * its contents wholesale.
 *
 * Replacing rather than appending is deliberate. An append-based mirror drifts
 * the moment anything is edited or deleted on this side, and reconciling that
 * drift is the two-way sync problem in disguise.
 */

const API = 'https://sheets.googleapis.com/v4/spreadsheets';

export type CellValue = string | number | null;

async function request<T>(
  key: ServiceAccountKey,
  url: string,
  init: RequestInit = {},
  retryOnAuthFailure = true,
): Promise<T> {
  const token = await getAccessToken(key);
  const response = await fetch(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

  if (response.status === 401 && retryOnAuthFailure) {
    clearTokenCache();
    return request<T>(key, url, init, false);
  }

  if (!response.ok) {
    const detail = await response.text();
    // The commonest failure by far is forgetting to share the sheet with the
    // service account, so name it rather than leaving a bare 403.
    if (response.status === 403) {
      throw new Error(
        `Sheets refused access (403). Share the spreadsheet with ${key.client_email} as an Editor.`,
      );
    }
    if (response.status === 404) {
      throw new Error('Spreadsheet not found — check SHEETS_SPREADSHEET_ID.');
    }
    throw new Error(`Sheets API error ${response.status}: ${detail.slice(0, 300)}`);
  }

  return (await response.json()) as T;
}

interface SheetProperties {
  sheets?: { properties?: { sheetId?: number; title?: string } }[];
}

/** Creates any of `titles` the spreadsheet does not already have. */
export async function ensureTabs(
  key: ServiceAccountKey,
  spreadsheetId: string,
  titles: string[],
): Promise<void> {
  const meta = await request<SheetProperties>(
    key,
    `${API}/${spreadsheetId}?fields=sheets.properties.title`,
  );
  const existing = new Set((meta.sheets ?? []).map((s) => s.properties?.title));
  const missing = titles.filter((title) => !existing.has(title));
  if (missing.length === 0) return;

  await request(key, `${API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: missing.map((title) => ({ addSheet: { properties: { title } } })),
    }),
  });
}

function quoteTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/** Clears a tab and writes `rows` starting at A1. */
export async function replaceTab(
  key: ServiceAccountKey,
  spreadsheetId: string,
  title: string,
  rows: CellValue[][],
): Promise<void> {
  const range = `${quoteTitle(title)}!A:ZZ`;

  await request(key, `${API}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, {
    method: 'POST',
    body: '{}',
  });

  if (rows.length === 0) return;

  await request(
    key,
    `${API}/${spreadsheetId}/values/${encodeURIComponent(
      `${quoteTitle(title)}!A1`,
    )}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ values: rows }),
    },
  );
}

/** Freezes the header row and bolds it, so the mirror is usable as a sheet. */
export async function formatHeaders(
  key: ServiceAccountKey,
  spreadsheetId: string,
  titles: string[],
): Promise<void> {
  const meta = await request<SheetProperties>(
    key,
    `${API}/${spreadsheetId}?fields=sheets.properties`,
  );
  const byTitle = new Map(
    (meta.sheets ?? []).map((s) => [s.properties?.title, s.properties?.sheetId]),
  );

  const requests = titles.flatMap((title) => {
    const sheetId = byTitle.get(title);
    if (sheetId === undefined) return [];
    return [
      {
        updateSheetProperties: {
          properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      },
    ];
  });

  if (requests.length === 0) return;
  await request(key, `${API}/${spreadsheetId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({ requests }),
  });
}
