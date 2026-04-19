/**
 * Output formatting with structured defaults and text-only opt-in formats.
 */

import yaml from 'js-yaml';

export interface RenderOptions {
  fmt?: string;
  columns?: string[];
}

function normalizeRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return [data as Record<string, unknown>];
  return [{ value: data }];
}

function resolveColumns(rows: Record<string, unknown>[], opts: RenderOptions): string[] {
  return opts.columns ?? Object.keys(rows[0] ?? {});
}

export function render(data: unknown, opts: RenderOptions = {}): void {
  const fmt = opts.fmt ?? 'yaml';
  if (data === null || data === undefined) {
    console.log(data);
    return;
  }
  switch (fmt) {
    case 'json': renderJson(data); break;
    case 'plain': renderPlain(data); break;
    case 'md':
    case 'markdown': renderMarkdown(data, opts); break;
    case 'csv': renderCsv(data, opts); break;
    case 'yaml':
    case 'yml':
    case 'table':
    default:
      renderYaml(data);
      break;
  }
}

function renderJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function renderPlain(data: unknown): void {
  const rows = normalizeRows(data);
  if (!rows.length) return;

  if (rows.length === 1) {
    const row = rows[0];
    const entries = Object.entries(row);
    if (entries.length === 1) {
      const [key, value] = entries[0];
      if (key === 'response' || key === 'content' || key === 'text' || key === 'value') {
        console.log(String(value ?? ''));
        return;
      }
    }
  }

  rows.forEach((row, index) => {
    Object.entries(row)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .forEach(([key, value]) => {
        console.log(`${key}: ${value}`);
      });
    if (index < rows.length - 1) console.log('');
  });
}

function renderMarkdown(data: unknown, opts: RenderOptions): void {
  const rows = normalizeRows(data);
  if (!rows.length) return;
  const columns = resolveColumns(rows, opts);
  console.log(`| ${columns.join(' | ')} |`);
  console.log(`| ${columns.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    console.log(`| ${columns.map((column) => String(row[column] ?? '')).join(' | ')} |`);
  }
}

function renderCsv(data: unknown, opts: RenderOptions): void {
  const rows = normalizeRows(data);
  if (!rows.length) return;
  const columns = resolveColumns(rows, opts);
  console.log(columns.join(','));
  for (const row of rows) {
    console.log(columns.map((column) => {
      const value = String(row[column] ?? '');
      return value.includes(',') || value.includes('"') || value.includes('\n') || value.includes('\r')
        ? `"${value.replace(/"/g, '""')}"`
        : value;
    }).join(','));
  }
}

function renderYaml(data: unknown): void {
  console.log(yaml.dump(data, { sortKeys: false, lineWidth: 120, noRefs: true }));
}
