/**
 * Reads one monthly budget workbook's "Monthly Budget" tab.
 *
 * The layout has been stable across three years of copies:
 *
 *   row 3   B starting date   C ending date   D previous surplus
 *   rows 8+ B expense item    D budget        F actual
 *   rows 7+ J income item     K budget        L actual
 *   savings J label ("Savings Savings")  K budget   L actual
 *
 * Only the budgeted figures are taken. Actuals are recomputed from the entries
 * already imported, so a stale total in an old sheet cannot contradict them.
 */
import { parseCsv } from './csv.ts';
import { parseAmount } from './normalise.ts';

export interface ParsedBudget {
  /** YYYY-MM, from the workbook title. */
  month: string;
  openingSurplus: number | null;
  startingDate: string | null;
  endingDate: string | null;
  expenses: Record<string, number>;
  income: Record<string, number>;
  savings: Record<string, number>;
  /** Labels seen that matched nothing, for the report. */
  unknown: string[];
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** "2026 Budget - 6 June" -> "2026-06". */
export function monthFromTitle(title: string): string | null {
  const year = title.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  const named = MONTHS.findIndex((name) => new RegExp(`\\b${name}\\b`, 'i').test(title));
  if (named >= 0) return `${year}-${String(named + 1).padStart(2, '0')}`;
  // Fall back to the numeric part of "Budget - 6 June".
  const numeric = title.match(/-\s*(\d{1,2})\b/)?.[1];
  if (!numeric) return null;
  const value = Number(numeric);
  if (value < 1 || value > 12) return null;
  return `${year}-${String(value).padStart(2, '0')}`;
}

/** "28-5-2026" -> "2026-05-28". */
function parseSheetDate(raw: string): string | null {
  const match = raw.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (!match) return null;
  const [, d, m, y] = match;
  return `${y}-${String(Number(m)).padStart(2, '0')}-${String(Number(d)).padStart(2, '0')}`;
}

/** Rows that are headings or totals rather than budget lines. */
const NOT_A_LINE = new Set([
  '', 'items', 'fixed', 'variable', 'total', 'expenses', 'income', 'savings',
  'item', 'notes', 'budget', 'actual', 'difference', 'balance',
  'income surplus', 'remaining for other funds', 'budgeted surplus',
]);

export function parseBudgetSheet(title: string, csv: string): ParsedBudget | null {
  const month = monthFromTitle(title);
  if (!month) return null;

  const rows = parseCsv(csv);
  const cell = (row: number, col: number): string => (rows[row]?.[col] ?? '').trim();

  const result: ParsedBudget = {
    month,
    openingSurplus: null,
    startingDate: null,
    endingDate: null,
    expenses: {},
    income: {},
    savings: {},
    unknown: [],
  };

  // Find the row carrying the dates rather than assuming it is row 3.
  for (let row = 0; row < Math.min(rows.length, 8); row++) {
    const start = parseSheetDate(cell(row, 1));
    if (!start) continue;
    result.startingDate = start;
    result.endingDate = parseSheetDate(cell(row, 2));
    result.openingSurplus = parseAmount(cell(row, 3));
    break;
  }

  let seenSavingsHeading = false;

  for (let row = 0; row < rows.length; row++) {
    const expenseLabel = cell(row, 1);
    const key = expenseLabel.toLowerCase();
    // The header block puts the period's start date in this column, which
    // would otherwise read as a category called "28-5-2026".
    if (expenseLabel && !NOT_A_LINE.has(key) && !parseSheetDate(expenseLabel)) {
      const budget = parseAmount(cell(row, 3));
      if (budget !== null) result.expenses[expenseLabel] = budget;
    }

    const rightLabel = cell(row, 8) || cell(row, 9);
    if (/^savings$/i.test(cell(row, 8)) || /^savings$/i.test(cell(row, 9))) {
      seenSavingsHeading = true;
      continue;
    }
    if (!rightLabel) continue;

    const rightKey = rightLabel.toLowerCase();
    if (NOT_A_LINE.has(rightKey)) continue;

    // The right-hand column carries income above the SAVINGS heading and
    // savings targets below it.
    const budget = parseAmount(cell(row, 10)) ?? parseAmount(cell(row, 9));
    if (budget === null) continue;

    if (seenSavingsHeading) result.savings[rightLabel] = budget;
    else result.income[rightLabel] = budget;
  }

  return result;
}
