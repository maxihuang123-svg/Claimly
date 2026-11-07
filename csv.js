// RFC 4180 parser: handles quoted fields, escaped quotes and CRLF line endings.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  return body.map((cells, index) => {
    if (cells.length !== header.length) {
      throw new Error(`Row ${index + 1} has ${cells.length} values, but the header has ${header.length}.`);
    }
    return Object.fromEntries(header.map((name, i) => [name.trim(), cells[i]]));
  });
}
