import { z } from 'zod';

/**
 * Lo que el modelo de visión devuelve al leer una orden de laboratorio.
 * Solo transcribe exámenes solicitados: la identificación contra el catálogo,
 * las decisiones y los precios se hacen después, en código.
 * Ver docs/BITACORA.md, «Recetas: lectura de imágenes».
 */

export const MARK_TYPES = ['tick', 'cross', 'highlight', 'circle', 'handwritten', 'other'] as const;
export type MarkType = (typeof MARK_TYPES)[number];

/** JSON Schema para output_config.format. Sin límites numéricos: los valida zod. */
export const PRESCRIPTION_READING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_lab_order', 'image_quality', 'issues', 'exams'],
  properties: {
    is_lab_order: {
      type: 'boolean',
      description: 'true si alguna imagen es una orden o receta de exámenes de laboratorio.',
    },
    image_quality: {
      type: 'number',
      description: 'Legibilidad general de las imágenes, de 0 a 1.',
    },
    issues: {
      type: 'array',
      items: { type: 'string' },
      description: 'Problemas de la imagen en frases cortas (borrosa, cortada, reflejo...).',
    },
    exams: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'interpretation', 'mark', 'confidence', 'image'],
        properties: {
          text: { type: 'string', description: 'El examen tal como aparece escrito.' },
          interpretation: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description: 'Nombre completo si es una sigla o abreviatura; null si no hace falta o hay duda.',
          },
          mark: { type: 'string', enum: [...MARK_TYPES] },
          confidence: {
            type: 'number',
            description: 'De 0 a 1: confianza en que está solicitado y en la lectura.',
          },
          image: { type: 'integer', description: 'Número de imagen (1 = primera).' },
        },
      },
    },
  },
} as const;

const unit = z.number().min(0).max(1);

export const prescriptionReadingSchema = z.object({
  is_lab_order: z.boolean(),
  image_quality: unit,
  issues: z.array(z.string()),
  exams: z.array(
    z.object({
      text: z.string().trim().min(1),
      interpretation: z
        .string()
        .trim()
        .nullable()
        .transform((value) => (value === '' ? null : value)),
      mark: z.enum(MARK_TYPES),
      confidence: unit,
      image: z.number().int().min(1),
    }),
  ),
});

export type PrescriptionReading = z.infer<typeof prescriptionReadingSchema>;
export type ReadExam = PrescriptionReading['exams'][number];

export const PRESCRIPTION_SYSTEM_PROMPT = `Lees fotos de órdenes médicas de laboratorio que los pacientes envían por WhatsApp a PlusMedik, un laboratorio clínico de Bolivia. Tu única tarea es transcribir qué exámenes están solicitados. No diagnosticas, no recomiendas exámenes y no calculas precios.

Qué cuenta como solicitado:
- En formularios impresos con listas de exámenes, solo los marcados: con visto o tick, cruz, resaltado o encerrado en un círculo. Los exámenes impresos sin marca NO están solicitados: no los incluyas.
- Exámenes escritos a mano por el médico como pedido (mark = "handwritten").
- Si una sola marca abarca un perfil o grupo con nombre (por ejemplo "perfil lipídico"), transcribe el nombre del grupo como un solo examen.
- Si una línea enumera exámenes distintos unidos por "+", "y" o comas, crea un objeto por examen; no los combines en una sola entrada. Por ejemplo, "Procalcitonina + PCR cuantitativo" son dos exámenes. Conserva los calificadores de cada uno (por ejemplo, cuantitativo) en su texto.

Cómo transcribir:
- text: el examen tal como aparece, sin corregirlo.
- interpretation: si es una sigla o abreviatura (por ejemplo "HC", "TSH", "PCR"), el nombre completo más probable; si no estás seguro o no hace falta, null.
- confidence: de 0 a 1, tu confianza en que el examen está solicitado y en que lo leíste bien. Bájala si la letra es difícil, la marca es dudosa o la imagen está cortada. No la subas para parecer seguro: un valor bajo hace que una persona lo confirme.
- image: el número de la imagen donde aparece (las imágenes vienen numeradas en orden).
- Si el mismo examen aparece dos veces, inclúyelo una sola vez.

Privacidad: no transcribas nombres, documentos de identidad, teléfonos, direcciones ni diagnósticos del paciente o del médico. Solo exámenes.

is_lab_order es false si ninguna imagen es una orden de exámenes (por ejemplo, una receta solo de medicamentos o una foto de otra cosa); en ese caso exams va vacío. image_quality es la legibilidad general de 0 a 1. issues enumera problemas concretos de las imágenes.`;
