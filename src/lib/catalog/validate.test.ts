import { describe, expect, it } from 'vitest';
import { withTariffs } from '@/test/catalog-fixtures';
import {
  CATALOG_COLUMNS,
  proposeCatalogCode,
  validateCatalogCsv,
  type CatalogValidationReport,
  type IssueKind,
  type TariffColumn,
} from './validate';

const HEADER = CATALOG_COLUMNS.join(',');

function csv(...rows: string[]): string {
  return [HEADER, ...rows.map(withTariffs)].join('\n');
}

function kinds(report: CatalogValidationReport, line: number): IssueKind[] {
  return report.rows.find((row) => row.line === line)?.issues.map((issue) => issue.kind) ?? [];
}

function row(report: CatalogValidationReport, line: number) {
  const found = report.rows.find((r) => r.line === line);
  if (!found) throw new Error(`sin fila en la línea ${line}`);
  return found;
}

describe('validateCatalogCsv: archivo válido', () => {
  it('acepta un CSV válido y permite la carga automática', () => {
    const report = validateCatalogCsv(
      csv(
        'HEM01,Hemograma completo,Hematología,Sangre,45,true,',
        'GLU01,Glucosa,Bioquímica,Sangre,20.50,si,En ayunas',
        'HP-AG,Helicobacter pylori antígeno,Microbiología,Heces,120,1,',
      ),
    );

    expect(report.autoImportAllowed).toBe(true);
    expect(report.fileIssues).toEqual([]);
    expect(report.summary).toEqual({ rows: 3, ok: 3, needsReview: 0, blocked: 0, emptyRowsSkipped: 0 });
    expect(row(report, 3)).toMatchObject({
      code: 'GLU01',
      name: 'Glucosa',
      normalizedName: 'glucosa',
      category: 'Bioquímica',
      sampleType: 'Sangre',
      priceBs: 20.5,
      active: true,
      notes: 'En ayunas',
      proposedCode: null,
      status: 'ok',
    });
  });

  it('acepta columnas en otro orden, encabezado con mayúsculas, BOM y CRLF', () => {
    const report = validateCatalogCsv(
      '﻿Name,CODE,price_bs,active,notes,category,sample_type,PRICE_EMERGENCIA_BS,price_medicos_bs,price_convenio_bs\r\n' +
        'Hemograma,HEM01,45,,,,,53,45,36\r\n',
    );

    expect(report.autoImportAllowed).toBe(true);
    expect(row(report, 2)).toMatchObject({
      code: 'HEM01',
      name: 'Hemograma',
      priceBs: 45,
      priceConvenioBs: 36,
      priceMedicosBs: 45,
      priceEmergenciaBs: 53,
      active: true,
    });
  });

  it('respeta comas y comillas dentro de campos entrecomillados', () => {
    const report = validateCatalogCsv(csv('PERF1,"Perfil lipídico (colesterol, triglicéridos)",,Sangre,"80.00",true,"Dice ""ayuno"""'));

    expect(row(report, 2)).toMatchObject({
      name: 'Perfil lipídico (colesterol, triglicéridos)',
      priceBs: 80,
      notes: 'Dice "ayuno"',
      status: 'ok',
    });
  });

  it('no modifica nada: el mismo texto produce el mismo reporte', () => {
    const text = csv('HEM01,Hemograma,,Sangre,45,true,', ',Glucosa,,Sangre,20,true,');
    expect(validateCatalogCsv(text)).toEqual(validateCatalogCsv(text));
  });
});

