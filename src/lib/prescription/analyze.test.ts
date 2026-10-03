import { describe, expect, it } from 'vitest';
import { classifyCandidates, type CatalogCandidate } from '@/lib/catalog/search';
import { candidate, exam, fakeDeps, reading, TESTS } from '@/test/prescription-fixtures';
import { analyzePrescription, CONTAINED_MATCH_CONFIDENCE, DEFAULT_MIN_CONFIDENCE, identify } from './analyze';

/** Candidato difuso con nombre libre, para probar la identificación por contenido. */
function named(id: string, name: string, similarityScore: number): CatalogCandidate {
  return {
    labTestId: id,
    code: id,
    name,
    category: null,
    sampleType: null,
    priceBs: 10,
    matchType: 'fuzzy_name',
    matchedText: name.toLowerCase(),
    similarityScore,
  };
}

/**
 * identify con una búsqueda que devuelve `found` y un catálogo completo
 * `catalog` (por defecto, lo mismo que la búsqueda). truncated simula el
 * límite del RPC.
 */
function identifyWith(
  text: string,
  interpretation: string | null,
  found: CatalogCandidate[],
  { catalog = found, truncated = false }: { catalog?: CatalogCandidate[]; truncated?: boolean } = {},
) {
  const search = async (query: string) => classifyCandidates(query, found, found.length + (truncated ? 1 : 0));
  return identify(search, catalog, text, interpretation);
}

const INDEX = {
  'hemograma completo': [candidate('hem')],
  glucosa: [candidate('glu')],
  tsh: [candidate('tsh')],
  helicobacter: [candidate('hpHeces', 'exact_alias'), candidate('hpIgg', 'exact_alias')],
  hemograma: [candidate('hem', 'fuzzy_name', 0.4)],
  'hemograma compl': [candidate('hem', 'fuzzy_name', 0.65)],
};

describe('analyzePrescription: cotiza solo con todo identificado', () => {
  it('todos los exámenes exactos y legibles: cotiza con Precio Paciente, muestra, preparación y total', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Hemograma completo'), exam('Glucosa'), exam('TSH')]),
      fakeDeps(INDEX),
    );

    expect(analysis.decision).toBe('quote');
    expect(analysis.quote?.lines.map((line) => [line.code, line.priceBs])).toEqual([
      ['108', 50],
      ['380', 20],
      ['170', 117.65],
    ]);
    expect(analysis.quote?.totalBs).toBe(187.65);
    expect(analysis.quote?.lines[1]).toMatchObject({
      sampleType: 'Suero',
      preparation: 'Se requiere ayuno de 8 a 12 horas.',
      deliveryTime: '2 horas',
    });
  });

  it('pregunta las condiciones del paciente que exigen esos exámenes', async () => {
    const analysis = await analyzePrescription(reading([exam('Glucosa'), exam('TSH')]), fakeDeps(INDEX));

    expect(analysis.questions.map((q) => [q.id, q.exams])).toEqual([
      ['fasting', ['GLUCOSA', 'TSH']],
      ['medication', ['TSH']],
    ]);
  });

  it('el mismo examen leído dos veces (dos fotos) se cotiza una sola vez', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa'), exam('glucosa', { image: 2 })]),
      fakeDeps(INDEX),
    );

    expect(analysis.quote?.lines).toHaveLength(1);
    expect(analysis.quote?.totalBs).toBe(20);
  });
});

