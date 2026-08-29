export type Kind = 'expense' | 'income' | 'transfer';
/** Kinds that carry a category and a counterparty. */
export type SpendKind = 'expense' | 'income';

export interface Category {
  id: number;
  kind: SpendKind;
  name: string;
  bucket: 'fixed' | 'variable' | null;
  sortOrder: number;
}

export interface Account {
  id: number;
  name: string;
  kind: 'current' | 'credit' | 'cash' | 'savings' | 'other';
  usableFor: SpendKind[];
  sortOrder: number;
}

export interface AccountBalance extends Account {
  openingBalance: number | null;
  openingOn: string | null;
  archived: boolean;
  movement: number;
  movementCount: number;
  /** Null when no opening balance has been set. */
  balance: number | null;
  /** For credit cards: the balance expressed as what is owed. */
  owed: number | null;
  needsOpeningBalance: boolean;
}

export interface Reference {
  categories: Category[];
  accounts: Account[];
  currency: string;
  locale: string;
}

export interface Template {
  description: string;
  counterparty_id: number | null;
  counterparty: string | null;
  category_id: number;
  category: string;
  account_id: number | null;
  account: string | null;
  uses: number;
  last_used: string;
  last_amount: number;
  median_amount: number;
  min_amount: number;
  max_amount: number;
  amount_varies: boolean;
  score: number;
}

export interface QuickPickOption extends Template {
  key: string;
  pinned: boolean;
  hidden: boolean;
  /** Whether it would appear with no choice recorded. */
  automatic: boolean;
}

export interface PeriodStat {
  month: string;
  start: string;
  end: string;
  expenses: number;
  income: number;
  savings: number;
  net: number;
  /** The period still in progress, so its totals are incomplete. */
  partial: boolean;
}

export interface CategoryStat {
  name: string;
  bucket: 'fixed' | 'variable' | null;
  amount: number;
  previous: number;
}

export interface Entry {
  id: number;
  kind: Kind;
  occurredOn: string;
  description: string;
  counterpartyId: number | null;
  counterparty: string | null;
  amount: number;
  categoryId: number;
  category: string;
  bucket: 'fixed' | 'variable' | null;
  accountId: number | null;
  account: string | null;
  toAccountId: number | null;
  toAccount: string | null;
  note: string | null;
  source: 'manual' | 'import' | 'recurring';
  loggedAt: string;
}

export interface BudgetLine {
  categoryId: number;
  kind: Kind;
  name: string;
  bucket: 'fixed' | 'variable' | null;
  budget: number;
  actual: number;
  difference: number;
  note: string | null;
}

export interface SavingsLine {
  accountId: number;
  name: string;
  budget: number;
  actual: number;
}

export interface PaydayPreview {
  month: string;
  nextMonth: string;
  scheduled: string;
  /** True when pay landed exactly where the schedule expected. */
  alreadyScheduled: boolean;
  closes: Period;
  opens: Period;
}

export interface PayRuleRow {
  id: number;
  /** YYYY-MM, the first month this rule applies to. */
  effectiveFrom: string;
  dayRule: 'last' | number;
  note: string | null;
}

/** A month where pay landed somewhere other than the schedule says. */
export interface PayOverrideRow {
  /** YYYY-MM. */
  month: string;
  /** YYYY-MM-DD, the day pay actually arrived. */
  paidOn: string;
  note: string | null;
}

export interface PreviewPeriod {
  month: string;
  start: string;
  end: string;
  isCurrent: boolean;
  startOverridden: boolean;
  endOverridden: boolean;
}

export interface Period {
  month: string;
  /** Inclusive. */
  start: string;
  /** Exclusive. */
  end: string;
}

export interface MonthView {
  month: string;
  exists: boolean;
  /** The period these budget figures were carried from, if not set here yet. */
  inheritedFrom: string | null;
  /** Inclusive start of the payday-to-payday period. */
  periodStart: string;
  /** Exclusive end. */
  periodEnd: string;
  openingSurplus: number;
  note: string | null;
  lines: BudgetLine[];
  savings: SavingsLine[];
  totals: {
    expenseBudget: number;
    expenseActual: number;
    expenseDifference: number;
    incomeBudget: number;
    incomeActual: number;
    incomeDifference: number;
    savingsBudget: number;
    savingsActual: number;
    incomeSurplusBudget: number;
    incomeSurplusActual: number;
    thisMonthBudget: number;
    thisMonthActual: number;
    closingBudget: number;
    closingActual: number;
  };
}