describe('validateCatalogCsv: problemas de archivo', () => {
  it('bloquea si falta una columna obligatoria', () => {
    const report = validateCatalogCsv('code,name,category,sample_type,active,notes\nHEM01,Hemograma,,,true,');

    expect(report.autoImportAllowed).toBe(false);
    expect(report.fileIssues).toContainEqual(
      expect.objectContaining({ severity: 'blocking', kind: 'missing_column', message: expect.stringContaining('price_bs') }),
    );
    expect(report.rows).toEqual([]);
  });

  it('un CSV con el formato anterior (sin las otras tres tarifas) se rechaza entero', () => {
    const report = validateCatalogCsv('code,name,category,sample_type,price_bs,active,notes\nHEM01,Hemograma,,,45,true,');

    expect(report.rows).toEqual([]);
    expect(report.fileIssues.filter((issue) => issue.kind === 'missing_column').map((issue) => issue.message)).toEqual([
      'Falta la columna obligatoria «price_convenio_bs».',
      'Falta la columna obligatoria «price_medicos_bs».',
      'Falta la columna obligatoria «price_emergencia_bs».',
    ]);
  });

  it('bloquea columnas repetidas y avisa columnas desconocidas', () => {
    const report = validateCatalogCsv(`${HEADER},name,extra\nHEM01,Hemograma,,,45,true,,x,y`);

    expect(report.fileIssues.map((issue) => [issue.severity, issue.kind])).toEqual(
      expect.arrayContaining([
        ['blocking', 'duplicate_column'],
        ['warning', 'unknown_column'],
      ]),
    );
    expect(report.autoImportAllowed).toBe(false);
  });

  it('detecta un CSV separado por punto y coma', () => {
    const report = validateCatalogCsv('code;name;category;sample_type;price_bs;active;notes\nHEM01;Hemograma;;;45;true;');
    expect(report.fileIssues[0]).toMatchObject({ severity: 'blocking', kind: 'wrong_delimiter' });
  });

  it('bloquea un archivo vacío o sin filas de datos', () => {
    expect(validateCatalogCsv('').fileIssues[0].kind).toBe('empty_file');
    expect(validateCatalogCsv(`${HEADER}\n`).fileIssues).toContainEqual(
      expect.objectContaining({ kind: 'no_data_rows', severity: 'blocking' }),
    );
  });

  it('bloquea comillas sin cerrar', () => {
    const report = validateCatalogCsv(csv('HEM01,"Hemograma,,,45,true,'));
    expect(report.fileIssues[0]).toMatchObject({ kind: 'unterminated_quote', line: 2 });
  });

  it('ignora filas vacías con advertencia, sin bloquear la carga', () => {
    const report = validateCatalogCsv(
      [HEADER, withTariffs('HEM01,Hemograma,,,45,true,'), '', ',,,,,,,,,', withTariffs('GLU01,Glucosa,,,20,true,')].join(
        '\n',
      ),
    );

    expect(report.summary.emptyRowsSkipped).toBe(2);
    expect(report.fileIssues.every((issue) => issue.kind === 'empty_row' && issue.severity === 'warning')).toBe(true);
    expect(report.rows.map((r) => r.line)).toEqual([2, 5]);
    expect(report.autoImportAllowed).toBe(true);
  });

  it('bloquea filas con distinta cantidad de columnas', () => {
    const report = validateCatalogCsv(csv('HEM01,Hemograma, completo,,,45,true,'));
    expect(kinds(report, 2)).toContain('column_count');
    expect(row(report, 2).status).toBe('blocked');
  });
});

describe('validateCatalogCsv: códigos', () => {
  it('bloquea códigos duplicados en todas sus filas, sin distinguir mayúsculas', () => {
    const report = validateCatalogCsv(
      csv('HEM01,Hemograma,,,45,true,', 'hem01,Hemoglobina,,,30,true,', 'GLU01,Glucosa,,,20,true,'),
    );

    expect(report.duplicateCodes).toEqual([{ code: 'HEM01', lines: [2, 3] }]);
    expect(row(report, 2).status).toBe('blocked');
    expect(row(report, 3).status).toBe('blocked');
    expect(row(report, 4).status).toBe('ok');
    expect(report.autoImportAllowed).toBe(false);
  });

  it('un código ausente queda en revisión con una propuesta, nunca como código', () => {
    const report = validateCatalogCsv(csv(',Hemograma completo,,Sangre,45,true,'));
    const hemograma = row(report, 2);

    expect(hemograma.code).toBeNull();
    expect(hemograma.proposedCode).toBe(proposeCatalogCode('Hemograma completo', 'Sangre'));
    expect(hemograma.proposedCode).toMatch(/^AUTO-[0-9A-F]{8}$/);
    expect(hemograma.status).toBe('needs_review');
    expect(hemograma.issues[0]).toMatchObject({ severity: 'review', kind: 'missing_code' });
    expect(report.autoImportAllowed).toBe(false);
  });

  it('la propuesta no depende del orden de las filas', () => {
    const a = validateCatalogCsv(csv(',Hemograma,,Sangre,45,true,', ',Glucosa,,Sangre,20,true,'));
    const b = validateCatalogCsv(csv(',Glucosa,,Sangre,20,true,', ',Hemograma,,Sangre,45,true,'));

    const proposals = (report: CatalogValidationReport) =>
      Object.fromEntries(report.rows.map((r) => [r.name, r.proposedCode]));
    expect(proposals(a)).toEqual(proposals(b));
  });

  it('la misma fila produce la misma propuesta en ejecuciones repetidas', () => {
    const text = csv(',Ácido Úrico,Bioquímica,Sangre,35,true,');
    const runs = Array.from({ length: 5 }, () => row(validateCatalogCsv(text), 2).proposedCode);

    expect(new Set(runs).size).toBe(1);
    // Tildes y mayúsculas no cambian la propuesta.
    expect(runs[0]).toBe(proposeCatalogCode('ACIDO URICO', 'sangre'));
  });

  it('la propuesta ignora precio y categoría, pero distingue el tipo de muestra', () => {
    expect(proposeCatalogCode('Glucosa', 'Sangre')).toBe(proposeCatalogCode('glucosa', 'SANGRE'));
    expect(proposeCatalogCode('Glucosa', 'Sangre')).not.toBe(proposeCatalogCode('Glucosa', 'Orina'));

    const cheap = row(validateCatalogCsv(csv(',Glucosa,A,Sangre,20,true,')), 2).proposedCode;
    const pricey = row(validateCatalogCsv(csv(',Glucosa,B,Sangre,99,true,')), 2).proposedCode;
    expect(cheap).toBe(pricey);
  });

  it('marca una propuesta que choca con un código real del archivo', () => {
    const proposed = proposeCatalogCode('Glucosa', 'Sangre');
    const report = validateCatalogCsv(csv(`${proposed},Hemograma,,,45,true,`, ',Glucosa,,Sangre,20,true,'));

    expect(kinds(report, 3)).toContain('proposed_code_conflict');
  });
});

