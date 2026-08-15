export type Kind = 'expense' | 'income';

export interface Category {
  id: number;
  kind: Kind;
  name: string;
  bucket: 'fixed' | 'variable' | null;
  sortOrder: number;
}

export interface Channel {
  id: number;
  name: string;
  kinds: Kind[];
  sortOrder: number;
}

export interface Reference {
  categories: Category[];
  channels: Channel[];
  currency: string;
  locale: string;
}

export interface Template {
  description: string;
  counterparty_id: number | null;
  counterparty: string | null;
  category_id: number;
  category: string;
  channel_id: number | null;
  channel: string | null;
  uses: number;
  last_used: string;
  last_amount: number;
  median_amount: number;
  min_amount: number;
  max_amount: number;
  amount_varies: boolean;
  score: number;
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
  channelId: number | null;
  channel: string | null;
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
  id: number;
  name: string;
  budget: number;
  actual: number;
  sort_order: number;
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
  channelId: number | null;
  channel: string | null;
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
  channelId: number | null;
  channel: string | null;
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
  channelId: number | null;
  cadence: RecurringRule['cadence'];
  anchorDate: string;
  amount: number | null;
  amountVaries: boolean;
  occurrences: number;
  medianGapDays: number;
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
  quick: (kind: Kind, limit = 8) =>
    request<{ quick: Template[] }>(`/api/suggest/quick?kind=${kind}&limit=${limit}`),
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
    request<{ entry: Entry }>('/api/entries', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
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

  months: () => request<{ months: string[] }>('/api/months'),
  paySchedule: () =>
    request<{
      rules: { effectiveFrom: string; dayRule: 'last' | number; note: string | null }[];
      current: Period;
    }>('/api/pay-schedule'),
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
