const ACCENTED = 'áéíóúüñÁÉÍÓÚÜÑ';
const PLAIN = 'aeiouunAEIOUUN';

/**
 * Copia exacta de public.normalize_lab_text (migración 20260918043052_lab_catalog.sql).
 * Debe producir lo mismo que la base: el test normalize.sql.test.ts lo verifica.
 * Si cambia uno, cambia el otro.
 */
export function normalizeLabText(text: string | null | undefined): string {
  let translated = '';
  for (const char of text ?? '') {
    const index = ACCENTED.indexOf(char);
    translated += index >= 0 ? PLAIN[index] : char;
  }

  return translated
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
