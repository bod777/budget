/**
 * Imports the Google Form response exports into Postgres.
 *
 * Run:  npm run import -- [--dry-run]
 *
 * Expects data/raw/expenses.csv and data/raw/income.csv, exported from the two
 * response sheets via File > Download > Comma Separated Values.
 *
 * The import is deliberately conservative about changing meaning: it merges
 * payee spellings and drops exact duplicate rows, but it never rewrites a
 * category or amount. Anything that looks wrong but is a judgement call gets
 * written to data/import-report.md for review instead.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from '../src/db.ts';
import { parseCsvRecords } from './lib/csv.ts';
import {
  buildCanonicalNames,
  canonicalNameFor,
  normaliseKey,
  parseAmount,
  parseFormDate,
  parseFormTimestamp,
} from './lib/normalise.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

interface StagedEntry {
  kind: 'expense' | 'income';
  occurredOn: string;
  description: string;
  counterparty: string | null;
  amount: number;
  category: string;
  channel: string | null;
  note: string | null;
  loggedAt: string;
  sourceRow: number;
}

const problems: string[] = [];
const notes: string[] = [];

function pick(row: Record<string, string>, ...names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function stage(
  rows: Record<string, string>[],
  kind: 'expense' | 'income',
): StagedEntry[] {
  const staged: StagedEntry[] = [];

  rows.forEach((row, index) => {
    const lineNo = index + 2; // account for the header row
    const label = `${kind} row ${lineNo}`;

    const occurredOn = parseFormDate(pick(row, 'Date'));
    if (!occurredOn) {
      problems.push(`${label}: unparseable date ${JSON.stringify(pick(row, 'Date'))} — skipped`);
      return;
    }

    // An unparseable amount means the original form response is wrong (a
    // channel typed into the amount box, say). Dropping the row would hide the
    // mistake; importing it at zero with a note surfaces it in the app where
    // it can be corrected, and contributes nothing to any total meanwhile.
    const rawAmount = pick(row, 'Amount');
    const parsedAmount = parseAmount(rawAmount);
    let amount = parsedAmount;
    let note: string | null = null;

    if (parsedAmount === null) {
      amount = 0;
      note = `Amount missing in the original form response (the Amount field contained ${JSON.stringify(rawAmount)}). Needs correcting.`;
      problems.push(
        `${label}: unparseable amount ${JSON.stringify(rawAmount)} — imported as 0 and flagged`,
      );
    } else if (parsedAmount < 0) {
      amount = Math.abs(parsedAmount);
      note = `Recorded as a negative amount (${parsedAmount}) in the original form response.`;
      problems.push(`${label}: negative amount ${parsedAmount} — imported as ${amount} and flagged`);
    }

    const category = pick(row, 'Category');
    if (category === '') {
      problems.push(`${label}: no category — skipped`);
      return;
    }

    const description = pick(row, 'Description', 'Description ').replace(/\s+/g, ' ').trim();
    // Expenses call it Payee, income calls it Payer; both are the other side of
    // the transaction.
    const counterparty = pick(row, 'Payee', 'Payer').replace(/\s+/g, ' ').trim() || null;
    const channel = pick(row, 'Channel', 'Channel ').replace(/\s+/g, ' ').trim() || null;
    const loggedAt = parseFormTimestamp(pick(row, 'Timestamp')) ?? `${occurredOn}T12:00:00`;

    staged.push({
      kind,
      occurredOn,
      description: description || '(no description)',
      counterparty,
      amount: amount ?? 0,
      category,
      channel,
      note,
      loggedAt,
      sourceRow: lineNo,
    });
  });

  return staged;
}

/** Exact duplicates are dropped; same-day/same-amount pairs are only flagged. */
function dedupe(entries: StagedEntry[]): StagedEntry[] {
  const seen = new Map<string, StagedEntry>();
  const kept: StagedEntry[] = [];

  for (const entry of entries) {
    const key = [
      entry.kind,
      entry.occurredOn,
      normaliseKey(entry.description),
      normaliseKey(entry.counterparty ?? ''),
      entry.amount.toFixed(2),
      entry.category,
    ].join('|');

    const existing = seen.get(key);
    if (existing) {
      notes.push(
        `Dropped duplicate: ${entry.occurredOn} "${entry.description}" ` +
          `${entry.counterparty ?? '—'} €${entry.amount.toFixed(2)} ` +
          `(rows ${existing.sourceRow} and ${entry.sourceRow} of the ${entry.kind} sheet)`,
      );
      continue;
    }
    seen.set(key, entry);
    kept.push(entry);
  }

  // Near-duplicates: same day, same amount, same counterparty, different wording.
  const byLoose = new Map<string, StagedEntry[]>();
  for (const entry of kept) {
    const key = [
      entry.kind,
      entry.occurredOn,
      normaliseKey(entry.counterparty ?? ''),
      entry.amount.toFixed(2),
    ].join('|');
    const list = byLoose.get(key);
    if (list) list.push(entry);
    else byLoose.set(key, [entry]);
  }
  for (const group of byLoose.values()) {
    if (group.length < 2) continue;
    if (group[0]!.amount === 0) continue;
    notes.push(
      `Possible duplicate (kept both): ${group[0]!.occurredOn} ` +
        `${group[0]!.counterparty ?? '—'} €${group[0]!.amount.toFixed(2)} — ` +
        group.map((e) => `"${e.description}"`).join(' vs '),
    );
  }

  return kept;
}