export interface PendingEntry {
  id: number;
  dueOn: string;
  kind: Kind;
  description: string;
  counterpartyId: number | null;
  counterparty: string | null;
  amount: number | null;
  categoryId: number;
  category: string;
  accountId: number | null;
  account: string | null;
  ruleId: number;
}

export interface RecurringRule {
  id: number;
  kind: Kind;
  description: string;
  counterpartyId: number | null;
  counterparty: string | null;
  amount: number | null;
  categoryId: number;
  category: string;
  accountId: number | null;
  account: string | null;
  cadence: 'weekly' | 'fortnightly' | 'monthly' | 'yearly';
  anchorDate: string;
  active: boolean;
  lastGeneratedOn: string | null;
}

export interface RecurringSuggestion {
  kind: Kind;
  description: string;
  counterpartyId: number | null;
  counterparty: string | null;
  categoryId: number;
  category: string;
  accountId: number | null;
  cadence: RecurringRule['cadence'];
  anchorDate: string;
  amount: number | null;
  amountVaries: boolean;
  occurrences: number;
  medianGapDays: number;
}

export interface SheetSyncStatus {
  configured: boolean;
  spreadsheetId: string | null;
  serviceAccountEmail: string | null;
  lastRun: { at: string; status: 'never' | 'ok' | 'failed'; detail: string | null } | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: unknown,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message =
      (body && typeof body === 'object' && 'error' in body && String(body.error)) ||
      `Request failed (${response.status})`;
    throw new ApiError(response.status, message, body);
  }
  return body as T;
}

