/**
 * Diagnóstico temporal del payload de Kapso.
 *
 * Produce únicamente:
 *  - payload_shape: rutas/claves existentes y su tipo. Nunca valores.
 *  - attribution_candidates: valores escalares de claves técnicas de atribución.
 *
 * Queda explícitamente fuera: contenido de mensajes, captions, nombres,
 * teléfonos, URLs de media y cualquier dato clínico.
 */

export const MAX_DEPTH = 6;
export const MAX_PATHS = 300;
export const MAX_ARRAY_SAMPLE = 3;
export const MAX_CANDIDATES = 40;
export const MAX_VALUE_LENGTH = 200;

export interface PayloadDiagnostics {
  payloadShape: Record<string, string>;
  attributionCandidates: Record<string, string>;
}

/**
 * Claves cuyo valor escalar sí capturamos, normalizadas sin guiones bajos
 * y en minúsculas para aceptar snake_case y camelCase.
 */
const ATTRIBUTION_KEYS = new Set([
  'ctwaclid',
  'sourceid',
  'sourceurl',
  'sourcetype',
  'sourceadid',
  'sourceplatform',
  'platform',
  'mediatype',
  'adid',
  'adsetid',
  'adgroupid',
  'campaignid',
  'fbclid',
  'referraltype',
]);

/** Claves que, aun siendo objeto, marcamos como referral en la forma del payload. */
const REFERRAL_KEY = 'referral';

type Json = unknown;

function normalizeKey(key: string): string {
  return key.replace(/[_-]/g, '').toLowerCase();
}

function typeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  const type = typeof value;
  if (type === 'object') return 'object';
  if (type === 'string') return 'string';
  if (type === 'number') return 'number';
  if (type === 'boolean') return 'boolean';
  return 'unknown';
}

function scalarValue(value: Json): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed.slice(0, MAX_VALUE_LENGTH);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

function joinPath(parent: string, key: string): string {
  return parent === '' ? key : `${parent}.${key}`;
}

/**
 * Recorre el payload acotando profundidad, número de rutas y tamaño de arrays.
 * Los arrays se describen con notación `clave[]` a partir de una muestra.
 */
export function buildPayloadDiagnostics(payload: Json): PayloadDiagnostics {
  const payloadShape: Record<string, string> = {};
  const attributionCandidates: Record<string, string> = {};
  const seen = new WeakSet<object>();
  let truncated = false;

  function walk(value: Json, path: string, depth: number, keyName: string): void {
    if (Object.keys(payloadShape).length >= MAX_PATHS) {
      truncated = true;
      return;
    }

    if (path !== '') {
      payloadShape[path] = typeOf(value);
    }

    const normalized = normalizeKey(keyName);

    if (ATTRIBUTION_KEYS.has(normalized)) {
      const captured = scalarValue(value);
      if (captured !== null && Object.keys(attributionCandidates).length < MAX_CANDIDATES) {
        attributionCandidates[path] = captured;
      }
    }

    if (value === null || typeof value !== 'object') return;

    // Ciclos: el payload llega de JSON.parse, pero el extractor es reutilizable.
    if (seen.has(value)) {
      payloadShape[path] = 'circular';
      return;
    }
    seen.add(value);

    if (depth >= MAX_DEPTH) {
      truncated = true;
      payloadShape[path] = `${typeOf(value)}:depth_limit`;
      seen.delete(value);
      return;
    }

    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_SAMPLE) truncated = true;
      value.slice(0, MAX_ARRAY_SAMPLE).forEach((item) => {
        walk(item, `${path}[]`, depth + 1, keyName);
      });
      seen.delete(value);
      return;
    }

    for (const [key, child] of Object.entries(value as Record<string, Json>)) {
      walk(child, joinPath(path, key), depth + 1, key);
    }

    // Solo protegemos contra ciclos en la rama actual, no entre hermanos.
    seen.delete(value);
  }

  walk(payload, '', 0, '');

  if (payload === null || typeof payload !== 'object') {
    payloadShape.__root = typeOf(payload);
  }

  if (truncated) payloadShape.__truncated = 'true';

  return { payloadShape, attributionCandidates };
}

/** true cuando el payload trae alguna señal de referral/publicidad. */
export function hasAttributionSignal(diagnostics: PayloadDiagnostics): boolean {
  if (Object.keys(diagnostics.attributionCandidates).length > 0) return true;
  return Object.keys(diagnostics.payloadShape).some((path) =>
    path.split(/[.[]/).some((segment) => normalizeKey(segment) === REFERRAL_KEY),
  );
}
