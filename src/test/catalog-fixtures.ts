/**
 * Tarifas por defecto de los tests del catálogo. Las filas CSV de los tests
 * escriben las siete columnas base (code…notes) y withTariffs agrega al final
 * price_convenio_bs, price_medicos_bs y price_emergencia_bs, en el orden de
 * CATALOG_COLUMNS. Los exámenes existentes usan los mismos valores, así una
 * fila sin cambios sigue saliendo unchanged.
 */
export const DEFAULT_TARIFFS = {
  priceConvenioBs: 30,
  priceMedicosBs: 40,
  priceEmergenciaBs: 60,
} as const;

export const TARIFF_SUFFIX = `,${DEFAULT_TARIFFS.priceConvenioBs},${DEFAULT_TARIFFS.priceMedicosBs},${DEFAULT_TARIFFS.priceEmergenciaBs}`;

export function withTariffs(row: string): string {
  return `${row}${TARIFF_SUFFIX}`;
}