describe('analyzePrescription: umbral de confianza (60% provisional)', () => {
  it('el umbral por defecto es 0.6', () => {
    expect(DEFAULT_MIN_CONFIDENCE).toBe(0.6);
  });

  it('lectura por debajo del umbral: pide confirmación y no cotiza', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa', { confidence: 0.59 }), exam('TSH')]),
      fakeDeps(INDEX),
    );

    expect(analysis.decision).toBe('confirm');
    expect(analysis.identificationMatches).toBe(2);
    expect(analysis.quote).toBeNull();
    expect(analysis.partialQuote?.lines.map((line) => line.code)).toEqual(['170']);
    expect(analysis.questions.map((question) => question.exams)).toEqual([['TSH'], ['TSH']]);
    expect(analysis.exams[0]).toMatchObject({
      status: 'needs_confirmation',
      reason: 'low_reading_confidence',
      labTestName: 'GLUCOSA',
    });
  });

  it('el umbral es inclusivo: 0.6 exacto se acepta', async () => {
    const analysis = await analyzePrescription(reading([exam('Glucosa', { confidence: 0.6 })]), fakeDeps(INDEX));
    expect(analysis.decision).toBe('quote');
  });

  it('identificación difusa por debajo del umbral configurado: pide confirmación', async () => {
    const analysis = await analyzePrescription(reading([exam('Hemograma compl')]), fakeDeps(INDEX), {
      minConfidence: 0.7,
    });

    expect(analysis.decision).toBe('confirm');
    expect(analysis.exams[0]).toMatchObject({
      reason: 'low_identification_confidence',
      identificationConfidence: 0.65,
      confidence: 0.65,
    });
  });

  it('imagen de baja calidad: pide confirmación aunque todo se haya identificado', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa')], { image_quality: 0.4, issues: ['borrosa'] }),
      fakeDeps(INDEX),
    );

    expect(analysis).toMatchObject({ decision: 'confirm', lowImageQuality: true, quote: null, partialQuote: null });
    // El código se conserva para la planilla de revisión aunque no se cotice.
    expect(analysis.exams[0]).toMatchObject({ status: 'identified', labTestCode: '380' });
  });
});

describe('analyzePrescription: nunca elige entre variantes', () => {
  it('Helicobacter con varias variantes: ofrece las opciones y no cotiza', async () => {
    const analysis = await analyzePrescription(reading([exam('Helicobacter'), exam('Glucosa')]), fakeDeps(INDEX));

    expect(analysis.decision).toBe('confirm');
    expect(analysis.exams[0]).toMatchObject({ status: 'needs_confirmation', reason: 'multiple_options', labTestId: null });
    expect(analysis.exams[0].options.map((o) => o.code)).toEqual(['453', '204']);
  });

  it('parecido lejano: pide aclaración, pero no atribuye ni cotiza el candidato difuso', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Hemogrma')]),
      fakeDeps({ hemogrma: [named('esp', 'ESPERMOGRAMA', 0.4)] }),
    );

    expect(analysis.exams[0]).toMatchObject({
      status: 'needs_confirmation',
      reason: 'low_identification_confidence',
      labTestId: null,
      options: [],
    });
  });

  it('cotiza solo los exámenes seguros y deja los demás pendientes', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa'), exam('PCR cuantitativo'), exam('Hemocultivos')]),
      fakeDeps({
        ...INDEX,
        'pcr cuantitativo': [candidate('glu', 'fuzzy_name', 0.42)],
      }),
    );

    expect(analysis.decision).toBe('confirm');
    expect(analysis.quote).toBeNull();
    expect(analysis.partialQuote).toMatchObject({
      lines: [{ code: '380', name: 'GLUCOSA', priceBs: 20 }],
      totalBs: 20,
    });
    expect(analysis.exams.map((item) => item.status)).toEqual([
      'identified',
      'needs_confirmation',
      'not_identified',
    ]);
  });

  it('low image quality disables partial quotes even if a test matched', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa'), exam('Examen raro')], { image_quality: 0.4 }),
      fakeDeps(INDEX),
    );

    expect(analysis.decision).toBe('confirm');
    expect(analysis.partialQuote).toBeNull();
  });

  it('sin candidatos: no identificado', async () => {
    const analysis = await analyzePrescription(reading([exam('Examen inventado')]), fakeDeps(INDEX));
    expect(analysis.exams[0].status).toBe('not_identified');
  });
});

describe('identify: texto leído más interpretación de la sigla', () => {
  async function identifyIndexed(text: string, interpretation: string | null) {
    const deps = fakeDeps(INDEX);
    return { deps, result: await identify(deps.search, await deps.catalog(), text, interpretation) };
  }

  it('si el texto no aparece pero la interpretación sí, identifica', async () => {
    const { result } = await identifyIndexed('HC', 'Hemograma completo');
    expect(result).toMatchObject({ status: 'matched', basis: 'exact', confidence: 1 });
    expect(result.match?.labTestId).toBe('hem');
  });

  it('si texto e interpretación apuntan a exámenes distintos, es ambiguo', async () => {
    const { result } = await identifyIndexed('TSH', 'Glucosa');
    expect(result).toMatchObject({ status: 'ambiguous', basis: 'exact' });
    expect(result.options.map((option) => option.labTestId).sort()).toEqual(['glu', 'tsh']);
  });

  it('no repite la búsqueda si la interpretación es igual al texto', async () => {
    const { deps } = await identifyIndexed('TSH', 'tsh');
    expect(deps.queries).toEqual(['TSH']);
  });
});

