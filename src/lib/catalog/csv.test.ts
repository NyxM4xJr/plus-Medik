import { describe, expect, it } from 'vitest';
import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('separa registros por LF y CRLF', () => {
    expect(parseCsv('a,b\r\nc,d\ne,f').records).toEqual([
      { line: 1, fields: ['a', 'b'] },
      { line: 2, fields: ['c', 'd'] },
      { line: 3, fields: ['e', 'f'] },
    ]);
  });

  it('ignora el salto de línea final y el BOM', () => {
    expect(parseCsv('﻿a,b\n').records).toEqual([{ line: 1, fields: ['a', 'b'] }]);
  });

  it('respeta comas, comillas escapadas y saltos de línea entre comillas', () => {
    const { records } = parseCsv('x,"uno, dos","di ""hola""","línea 1\nlínea 2"\ny,z,,');

    expect(records[0].fields).toEqual(['x', 'uno, dos', 'di "hola"', 'línea 1\nlínea 2']);
    expect(records[1]).toEqual({ line: 3, fields: ['y', 'z', '', ''] });
  });

  it('una comilla en medio de un campo es literal', () => {
    expect(parseCsv('5" x 3",b').records[0].fields).toEqual(['5" x 3"', 'b']);
  });

  it('conserva los campos vacíos', () => {
    expect(parseCsv(',,').records[0].fields).toEqual(['', '', '']);
  });

  it('informa una comilla sin cerrar con su línea', () => {
    expect(parseCsv('a,b\nc,"sin cerrar\n').error).toEqual({ line: 2, message: 'Comilla sin cerrar.' });
  });

  it('un texto vacío no produce registros', () => {
    expect(parseCsv('')).toEqual({ records: [], error: null });
  });
});
