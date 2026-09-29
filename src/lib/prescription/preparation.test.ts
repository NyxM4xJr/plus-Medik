import { describe, expect, it } from 'vitest';
import { parseNotes, patientQuestions } from './preparation';

describe('parseNotes', () => {
  it('separa preparación y tiempo de entrega', () => {
    expect(parseNotes('Preparacion: Se requiere ayuno de 8 a 12 horas. | Tiempo de entrega: 1 dia')).toEqual({
      preparation: 'Se requiere ayuno de 8 a 12 horas.',
      deliveryTime: '1 dia',
    });
  });

  it('acepta solo una de las dos partes, o ninguna', () => {
    expect(parseNotes('Tiempo de entrega: 10 dias')).toEqual({ preparation: null, deliveryTime: '10 dias' });
    expect(parseNotes('Preparación: Formol al 10%')).toEqual({ preparation: 'Formol al 10%', deliveryTime: null });
    expect(parseNotes(null)).toEqual({ preparation: null, deliveryTime: null });
  });
});

describe('patientQuestions', () => {
  const q = (...preparations: Array<string | null>) =>
    patientQuestions(preparations.map((preparation, index) => ({ name: `E${index + 1}`, preparation })));

  it('ayuno: usa el rango más exigente y nombra los exámenes', () => {
    const questions = q('Se requiere ayuno de 6 a 8 horas.', 'Se requiere ayuno de 8 a 12 horas.');
    expect(questions).toEqual([
      { id: 'fasting', question: '¿Puede venir con 8 a 12 horas de ayuno?', exams: ['E1', 'E2'] },
    ]);
  });

  it('ayuno estricto con horas', () => {
    const [question] = q('Zinc en suero: se requiere ayuno estricto de 8 a 12 horas.');
    expect(question.question).toBe('¿Puede venir con 8 a 12 horas de ayuno?');
  });

  it('ayuno sugerido también se pregunta', () => {
    const [question] = q('No requiere condiciones especiales, pero se sugiere 8 a 12 horas de ayuno para evitar la lipemia.');
    expect(question.id).toBe('fasting');
  });

  it('«no requiere ayuno» no genera la pregunta de ayuno', () => {
    expect(q('Evitar ejercicio intenso y estrés antes de la toma, no requiere ayuno')).toEqual([]);
    expect(q('No se requiere ayuno previo. Indicar al personal si se colocó inyección intramuscular.').map((x) => x.id)).toEqual([
      'medication',
    ]);
  });

  it('las horas de otras indicaciones no cuentan como ayuno', () => {
    const [question] = q('Se requiere ayuno. No realizar ejercicio 48 horas antes de la toma de muestra y abstinencia sexual.');
    expect(question.question).toBe('¿Puede venir en ayunas?');
  });

  it('medicación, ciclo menstrual, abstinencia y antibióticos', () => {
    const ids = q(
      'Informar si está tomando alguna medicación para la tiroides.',
      'Mujeres: no debe estar en su periodo menstrual.',
      'Abstinencia sexual de 48 horas.',
      'Antibióticos y probióticos 15 días antes.',
    ).map((question) => question.id);
    expect(ids).toEqual(['medication', 'menstrual_cycle', 'abstinence', 'antibiotics']);
  });

  it('«tratamiento con antibiótico» pregunta por antibióticos, no por medicación (caso real: coprocultivo)', () => {
    const ids = q(
      'Recolectar muestra antes de comenzar tratamiento con antibiótico. En frasco estéril recolectar la muestra.',
    ).map((question) => question.id);
    expect(ids).toEqual(['antibiotics']);
  });

  it('«tratamiento de óvulos» no es una pregunta de medicación; «algún tratamiento» sí', () => {
    expect(q('Evitar tratamiento de óvulos.')).toEqual([]);
    expect(q('Informar si se encuentra bajo tratamiento.').map((question) => question.id)).toEqual(['medication']);
    expect(q('Los anticonceptivos orales y el tratamiento hormonal sustitutivo.').map((x) => x.id)).toEqual(['medication']);
  });

  it('sin preparación especial no hay preguntas', () => {
    expect(q('No requiere condiciones especiales.', null)).toEqual([]);
  });
});
