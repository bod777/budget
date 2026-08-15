/**
 * The monthly budget workbooks in Drive, as listed from the folder
 * https://drive.google.com/drive/folders/<drive-folder-id>
 *
 * Held as a list rather than discovered at run time so the backfill needs only
 * the Sheets API, and so re-running it reads exactly the same set. Add a row if
 * an older workbook turns up.
 */
export interface BudgetWorkbook {
  id: string;
  title: string;
}

export const BUDGET_WORKBOOKS: BudgetWorkbook[] = [
  { id: '<spreadsheet-id>', title: '2023 Budget - 10 October' },
  { id: '<spreadsheet-id>', title: '2023 Budget - 11 November' },
  { id: '<spreadsheet-id>', title: '2023 Budget - 12 December' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 1 January' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 2 February' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 3 March' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 4 April' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 5 May' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 6 June' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 7 July' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 8 August' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 9 September' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 10 October' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 11 November' },
  { id: '<spreadsheet-id>', title: '2024 Budget - 12 December' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 1 January' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 2 February' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 3 March' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 4 April' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 5 May' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 6 June' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 7 July' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 8 August' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 9 September' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 10 October' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 11 November' },
  { id: '<spreadsheet-id>', title: '2025 Budget - 12 December' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 1 January' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 2 February' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 3 March' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 4 April' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 5 May' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 6 June' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 7 July' },
  { id: '<spreadsheet-id>', title: '2026 Budget - 8 August' },
];
