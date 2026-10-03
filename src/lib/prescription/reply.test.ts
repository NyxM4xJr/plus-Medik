import { describe, expect, it } from 'vitest';
import { candidate, exam, fakeDeps, reading } from '@/test/prescription-fixtures';
import { analyzePrescription } from './analyze';
import { composeReply, formatBs } from './reply';

const INDEX = {
  glucosa: [candidate('glu')],
  tsh: [candidate('tsh')],
  helicobacter: [candidate('hpHeces', 'exact_alias'), candidate('hpIgg', 'exact_alias')],
};

describe('formatBs', () => {
  it('enteros sin decimales, el resto con dos', () => {
    expect(formatBs(50)).toBe('Bs 50');
    expect(formatBs(117.65)).toBe('Bs 117.65');
    expect(formatBs(20.5)).toBe('Bs 20.50');
  });
});

describe('composeReply: opciones', () => {
  it('recorta nombres de opciones muy largos', async () => {
    const long = 'PANEL '.padEnd(200, 'X');
    const analysis = await analyzePrescription(reading([exam('Panel X')]), {
      ...fakeDeps({}),
      async search(query) {
        return {
          query,
          status: 'ambiguous' as const,
          reason: 'multiple_exact' as const,
          match: null,
          candidates: [
            { ...candidate('glu', 'exact_name'), name: long },
            { ...candidate('tsh', 'exact_name'), name: 'TSH' },
          ],
          totalCandidates: 2,
          truncated: false,
        };
      },
    });
    const text = composeReply(analysis);
    expect(text).toMatch(/a\) PANEL X+… — Bs 20/);
    expect(text.split('\n').every((line) => line.length < 120)).toBe(true);
  });
});

describe('composeReply', () => {
  it('cotización: exámenes con precio, muestra, preparación, total y preguntas', async () => {
    const text = composeReply(await analyzePrescription(reading([exam('Glucosa'), exam('TSH')]), fakeDeps(INDEX)));

    expect(text).toContain('1. *GLUCOSA* — Bs 20');
    expect(text).toContain('   Muestra: Suero');
    expect(text).toContain('   Preparación: Se requiere ayuno de 8 a 12 horas.');
    expect(text).toContain('*Total: Bs 137.65*');
    expect(text).toContain('• ¿Puede venir con 8 a 12 horas de ayuno? (GLUCOSA, TSH)');
  });

  it('confirmación: cotiza solo lo seguro y pregunta por las variantes restantes', async () => {
    const text = composeReply(
      await analyzePrescription(reading([exam('Helicobacter'), exam('TSH', { confidence: 0.3 }), exam('Glucosa')]), fakeDeps(INDEX)),
    );

    expect(text).toContain('Antes de cotizar');
    expect(text).toContain('• «Helicobacter»: ¿cuál de estas opciones es?');
    expect(text).toContain('   a) HELICOBACTER PYLORI (HECES) — Bs 100');
    expect(text).toContain('   b) HELICOBACTER PYLORI IgG — Bs 90');
    expect(text).toContain('• «TSH»: no lo leímos con seguridad. ¿Es *TSH*?');
    expect(text).toContain('1. *GLUCOSA* — Bs 20');
    expect(text).toContain('*Subtotal parcial: Bs 20*');
    expect(text).toContain('Este subtotal no incluye los exámenes pendientes de confirmar.');
    expect(text).not.toContain('*Total:');
  });

  it('un no encontrado no impide cotizar las otras líneas con subtotal parcial', async () => {
    const analysis = await analyzePrescription(
      reading([exam('Glucosa'), exam('Hemocultivos')]),
      fakeDeps(INDEX),
    );
    const text = composeReply(analysis);

    expect(text).toContain('1. *GLUCOSA* — Bs 20');
    expect(text).toContain('*Subtotal parcial: Bs 20*');
    expect(text).toContain('«Hemocultivos»: no lo encontramos en nuestro catálogo; un asesor lo revisará.');
    expect(text).not.toContain('*Total:');
  });

  it('confirmación: lo no encontrado pasa a un asesor y la imagen borrosa pide otra foto', async () => {
    const text = composeReply(
      await analyzePrescription(reading([exam('XYZ', { interpretation: 'Examen raro' })], { image_quality: 0.3 }), fakeDeps(INDEX)),
    );

    expect(text).toContain('• «XYZ» (Examen raro): no lo encontramos en nuestro catálogo; un asesor lo revisará.');
    expect(text).toContain('envíe una foto más clara');
  });

  it.each([
    ['not_lab_order', reading([], { is_lab_order: false }), 'No encontramos una orden'],
    ['retake', reading([], { image_quality: 0.1 }), 'foto más nítida'],
    ['no_exams', reading([]), 'No identificamos exámenes marcados'],
  ])('%s', async (_decision, input, expected) => {
    expect(composeReply(await analyzePrescription(input, fakeDeps(INDEX)))).toContain(expected);
  });
});

describe('composeReply: imagen de baja calidad', () => {
  it('nombra lo identificado sin precio y pide otra foto; no dice que falta en el catálogo', async () => {
    const analysis = await analyzePrescription(reading([exam('Glucosa')], { image_quality: 0.4 }), fakeDeps(INDEX));
    const text = composeReply(analysis);

    expect(text).toContain('Estos sí los identificamos:');
    expect(text).toContain('foto más clara');
    expect(text).not.toContain('no lo encontramos en nuestro catálogo');
    expect(text).not.toContain('Bs');
  });
});