async function main() {
  const [expensesCsv, incomeCsv] = await Promise.all([
    readFile(join(root, 'data/raw/expenses.csv'), 'utf8').catch(() => {
      throw new Error('Missing data/raw/expenses.csv');
    }),
    readFile(join(root, 'data/raw/income.csv'), 'utf8').catch(() => {
      throw new Error('Missing data/raw/income.csv');
    }),
  ]);

  const staged = [
    ...stage(parseCsvRecords(expensesCsv), 'expense'),
    ...stage(parseCsvRecords(incomeCsv), 'income'),
  ];
  console.log(`staged ${staged.length} rows`);

  const { canonical, merges } = buildCanonicalNames(
    staged.map((e) => e.counterparty ?? '').filter(Boolean),
  );

  for (const entry of staged) {
    if (entry.counterparty) {
      entry.counterparty = canonicalNameFor(canonical, entry.counterparty);
    }
  }

  const entries = dedupe(staged);
  entries.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.sourceRow - b.sourceRow);

  // Report before touching the database, so --dry-run is genuinely useful.
  const uniqueMerges = [...new Map(merges.map((m) => [`${m.from}=>${m.to}`, m])).values()]
    .filter((m) => m.from !== m.to)
    .sort((a, b) => b.count - a.count);

  const report = [
    '# Import report',
    '',
    `Generated ${new Date().toISOString()}`,
    '',
    `- Rows staged: **${staged.length}**`,
    `- Rows imported: **${entries.length}**`,
    `- Exact duplicates dropped: **${staged.length - entries.length}**`,
    `- Payee spellings merged: **${uniqueMerges.length}**`,
    `- Rows flagged for review: **${problems.length}**`,
    '',
    '## Payee spellings merged',
    '',
    uniqueMerges.length
      ? uniqueMerges.map((m) => `- \`${m.from}\` → \`${m.to}\` (${m.count}×)`).join('\n')
      : '_none_',
    '',
    '## Duplicates and near-duplicates',
    '',
    notes.length ? notes.map((n) => `- ${n}`).join('\n') : '_none_',
    '',
    '## Flagged for review',
    '',
    problems.length ? problems.map((p) => `- ${p}`).join('\n') : '_none_',
    '',
  ].join('\n');

  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'data/import-report.md'), report);
  console.log('wrote data/import-report.md');

  if (dryRun) {
    console.log('dry run — nothing written to the database');
    await pool.end();
    return;
  }

  await withTransaction(async (client) => {
    // Counterparties.
    const names = [...new Set(entries.map((e) => e.counterparty).filter(Boolean))] as string[];
    for (const name of names) {
      await client.query(
        `insert into counterparties (name, normalized) values ($1, $2)
         on conflict (normalized) do update set name = excluded.name`,
        [name, normaliseKey(name)],
      );
    }

    const cpRows = await client.query<{ id: number; normalized: string }>(
      'select id, normalized from counterparties',
    );
    const cpByKey = new Map(cpRows.rows.map((r) => [r.normalized, r.id]));

    const catRows = await client.query<{ id: number; kind: string; name: string }>(
      'select id, kind, name from categories',
    );
    const catByKey = new Map(
      catRows.rows.map((r) => [`${r.kind}|${normaliseKey(r.name)}`, r.id]),
    );

    const chRows = await client.query<{ id: number; name: string }>(
      'select id, name from channels',
    );
    const chByKey = new Map(chRows.rows.map((r) => [normaliseKey(r.name), r.id]));

    let inserted = 0;
    for (const entry of entries) {
      const categoryId = catByKey.get(`${entry.kind}|${normaliseKey(entry.category)}`);
      if (!categoryId) {
        problems.push(
          `${entry.kind} row ${entry.sourceRow}: unknown category "${entry.category}" — skipped`,
        );
        continue;
      }

      const channelId = entry.channel ? chByKey.get(normaliseKey(entry.channel)) ?? null : null;
      if (entry.channel && !channelId) {
        problems.push(
          `${entry.kind} row ${entry.sourceRow}: unknown channel "${entry.channel}" — imported without one`,
        );
      }

      const counterpartyId = entry.counterparty
        ? cpByKey.get(normaliseKey(entry.counterparty)) ?? null
        : null;

      await client.query(
        `insert into entries
           (kind, occurred_on, description, counterparty_id, amount,
            category_id, channel_id, source, logged_at, note)
         values ($1, $2, $3, $4, $5, $6, $7, 'import', $8, $9)`,
        [
          entry.kind,
          entry.occurredOn,
          entry.description,
          counterpartyId,
          entry.amount,
          categoryId,
          channelId,
          entry.loggedAt,
          entry.note,
        ],
      );
      inserted += 1;
    }

    console.log(`inserted ${inserted} entries`);
  });

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