describe('identify: por contenido sobre todo el catálogo', () => {
  it('un único examen contiene todo lo escrito: se identifica aunque el nombre tenga el método', async () => {
    const result = await identifyWith('Hemograma completo', null, [
      named('108', 'HEMOGRAMA COMPLETO AUTOMATIZADO', 0.45),
      named('96', 'ESPERMOGRAMA', 0.36),
    ]);
    expect(result).toMatchObject({ status: 'matched', basis: 'contained', confidence: CONTAINED_MATCH_CONFIDENCE });
    expect(result.match?.code).toBe('108');
  });

  it('caso real: la búsqueda no trajo una variante, pero el catálogo sí la tiene → pregunta', async () => {
    const semi = named('476', 'PROTEINA C REACTIVA (PCR SEMI CUANTITATIVO', 0.5);
    const quant = named('477', 'PROTEINA C REACTIVA (PCR CUANTITATIVO) (FIA Fluorescencia)', 0.3);
    const result = await identifyWith('PCR cuantitativo', null, [semi], { catalog: [semi, quant] });
    expect(result).toMatchObject({ status: 'ambiguous', basis: 'contained' });
    expect(result.options.map((option) => option.code).sort()).toEqual(['476', '477']);
  });

  it('varias variantes contienen lo escrito: pregunta solo entre ellas, sin parecidos ajenos', async () => {
    const result = await identifyWith('25-OH Vitamina D', '25-hidroxivitamina D (calcidiol)', [
      named('538', 'VITAMINA D 25 (OH) (ECLIA)', 0.5),
      named('539', 'VITAMINA D 25 (OH) (FIA Fluorescencia)', 0.45),
      named('537', 'VITAMINA D 1,25 Dihidroxi Calcifidol', 0.4),
      named('527', 'VITAMINA A', 0.38),
    ]);
    expect(result).toMatchObject({ status: 'ambiguous', basis: 'contained' });
    expect(result.options.map((option) => option.code)).toEqual(['538', '539']);
  });

  it('entre varios que contienen lo escrito, gana el único que solo agrega el método', async () => {
    const result = await identifyWith('Testosterona total', null, [
      named('t1', 'TESTOSTERONA TOTAL (ECLIA)', 0.6),
      named('p1', 'PERFIL ANDROPAUSIA (Testosterona Total, Testosterona Libre y SHBG)', 0.4),
    ]);
    expect(result).toMatchObject({ status: 'matched', basis: 'contained' });
    expect(result.match?.code).toBe('t1');
  });

  it('dos que solo difieren en el método: pregunta (lo resuelve un alias del laboratorio)', async () => {
    const result = await identifyWith('TSH', null, [
      named('178', 'TSH (ECLIA)', 0.5),
      named('179', 'TSH (FIA Fluorescencia)', 0.4),
      named('180', 'TSH NEONATAL', 0.45),
    ]);
    expect(result).toMatchObject({ status: 'ambiguous', basis: 'contained' });
    expect(result.options.map((option) => option.code)).toEqual(['178', '179']);
  });

  it('caso real: un panel que menciona lo escrito entre muchos patógenos no se acepta solo', async () => {
    const panel = named(
      'panel',
      'PANEL DE FIEBRE TROPICAL RT-qPCR (21 PATOGENOS) VIRUS: Dengue, Zika PARASITOS: Leishmania spp., Trypanosoma cruzi',
      0.3,
    );
    const result = await identifyWith('Micrometodo (T. cruzi)', 'Trypanosoma cruzi', [panel]);
    expect(result).toMatchObject({ status: 'ambiguous', basis: 'contained' });
  });

  it('entre variantes con palabras de más, gana la única cercana frente a un perfil', async () => {
    const result = await identifyWith('SHBG', null, [
      named('shbg', 'SHBG Globulina fijadora de hormonas sexuales (ECLIA)', 0.4),
      named('perfil', 'PERFIL ANDROPAUSIA (Testosterona Total, Testosterona Libre y SHBG)', 0.3),
    ]);
    expect(result.match?.code).toBe('shbg');
  });

  it('nombre completo dentro del texto del médico, sobrando solo «sérica»', async () => {
    const result = await identifyWith('Calcitonina sérica', null, [
      named('365', 'CALCITONINA', 0.63),
      named('363', 'PROCALCITONINA (FIA Fluorescencia)', 0.5),
    ]);
    expect(result).toMatchObject({ status: 'matched', basis: 'contained' });
    expect(result.match?.code).toBe('365');
  });

  it('caso real: la interpretación larga del modelo no sirve para «nombre dentro de lo escrito»', async () => {
    const result = await identifyWith('Toxoplasmosis IgG Elisa', 'Inmunoglobulina G (IgG) para toxoplasmosis', [
      named('ig', 'INMUNOGLOBULINA IgG', 0.4),
    ]);
    expect(result.match?.code).not.toBe('ig');
    expect(result.status).not.toBe('matched');
  });

  it('una muestra que sobra no se ignora («Rotavirus en heces» no es solo ROTAVIRUS)', async () => {
    const result = await identifyWith('Glucosa en orina', null, [named('399', 'GLUCOSA', 0.5)]);
    expect(result.status).not.toBe('matched');
  });

  it('caso real: «e» no es palabra vacía («Hepatitis B Ag. Sup.» no ofrece HEPATITIS E)', async () => {
    const result = await identifyWith('Hepatitis B Ag. Sup.', null, [named('he', 'HEPATITIS E', 0.4)]);
    expect(result.options.map((option) => option.code)).not.toContain('he');
    expect(result.match).toBeNull();
  });

  it('las palabras vacías no cuentan', async () => {
    const result = await identifyWith('Glucosa en orina', null, [
      named('517', 'GLUCOSURIA - GLUCOSA EN ORINA 24 horas', 0.5),
      named('399', 'GLUCOSA', 0.5),
    ]);
    expect(result.match?.code).toBe('517');
  });

  it('difuso: si el límite de la búsqueda cortó candidatos, nada es único', async () => {
    const result = await identifyWith('Hemogrma', null, [named('108', 'HEMOGRAMA COMPLETO AUTOMATIZADO', 0.7)], {
      truncated: true,
    });
    expect(result.status).toBe('ambiguous');
  });

  it('en el análisis, lo identificado por contenido se cotiza', async () => {
    const analysis = await analyzePrescription(reading([exam('Hemograma')]), fakeDeps(INDEX));
    expect(analysis.decision).toBe('quote');
    expect(analysis.exams[0]).toMatchObject({
      status: 'identified',
      basis: 'contained',
      labTestName: 'HEMOGRAMA COMPLETO',
      labTestCode: '108',
    });
  });
});

describe('analyzePrescription: imágenes que no se cotizan', () => {
  it('no es una orden de laboratorio', async () => {
    const analysis = await analyzePrescription(reading([], { is_lab_order: false }), fakeDeps(INDEX));
    expect(analysis.decision).toBe('not_lab_order');
  });

  it('orden sin exámenes legibles y con baja calidad: pedir otra foto', async () => {
    const analysis = await analyzePrescription(reading([], { image_quality: 0.2 }), fakeDeps(INDEX));
    expect(analysis.decision).toBe('retake');
  });

  it('orden legible sin exámenes marcados', async () => {
    const analysis = await analyzePrescription(reading([]), fakeDeps(INDEX));
    expect(analysis.decision).toBe('no_exams');
  });

  it('un examen desactivado entre la búsqueda y la cotización no se cotiza', async () => {
    const withoutGlucose = Object.fromEntries(Object.entries(TESTS).filter(([id]) => id !== 'glu'));
    const analysis = await analyzePrescription(reading([exam('Glucosa')]), fakeDeps(INDEX, withoutGlucose));

    expect(analysis.decision).toBe('confirm');
    expect(analysis.exams[0]).toMatchObject({ status: 'not_identified', labTestId: null });
  });
});
