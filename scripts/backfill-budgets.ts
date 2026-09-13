/**
 * Backfills historical budgets from the Google Drive folder of monthly
 * workbooks.
 *
 *   npm run backfill-budgets -- [--dry-run]
 *
 * Reads each workbook's "Monthly Budget" tab through the same service account
 * used for the sheet mirror, so nothing has to be downloaded by hand. The
 * folder must be shared with that account.
 *
 * The workbooks to read, and which account each savings label in them means,
 * come from data/budget-workbooks.json (gitignored; see the README).
 *
 * Only budgeted figures and the opening surplus are taken. Actuals are already
 * derived from imported entries, so a stale total in a three-year-old sheet can
 * never contradict them.
 */
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query, withTransaction } from '../src/db.ts';
import { env } from '../src/env.ts';
import { getAccessToken } from '../src/lib/google-service-account.ts';
import { normaliseKey } from '../src/lib/text.ts';
import { periodFor, type PayRule } from '../src/lib/pay-periods.ts';
import { parseBudgetSheet, type ParsedBudget } from './lib/parse-budget-sheet.ts';
import { loadBudgetWorkbooks } from './lib/private-config.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sheets allows a limited number of reads per minute and this makes two per
 * workbook, so a run over three years of them will be throttled. A 429 is a
 * "wait", not a failure.
 */
async function getWithRetry(url: string, token: string, attempts = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (response.status !== 429 || attempt >= attempts - 1) return response;
    await sleep(2000 * 2 ** attempt);
  }
}