export const api = {
  session: () =>
    request<{
      authenticated: boolean;
      authDisabled: boolean;
      methods: { password: boolean; google: boolean };
    }>('/api/session'),
  logIn: (password: string) =>
    request<{ authenticated: boolean }>('/api/session', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  logOut: () => request<unknown>('/api/session', { method: 'DELETE' }),

  reference: () => request<Reference>('/api/reference'),

  suggest: (kind: Kind, q: string, limit = 8) =>
    request<{ templates: Template[] }>(
      `/api/suggest?kind=${kind}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),
  quick: (kind: SpendKind, limit = 8) =>
    request<{ quick: Template[] }>(`/api/suggest/quick?kind=${kind}&limit=${limit}`),
  quickOptions: (kind: SpendKind) =>
    request<{ options: QuickPickOption[] }>(`/api/suggest/quick/options?kind=${kind}`),
  setQuickPick: (payload: { key: string; kind: SpendKind; pinned: boolean; hidden: boolean }) =>
    request<{ key: string }>('/api/suggest/quick', {
      method: 'PUT',
      body: JSON.stringify(payload),
    }),
  counterparties: (kind: Kind, q: string, limit = 8) =>
    request<{ counterparties: { id: number; name: string; uses: number }[] }>(
      `/api/suggest/counterparties?kind=${kind}&q=${encodeURIComponent(q)}&limit=${limit}`,
    ),

  entries: (params: Record<string, string | number | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return request<{ entries: Entry[] }>(`/api/entries?${search}`);
  },
  createEntry: (payload: Record<string, unknown>) =>
    request<{ entry: Entry; payday?: { month: string; closes: string; opens: string } | null }>(
      '/api/entries',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      },
    ),
  checkDuplicate: (payload: Record<string, unknown>) =>
    request<{ duplicates: Entry[] }>('/api/entries/check', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updateEntry: (id: number, payload: Record<string, unknown>) =>
    request<{ entry: Entry }>(`/api/entries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deleteEntry: (id: number) =>
    request<{ deleted: number }>(`/api/entries/${id}`, { method: 'DELETE' }),

  statsPeriods: (limit = 12) =>
    request<{ periods: PeriodStat[] }>(`/api/stats/periods?limit=${limit}`),
  statsCategories: (month?: string) =>
    request<{ month: string; categories: CategoryStat[] }>(
      `/api/stats/categories${month ? `?month=${month}` : ''}`,
    ),

  accounts: () =>
    request<{ accounts: AccountBalance[]; savingsTotal: number | null }>('/api/accounts'),
  updateAccount: (
    id: number,
    payload: { openingBalance?: number | null; openingOn?: string | null; kind?: string; name?: string },
  ) =>
    request<{ updated: number }>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  months: () => request<{ months: string[] }>('/api/months'),
  paySchedule: () =>
    request<{
      rules: PayRuleRow[];
      overrides: PayOverrideRow[];
      current: Period | null;
      preview: PreviewPeriod[];
    }>('/api/pay-schedule'),
  createPayRule: (payload: { effectiveFrom: string; dayRule: 'last' | number; note: string | null }) =>
    request<{ id: number }>('/api/pay-schedule', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  updatePayRule: (
    id: number,
    payload: { effectiveFrom: string; dayRule: 'last' | number; note: string | null },
  ) =>
    request<{ updated: number }>(`/api/pay-schedule/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),
  deletePayRule: (id: number) =>
    request<{ deleted: number }>(`/api/pay-schedule/${id}`, { method: 'DELETE' }),
  setPayOverride: (month: string, payload: { paidOn: string; note: string | null }) =>
    request<{ month: string; paidOn: string; period: Period; next: Period }>(
      `/api/pay-schedule/overrides/${month}`,
      { method: 'PUT', body: JSON.stringify(payload) },
    ),
  clearPayOverride: (month: string) =>
    request<{ deleted: string }>(`/api/pay-schedule/overrides/${month}`, { method: 'DELETE' }),
  paydayPreview: (date: string) =>
    request<PaydayPreview>(`/api/pay-schedule/payday-preview?date=${date}`),

  sheetSyncStatus: () => request<SheetSyncStatus>('/api/sheet-sync'),
  runSheetSync: () =>
    request<{ ok: true; expenses: number; income: number; transfers: number; periods: number }>(
      '/api/sheet-sync/run',
      { method: 'POST', body: '{}' },
    ),
  rederivePeriods: (from?: string) =>
    request<{ rederived: number }>('/api/pay-schedule/rederive', {
      method: 'POST',
      body: JSON.stringify(from ? { from } : {}),
    }),
  month: (month: string) => request<MonthView>(`/api/months/${month}`),
  initMonth: (month: string) =>
    request<unknown>(`/api/months/${month}/init`, { method: 'POST', body: JSON.stringify({}) }),
  saveMonth: (month: string, payload: Record<string, unknown>) =>
    request<unknown>(`/api/months/${month}`, { method: 'PUT', body: JSON.stringify(payload) }),

  pending: () => request<{ pending: PendingEntry[] }>('/api/pending'),
  confirmPending: (id: number, payload: { amount?: number; occurredOn?: string }) =>
    request<{ entryId: number }>(`/api/pending/${id}/confirm`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
  skipPending: (id: number) =>
    request<unknown>(`/api/pending/${id}/skip`, { method: 'POST' }),

  recurring: () => request<{ rules: RecurringRule[] }>('/api/recurring'),
  recurringSuggestions: () =>
    request<{ suggestions: RecurringSuggestion[] }>('/api/recurring/suggestions'),
  createRecurring: (payload: Record<string, unknown>) =>
    request<{ id: number }>('/api/recurring', { method: 'POST', body: JSON.stringify(payload) }),
  updateRecurring: (id: number, payload: Record<string, unknown>) =>
    request<unknown>(`/api/recurring/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  deleteRecurring: (id: number) =>
    request<unknown>(`/api/recurring/${id}`, { method: 'DELETE' }),
};

export function formatMoney(value: number, currency = 'EUR', locale = 'en-IE'): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(value);
}

export function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`;
}

export function shiftIso(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00`);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function formatDayLabel(iso: string): string {
  const today = todayIso();
  if (iso === today) return 'Today';
  if (iso === shiftIso(today, -1)) return 'Yesterday';
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-IE', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}
