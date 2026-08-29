/**
 * Prints what the Google Sheets mirror would write, without contacting Google.
 * Useful for checking the shape of the data before any credentials exist.
 *
 *   npm run preview-sheet
 */
import { entryRows, periodRows, loadSchedule } from '../src/routes/sheet-sync.ts';
import { pool } from '../src/db.ts';

const schedule = await loadSchedule();
const expenses = await entryRows('expense', schedule);
const income = await entryRows('income', schedule);
const periods = await periodRows(schedule);

function show(name: string, rows: unknown[][], limit: number) {
  console.log(`\n=== ${name} (${rows.length - 1} data rows) ===`);
  for (const [index, row] of rows.slice(0, limit).entries()) {
    const prefix = index === 0 ? '  header  ' : '          ';
    console.log(prefix + row.map((cell) => String(cell ?? '').slice(0, 22)).join(' | '));
  }
}

show('Expenses', expenses, 4);
show('Income', income, 3);
show('Periods', periods, 6);

await pool.end();
