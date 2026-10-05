import fs from 'node:fs';
import path from 'node:path';

/**
 * Patch the CSV parser so a leading blank line or a broker title row does not
 * consume the header.
 *
 * Done as a script because the previous edit attempts kept losing the `path`
 * argument, and this keeps the change auditable in one place.
 *
 *   node scripts/patch-csv-header.mjs
 */

const target = path.join(process.cwd(), 'packages/loads/src/normalize.ts');
let text = fs.readFileSync(target, 'utf8');

const before = `  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows[0];
  if (!header) return [];

  const headers = header.map((cell) => normalizeHeader(cell));
  const out: Record<string, string>[] = [];

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells || cells.every((cell) => cell.trim() === '')) continue;
    const record: Record<string, string> = {};
    headers.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    out.push(record);
  }

  return out;
}`;

const after = `  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const isBlank = (cells: string[]): boolean => cells.every((cell) => cell.trim() === '');

  // The header is the first row with any content. Broker exports routinely
  // start with a report title or a blank line, and treating one of those as the
  // header silently maps every real column onto the wrong field.
  const headerIndex = rows.findIndex((cells) => !isBlank(cells));
  if (headerIndex < 0) return [];

  const headers = rows[headerIndex].map((cell) => normalizeHeader(cell));
  const out: Record<string, string>[] = [];

  for (let i = headerIndex + 1; i < rows.length; i += 1) {
    const cells = rows[i];
    if (!cells || isBlank(cells)) continue;
    const record: Record<string, string> = {};
    headers.forEach((key, index) => {
      record[key] = (cells[index] ?? '').trim();
    });
    // 1-based including the header, so the number matches the spreadsheet.
    record.__row = String(i + 1);
    out.push(record);
  }

  return out;
}`;

if (!text.includes(before)) {
  console.log('pattern not found; parseCsv may already be patched');
  process.exit(1);
}

text = text.replace(before, after);

// Strip a BOM from the input, which is common in broker exports from Excel.
text = text.replace(
  "  const normalized = text.replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');",
  "  // Excel exports frequently carry a UTF-8 BOM; it must not become part of the\n  // first header cell.\n  const normalized = text.replace(/^\\uFEFF/, '').replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');",
);

// importCsv should use the row number the parser recorded.
text = text.replace(
  "      failures.push({ row: index + 2, reason: reasons.join('; '), rejected: normalized.rejected });",
  "      const rowNumber = Number.parseInt(row['__row'] ?? String(index + 2), 10);\n      failures.push({ row: rowNumber, reason: reasons.join('; '), rejected: normalized.rejected });",
);
text = text.replace(
  "    drafts.push({ row: index + 2, draft: normalized.draft });",
  "    const rowNumber = Number.parseInt(row['__row'] ?? String(index + 2), 10);\n    drafts.push({ row: rowNumber, draft: normalized.draft });",
);

fs.writeFileSync(target, text, 'utf8');
console.log('parseCsv patched: header detection, BOM handling, row numbers');