describe('validateCatalogCsv: nombres', () => {
  it('bloquea un nombre vacío o sin letras ni números', () => {
    const report = validateCatalogCsv(csv('X1,,,,45,true,', 'X2,  ---  ,,,45,true,'));

    expect(kinds(report, 2)).toContain('missing_name');
    expect(kinds(report, 3)).toContain('missing_name');
    expect(row(report, 2).proposedCode).toBeNull();
  });

  it('dos nombres que normalizan igual no se fusionan y quedan en revisión', () => {
    const report = validateCatalogCsv(
      csv('GLU-S,Glucosa,,Sangre,20,true,', 'GLU-O,GLUCOSA,,Orina,25,true,', 'HEM01,Hemograma,,,45,true,'),
    );

    expect(report.rows).toHaveLength(3);
    expect(report.nameCollisions).toEqual([{ normalizedName: 'glucosa', lines: [2, 3] }]);
    expect(row(report, 2)).toMatchObject({ code: 'GLU-S', priceBs: 20, status: 'needs_review' });
    expect(row(report, 3)).toMatchObject({ code: 'GLU-O', priceBs: 25, status: 'needs_review' });
    expect(row(report, 4).status).toBe('ok');
    expect(report.autoImportAllowed).toBe(false);
  });

  it('tildes, mayúsculas y signos cuentan como el mismo nombre normalizado', () => {
    const report = validateCatalogCsv(csv('AU1,Ácido Úrico,,,35,true,', 'AU2,acido  urico.,,,35,true,'));

    expect(row(report, 2).normalizedName).toBe('acido urico');
    expect(report.nameCollisions).toEqual([{ normalizedName: 'acido urico', lines: [2, 3] }]);
  });

  it('las variantes de Helicobacter son filas separadas, sin colisión', () => {
    const report = validateCatalogCsv(
      csv(
        'HP-AG,Helicobacter pylori antígeno en heces,,Heces,120,true,',
        'HP-IGG,Helicobacter pylori IgG,,Sangre,90,true,',
        'HP-IGM,Helicobacter pylori IgM,,Sangre,90,true,',
        'HP-ALI,Helicobacter pylori test del aliento,,Aliento,250,true,',
      ),
    );

    expect(report.nameCollisions).toEqual([]);
    expect(report.rows.map((r) => r.code)).toEqual(['HP-AG', 'HP-IGG', 'HP-IGM', 'HP-ALI']);
    expect(report.autoImportAllowed).toBe(true);
  });
});

