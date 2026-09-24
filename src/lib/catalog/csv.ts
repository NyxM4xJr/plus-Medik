export interface CsvRecord {
  /** Línea del archivo donde empieza el registro (1 = encabezado). */
  line: number;
  fields: string[];
}

export interface CsvParseResult {
  records: CsvRecord[];
  error: { line: number; message: string } | null;
}

/**
 * Parser CSV mínimo (RFC 4180): comillas dobles, comillas escapadas (""),
 * saltos de línea dentro de comillas, CRLF/LF y BOM inicial.
 * Una comilla solo abre un campo si es su primer carácter.
 */
export function parseCsv(text: string, delimiter = ','): CsvParseResult {
  const source = text.startsWith('﻿') ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;

  while (i < source.length) {
    const char = source[i];

    if (inQuotes) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      if (char === '\n') line += 1;
      field += char;
      i += 1;
      continue;
    }

    if (char === '"' && field === '') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (char === delimiter) {
      fields.push(field);
      field = '';
      i += 1;
      continue;
    }

    if (char === '\r' || char === '\n') {
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      i += char === '\r' && source[i + 1] === '\n' ? 2 : 1;
      line += 1;
      recordLine = line;
      continue;
    }

    field += char;
    i += 1;
  }

  if (inQuotes) {
    return { records, error: { line: recordLine, message: 'Comilla sin cerrar.' } };
  }

  if (field !== '' || fields.length > 0) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }

  return { records, error: null };
}
