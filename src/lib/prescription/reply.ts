import type { AnalyzedExam, PrescriptionAnalysis, QuoteLine } from '@/lib/prescription/analyze';

/**
 * Borrador del mensaje de WhatsApp para una receta analizada. Solo arma
 * texto: nada de este módulo envía mensajes (modo observer/dry-run).
 */

export function formatBs(amount: number): string {
  return Number.isInteger(amount) ? `Bs ${amount}` : `Bs ${amount.toFixed(2)}`;
}

const LETTERS = 'abcdefghij';

/** Nombres de paneles pueden ser larguísimos: en las opciones se recortan. */
const MAX_OPTION_NAME = 80;

function shortName(name: string): string {
  return name.length <= MAX_OPTION_NAME ? name : `${name.slice(0, MAX_OPTION_NAME - 1).trimEnd()}…`;
}

function quoted(exam: AnalyzedExam): string {
  return exam.interpretation ? `«${exam.text}» (${exam.interpretation})` : `«${exam.text}»`;
}

function confirmLine(exam: AnalyzedExam): string {
  switch (exam.reason) {
    case 'multiple_options':
      return [
        `• ${quoted(exam)}: ¿cuál de estas opciones es?`,
        ...exam.options.map((option, index) => `   ${LETTERS[index]}) ${shortName(option.name)} — ${formatBs(option.priceBs)}`),
      ].join('\n');
    case 'low_reading_confidence':
    case 'low_identification_confidence': {
      return exam.labTestName
        ? `• ${quoted(exam)}: no lo leímos con seguridad. ¿Es *${exam.labTestName}*?`
        : `• ${quoted(exam)}: no lo leímos con seguridad.`;
    }
    default:
      return `• ${quoted(exam)}: no lo encontramos en nuestro catálogo; un asesor lo revisará.`;
  }
}

function quoteLines(lines: QuoteLine[]): string[] {
  return lines.flatMap((line, index) => [
    `${index + 1}. *${line.name}* — ${formatBs(line.priceBs)}`,
    ...(line.sampleType ? [`   Muestra: ${line.sampleType}`] : []),
    ...(line.preparation ? [`   Preparación: ${line.preparation}`] : []),
    ...(line.deliveryTime ? [`   Entrega de resultados: ${line.deliveryTime}`] : []),
  ]);
}

function questionLines(analysis: PrescriptionAnalysis): string[] {
  if (analysis.questions.length === 0) return [];
  return [
    '',
    'Para preparar la toma de muestra, ¿nos confirma lo siguiente?',
    ...analysis.questions.map((question) => `• ${question.question} (${question.exams.join(', ')})`),
  ];
}

function quoteReply(analysis: PrescriptionAnalysis): string {
  const quote = analysis.quote;
  if (!quote) throw new Error('quoteReply sin cotización');

  return [
    'Gracias por enviar su orden. Estos son los exámenes que identificamos:',
    '',
    ...quoteLines(quote.lines),
    '',
    `*Total: ${formatBs(quote.totalBs)}*`,
    ...questionLines(analysis),
    '',
    'Si algún examen no corresponde a su orden, avísenos y lo corregimos.',
  ].join('\n');
}

function confirmReply(analysis: PrescriptionAnalysis): string {
  const doubtful = analysis.exams.filter((exam) => exam.status !== 'identified');
  const identified = analysis.exams.filter((exam) => exam.status === 'identified');
  const partialQuote = analysis.partialQuote;

  return [
    'Gracias por enviar su orden. Antes de cotizar necesitamos confirmar algunos exámenes:',
    '',
    ...(partialQuote
      ? [
          'Estos sí pudimos identificar y cotizar:',
          '',
          ...quoteLines(partialQuote.lines),
          '',
          `*Subtotal parcial: ${formatBs(partialQuote.totalBs)}*`,
          'Este subtotal no incluye los exámenes pendientes de confirmar.',
          ...questionLines(analysis),
          '',
        ]
      : []),
    ...(doubtful.length > 0 ? ['Para completar la cotización, necesitamos confirmar:', ''] : []),
    ...doubtful.map(confirmLine),
    ...(!partialQuote && identified.length > 0
      ? [
          '',
          'Estos sí los identificamos:',
          ...identified.map((exam) => `• ${exam.labTestName ?? exam.text}`),
        ]
      : []),
    ...(analysis.lowImageQuality
      ? ['', 'La imagen se ve poco nítida. Si puede, envíe una foto más clara y completa de la orden.']
      : []),
  ].join('\n');
}

export function composeReply(analysis: PrescriptionAnalysis): string {
  switch (analysis.decision) {
    case 'quote':
      return quoteReply(analysis);
    case 'confirm':
      return confirmReply(analysis);
    case 'retake':
      return 'Gracias por enviar su orden. No logramos leerla bien: ¿puede enviar una foto más nítida, con buena luz y la orden completa?';
    case 'not_lab_order':
      return 'Gracias por su mensaje. No encontramos una orden de exámenes de laboratorio en la imagen. Si tiene la orden de su médico, envíenos una foto; un asesor también puede ayudarle.';
    case 'no_exams':
      return 'Gracias por enviar su orden. No identificamos exámenes marcados. ¿Nos indica qué exámenes necesita? Un asesor también puede revisarla.';
  }
}