async function fetchTab(token: string, id: string): Promise<string | null> {
  // The values endpoint returns the grid directly; asking for the first sheet
  // by index avoids depending on its title.
  const meta = await getWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=sheets.properties.title`,
    token,
  );
  if (!meta.ok) {
    if (meta.status === 403) throw new Error('not shared with the service account');
    if (meta.status === 404) throw new Error('not found');
    throw new Error(`metadata ${meta.status}`);
  }
  const sheets = (await meta.json()) as { sheets?: { properties?: { title?: string } }[] };
  const first = sheets.sheets?.[0]?.properties?.title;
  if (!first) return null;

  const range = encodeURIComponent(`'${first.replace(/'/g, "''")}'!A1:M60`);
  const response = await getWithRetry(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${range}?majorDimension=ROWS`,
    token,
  );
  if (!response.ok) throw new Error(`values ${response.status}`);
  const payload = (await response.json()) as { values?: string[][] };

  // Re-emit as CSV so the same parser handles both this and a downloaded file.
  return (payload.values ?? [])
    .map((row) =>
      row
        .map((value) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value))
        .join(','),
    )
    .join('\n');
}

async function main() {
  const config = await loadBudgetWorkbooks();
  if (!config || config.workbooks.length === 0) {
    throw new Error('No workbooks listed: create data/budget-workbooks.json (see the README)');
  }
  const { workbooks, savingsAccounts } = config;

  const key = env.sheets.serviceAccount;
  if (!key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set');
  const token = await getAccessToken(key);

  const rules = (
    await query<{ effective_from: string; day_rule: string }>(
      'select effective_from, day_rule from pay_schedule order by effective_from',
    )
  ).map((row): PayRule => ({
    effectiveFrom: String(row.effective_from).slice(0, 10),
    dayRule: row.day_rule === 'last' ? 'last' : Number(row.day_rule),
  }));

  const categories = await query<{ id: number; kind: string; name: string }>(
    'select id, kind, name from categories',
  );
  const categoryByKey = new Map(
    categories.map((row) => [`${row.kind}|${normaliseKey(row.name)}`, row.id]),
  );
  const accounts = await query<{ id: number; name: string }>('select id, name from accounts');
  const accountByKey = new Map(accounts.map((row) => [normaliseKey(row.name), row.id]));

  const parsed: ParsedBudget[] = [];
  const problems: string[] = [];
  const boundaryNotes: string[] = [];

  for (const workbook of workbooks) {
    try {
      const csv = await fetchTab(token, workbook.id);
      if (!csv) {
        problems.push(`${workbook.title}: no sheets`);
        continue;
      }
      const budget = parseBudgetSheet(workbook.title, csv);
      if (!budget) {
        problems.push(`${workbook.title}: could not work out which month it is`);
        continue;
      }
      parsed.push(budget);

      // The sheets carry their own period dates, which is a free check on the
      // pay schedule the app computes.
      if (budget.startingDate && rules.length) {
        const computed = periodFor(budget.month, rules);
        if (computed.start !== budget.startingDate) {
          boundaryNotes.push(
            `${budget.month}: sheet starts ${budget.startingDate}, app computes ${computed.start}`,
          );
        }
      }
      process.stdout.write('.');
      // Stay inside the per-minute read quota rather than relying on retries.
      await sleep(400);
    } catch (error) {
      problems.push(`${workbook.title}: ${error instanceof Error ? error.message : 'failed'}`);
      process.stdout.write('x');
    }
  }
  process.stdout.write('\n');

  parsed.sort((a, b) => a.month.localeCompare(b.month));
  const unknownLabels = new Set<string>();

  const report = [
    '# Budget backfill report',
    '',
    `Generated ${new Date().toISOString()}`,
    '',
    `- Workbooks read: **${parsed.length}** of ${workbooks.length}`,
    `- Range: **${parsed[0]?.month ?? '—'} to ${parsed[parsed.length - 1]?.month ?? '—'}**`,
    '',
    '## Period boundaries',
    '',
    boundaryNotes.length
      ? [
          'These periods keep the dates recorded in the sheet, not the computed ones —',
          'pay landing early before Christmas is real and no day-of-month rule can know it:',
          '',
          ...boundaryNotes.map((n) => `- ${n}`),
        ].join('\n')
      : "Every sheet's own start date matches the period the app computes.",
    '',
    '## Budgets found',
    '',
    '| Period | Opening surplus | Expense lines | Income lines | Savings targets |',
    '|---|---|---|---|---|',
    ...parsed.map(
      (b) =>
        `| ${b.month} | ${b.openingSurplus === null ? '—' : b.openingSurplus.toFixed(2)} | ` +
        `${Object.keys(b.expenses).length} | ${Object.keys(b.income).length} | ${Object.keys(b.savings).length} |`,
    ),
    '',
  ];

  if (dryRun) {
    for (const budget of parsed) {
      for (const label of Object.keys(budget.expenses)) {
        if (!categoryByKey.has(`expense|${normaliseKey(label)}`)) unknownLabels.add(`expense: ${label}`);
      }
      for (const label of Object.keys(budget.income)) {
        if (!categoryByKey.has(`income|${normaliseKey(label)}`)) unknownLabels.add(`income: ${label}`);
      }
      for (const label of Object.keys(budget.savings)) {
        if (!savingsAccounts[label.toLowerCase()]) unknownLabels.add(`savings: ${label}`);
      }
    }
    report.push('## Labels with no match', '', unknownLabels.size
      ? [...unknownLabels].map((l) => `- ${l}`).join('\n')
      : '_none_', '');
    if (problems.length) report.push('## Problems', '', problems.map((p) => `- ${p}`).join('\n'), '');
    await writeFile(join(root, 'data/budget-backfill-report.md'), report.join('\n'));
    console.log(`\nparsed ${parsed.length} workbooks — wrote data/budget-backfill-report.md`);
    console.log('dry run: nothing written to the database');
    await pool.end();
    return;
  }

  let months = 0;
  let lines = 0;
  let savingsRows = 0;

  await withTransaction(async (client) => {
    for (const budget of parsed) {
      const monthDate = `${budget.month}-01`;
      // Where a sheet records its own dates they win: an employer paying
      // early before Christmas is real, and no rule about the 28th can know
      // it. The computed period is only the fallback.
      const computed = rules.length ? periodFor(budget.month, rules) : null;
      const periodStart = budget.startingDate ?? computed?.start ?? null;
      const periodEnd = budget.endingDate ?? computed?.end ?? null;

      await client.query(
        `insert into budget_months (month, opening_surplus, period_start, period_end)
         values ($1::date, $2, $3::date, $4::date)
         on conflict (month) do update set
           opening_surplus = coalesce(excluded.opening_surplus, budget_months.opening_surplus),
           period_start = coalesce(budget_months.period_start, excluded.period_start),
           period_end = coalesce(budget_months.period_end, excluded.period_end)`,
        [monthDate, budget.openingSurplus, periodStart, periodEnd],
      );
      months += 1;

      for (const [label, amount] of Object.entries(budget.expenses)) {
        const id = categoryByKey.get(`expense|${normaliseKey(label)}`);
        if (!id) {
          unknownLabels.add(`expense: ${label}`);
          continue;
        }
        await client.query(
          `insert into budget_lines (month, category_id, amount)
           values ($1::date, $2, $3)
           on conflict (month, category_id) do update set amount = excluded.amount`,
          [monthDate, id, amount],
        );
        lines += 1;
      }

      for (const [label, amount] of Object.entries(budget.income)) {
        const id = categoryByKey.get(`income|${normaliseKey(label)}`);
        if (!id) {
          unknownLabels.add(`income: ${label}`);
          continue;
        }
        await client.query(
          `insert into budget_lines (month, category_id, amount)
           values ($1::date, $2, $3)
           on conflict (month, category_id) do update set amount = excluded.amount`,
          [monthDate, id, amount],
        );
        lines += 1;
      }

      for (const [label, amount] of Object.entries(budget.savings)) {
        const accountName = savingsAccounts[label.toLowerCase()];
        const id = accountName ? accountByKey.get(normaliseKey(accountName)) : undefined;
        if (!id) {
          unknownLabels.add(`savings: ${label}`);
          continue;
        }
        await client.query(
          `insert into savings_targets (month, account_id, amount)
           values ($1::date, $2, $3)
           on conflict (month, account_id) do update set amount = excluded.amount`,
          [monthDate, id, amount],
        );
        savingsRows += 1;
      }
    }
  });

  report.push('## Labels with no match', '', unknownLabels.size
    ? [...unknownLabels].map((l) => `- ${l}`).join('\n')
    : '_none_', '');
  if (problems.length) report.push('## Problems', '', problems.map((p) => `- ${p}`).join('\n'), '');
  await writeFile(join(root, 'data/budget-backfill-report.md'), report.join('\n'));

  console.log(`\nbackfilled ${months} periods, ${lines} budget lines, ${savingsRows} savings targets`);
  console.log('wrote data/budget-backfill-report.md');
  await pool.end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await pool.end().catch(() => {});
  process.exit(1);
});