describe('validateCatalogCsv: precios', () => {
  const cases: Array<[string, string, IssueKind]> = [
    ['vacío', '', 'missing_price'],
    ['solo espacios', '   ', 'missing_price'],
    ['cero', '0', 'zero_price'],
    ['cero con decimales', '0.00', 'zero_price'],
    ['negativo', '-10', 'negative_price'],
    ['con coma decimal', '"45,50"', 'invalid_price'],
    ['con texto', 'Bs 45', 'invalid_price'],
    ['con tres decimales', '45.505', 'invalid_price'],
    ['no numérico', 'abc', 'invalid_price'],
    ['fuera de rango', '100000000', 'price_out_of_range'],
  ];

  it.each(cases)('un precio %s bloquea la fila', (_label, price, kind) => {
    const report = validateCatalogCsv(csv(`HEM01,Hemograma,,,${price},true,`));
    const hemograma = row(report, 2);

    expect(hemograma.issues).toContainEqual(expect.objectContaining({ severity: 'blocking', kind, field: 'price_bs' }));
    expect(hemograma.status).toBe('blocked');
    expect(hemograma.priceBs).toBeNull();
    expect(report.autoImportAllowed).toBe(false);
  });

  const tariffCases: Array<[TariffColumn, string]> = [
    ['price_convenio_bs', 'HEM01,Hemograma,,,45,true,,{},45,53'],
    ['price_medicos_bs', 'HEM01,Hemograma,,,45,true,,36,{},53'],
    ['price_emergencia_bs', 'HEM01,Hemograma,,,45,true,,36,45,{}'],
  ];

  it.each(tariffCases)('%s sigue las mismas reglas que price_bs y bloquea la fila', (field, template) => {
    for (const [value, kind] of [
      ['', 'missing_price'],
      ['0', 'zero_price'],
      ['45.505', 'invalid_price'],
    ] as const) {
      const report = validateCatalogCsv([HEADER, template.replace('{}', value)].join('\n'));
      const hemograma = row(report, 2);

      expect(hemograma.issues).toContainEqual(expect.objectContaining({ severity: 'blocking', kind, field }));
      expect(hemograma.status).toBe('blocked');
    }
  });

  it('los mensajes nombran la tarifa', () => {
    const report = validateCatalogCsv([HEADER, 'HEM01,Hemograma,,,45,true,,36,,53'].join('\n'));
    expect(row(report, 2).issues[0].message).toBe('Falta el precio médicos.');
  });

  it('lee las cuatro tarifas de la misma fila', () => {
    const report = validateCatalogCsv([HEADER, 'HEM01,Hemograma,,,45,true,,36,45.5,52.94'].join('\n'));
    expect(row(report, 2)).toMatchObject({
      priceBs: 45,
      priceConvenioBs: 36,
      priceMedicosBs: 45.5,
      priceEmergenciaBs: 52.94,
      status: 'ok',
    });
  });

  it('la coma decimal sugiere usar punto', () => {
    const report = validateCatalogCsv(csv('HEM01,Hemograma,,,"45,50",true,'));
    expect(row(report, 2).issues[0].message).toContain('punto');
  });

  it('acepta enteros y hasta dos decimales', () => {
    const report = validateCatalogCsv(csv('A,Uno,,,45,true,', 'B,Dos,,,45.5,true,', 'C,Tres,,,45.55,true,'));
    expect(report.rows.map((r) => r.priceBs)).toEqual([45, 45.5, 45.55]);
  });
});

describe('validateCatalogCsv: active', () => {
  it.each([
    ['true', true],
    ['FALSE', false],
    ['si', true],
    ['Sí', true],
    ['no', false],
    ['1', true],
    ['0', false],
    ['', true],
  ])('acepta active=%s', (value, expected) => {
    const report = validateCatalogCsv(csv(`HEM01,Hemograma,,,45,${value},`));
    expect(row(report, 2)).toMatchObject({ active: expected, status: 'ok' });
  });

  it('bloquea un valor de active inválido', () => {
    const report = validateCatalogCsv(csv('HEM01,Hemograma,,,45,activo,'));

    expect(row(report, 2).issues).toContainEqual(
      expect.objectContaining({ severity: 'blocking', kind: 'invalid_active', field: 'active' }),
    );
    expect(row(report, 2).status).toBe('blocked');
  });
});

describe('validateCatalogCsv: combinación de problemas', () => {
  it('reporta todos los problemas de una fila y la bloqueante manda', () => {
    const report = validateCatalogCsv(csv(',Hemograma,,,0,quizas,'));

    expect(kinds(report, 2).sort()).toEqual(['invalid_active', 'missing_code', 'zero_price']);
    expect(row(report, 2).status).toBe('blocked');
    expect(report.summary).toMatchObject({ rows: 1, blocked: 1, needsReview: 0, ok: 0 });
  });
});
