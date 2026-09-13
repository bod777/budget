/**
 * Optional personal configuration for the one-off import and backfill scripts.
 *
 * These files describe one person's history -- friends' names in the payee
 * aliases, the ids of their Drive workbooks -- so they live in data/, which is
 * gitignored along with the raw exports they sit beside. The scripts run
 * without them, just with less to go on.
 */
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');

/** Reads data/<name>, returning null when the file does not exist. */
export async function readPrivateJson<T>(name: string): Promise<T | null> {
  const path = join(dataDir, name);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`data/${name} is not valid JSON: ${(error as Error).message}`);
  }
}

/**
 * data/counterparty-aliases.json: extra spelling variants to merge on import,
 * as { "normalised variant": "Canonical Name" }. Merged over the built-in table.
 */
export async function loadCounterpartyAliases(): Promise<Record<string, string>> {
  return (await readPrivateJson<Record<string, string>>('counterparty-aliases.json')) ?? {};
}

export interface BudgetWorkbook {
  id: string;
  title: string;
}

/**
 * data/budget-workbooks.json: the monthly budget workbooks to backfill from.
 *
 * Held as a list rather than discovered at run time so the backfill needs only
 * the Sheets API, and so re-running it reads exactly the same set.
 */
export interface BudgetWorkbookConfig {
  workbooks: BudgetWorkbook[];
  /** Savings labels as written in the sheets (normalised) -> account names. */
  savingsAccounts: Record<string, string>;
}

export async function loadBudgetWorkbooks(): Promise<BudgetWorkbookConfig | null> {
  const config = await readPrivateJson<Partial<BudgetWorkbookConfig>>('budget-workbooks.json');
  if (!config) return null;
  return { workbooks: config.workbooks ?? [], savingsAccounts: config.savingsAccounts ?? {} };
}
