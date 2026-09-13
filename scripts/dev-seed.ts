/**
 * Writes synthetic response CSVs into data/raw for local development.
 *
 * Modelled on the real spending patterns (weekly gym and shop, monthly rent
 * and prescription, a handful of subscriptions, irregular eating out) so that
 * autocomplete ranking and recurring detection can be exercised properly
 * before touching real data.
 *
 *   npm run dev-seed
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const MONTHS_BACK = 14;
const today = new Date();

function fmt(date: Date): string {
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`;
}
function stamp(date: Date): string {
  return `${fmt(date)} ${String(8 + (date.getDate() % 10)).padStart(2, '0')}:${String(date.getDate() % 60).padStart(2, '0')}:00`;
}
function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

// Deterministic PRNG so repeated seeds are comparable.
let seed = 42;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
function jitter(base: number, pct: number): string {
  return (base * (1 + (rnd() - 0.5) * 2 * pct)).toFixed(2);
}

const expenses: string[][] = [];
const income: string[][] = [];

const start = new Date(today);
start.setMonth(start.getMonth() - MONTHS_BACK);
start.setDate(1);

// Weekly: gym every Saturday, shop every Friday.
for (let d = new Date(start); d <= today; d = addDays(d, 1)) {
  if (d.getDay() === 6) {
    expenses.push([stamp(d), fmt(d), 'Weekly Gym Payment', 'The Gym', '49.00', 'Health', 'BOI Credit Card']);
  }
  if (d.getDay() === 5) {
    const shop = rnd() < 0.7 ? 'Aldi' : 'Tesco';
    expenses.push([stamp(d), fmt(d), 'Weekly Shop', shop, jitter(30, 0.4), 'Groceries', 'BOI Credit Card']);
  }
}

// Monthly fixtures.
for (let m = 0; m <= MONTHS_BACK; m++) {
  const month = new Date(start);
  month.setMonth(start.getMonth() + m);
  if (month > today) break;

  const on = (day: number) => {
    const date = new Date(month.getFullYear(), month.getMonth(), day);
    return date > today ? null : date;
  };

  const rent = on(2);
  if (rent) expenses.push([stamp(rent), fmt(rent), 'Monthly Rent', 'Landlord', '900.00', 'Rent', 'BOI Current Account']);

  const phone = on(23);
  if (phone) expenses.push([stamp(phone), fmt(phone), 'Phone Expenses', '48 Mobile', '7.99', 'Phone', 'BOI Current Account']);

  const youtube = on(24);
  if (youtube) expenses.push([stamp(youtube), fmt(youtube), 'YouTube Premium Subscription', 'Google', '13.99', 'Subscriptions', 'BOI Current Account']);

  const dropout = on(22);
  if (dropout) expenses.push([stamp(dropout), fmt(dropout), 'Dropout Membership', 'YouTube', '4.99', 'Subscriptions', 'BOI Current Account']);

  const script = on(7);
  if (script) expenses.push([stamp(script), fmt(script), 'Monthly Prescription', 'Pharmacy', jitter(45, 0.12), 'Health', 'BOI Credit Card']);

  const bank = on(28);
  if (bank) expenses.push([stamp(bank), fmt(bank), 'Banking Fee', 'BOI', '6.00', 'Banking Fees', 'BOI Current Account']);

  const claude = on(9);
  if (claude) expenses.push([stamp(claude), fmt(claude), 'Claude AI Pro', m % 4 === 0 ? 'Antrophic' : 'Anthropic', '22.14', 'Subscriptions', 'Revolut']);

  const insurance = on(5);
  if (insurance) expenses.push([stamp(insurance), fmt(insurance), 'Health Insurance', 'Acme Insurance', '95.00', 'Insurance', 'BOI Current Account']);

  const salary = on(28);
  if (salary) income.push([stamp(salary), fmt(salary), 'Salary for the month', jitter(3000, 0.02), 'Salary', 'BOI Current Account', 'Employer']);

  // Irregular spending.
  const eatingOut = ['Dinner out', 'Lunch at work', 'Chai Latte', 'Popcorn and Drink', 'Bubba Tea'];
  const payees = ['IMC', 'Costa', 'Tesco', 'Yeeros', 'Nanas Tea'];
  for (let i = 0; i < 5 + Math.floor(rnd() * 5); i++) {
    const day = on(1 + Math.floor(rnd() * 27));
    if (!day) continue;
    const idx = Math.floor(rnd() * eatingOut.length);
    expenses.push([
      stamp(day), fmt(day), eatingOut[idx]!, payees[Math.floor(rnd() * payees.length)]!,
      jitter(14, 0.7), 'Eating Out', rnd() < 0.5 ? 'BOI Credit Card' : 'Revolut',
    ]);
  }

  const leap = on(12);
  if (leap) expenses.push([stamp(leap), fmt(leap), 'Leap Card', 'Irish Rail', '20.00', 'Transportation', 'BOI Credit Card']);

  const petrol = on(17);
  if (petrol) expenses.push([stamp(petrol), fmt(petrol), 'Petrol', 'Maxol', jitter(50, 0.25), 'Transportation', 'BOI Credit Card']);

  if (rnd() < 0.5) {
    const payback = on(1 + Math.floor(rnd() * 27));
    if (payback) income.push([stamp(payback), fmt(payback), 'Payback for dinner', jitter(25, 0.6), 'Payback', 'Revolut', 'Mary Egan']);
  }
}

// A yearly subscription, to check the long-window suggestion path.
for (let y = 1; y <= 2; y++) {
  const date = new Date(today.getFullYear() - y + 1, 7, 3);
  if (date <= today) {
    expenses.push([stamp(date), fmt(date), 'Claude Annual Subscription', 'Anthropic', '217.17', 'Yearly Subscriptions', 'Revolut']);
  }
}

function toCsv(header: string[], rows: string[][]): string {
  const escape = (cell: string) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  return [header, ...rows].map((row) => row.map(escape).join(',')).join('\n') + '\n';
}

await mkdir(join(root, 'data/raw'), { recursive: true });
await writeFile(
  join(root, 'data/raw/expenses.csv'),
  toCsv(['Timestamp', 'Date', 'Description', 'Payee', 'Amount', 'Category', 'Channel '], expenses),
);
await writeFile(
  join(root, 'data/raw/income.csv'),
  toCsv(['Timestamp', 'Date', 'Description ', 'Amount', 'Category', 'Channel', 'Payer'], income),
);

console.log(`wrote ${expenses.length} expense and ${income.length} income rows to data/raw/`);
console.log('NOTE: synthetic development data — overwrite with the real export before importing for real.');
