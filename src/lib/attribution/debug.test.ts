import { describe, expect, it } from 'vitest';
import {
  MAX_ARRAY_SAMPLE,
  MAX_DEPTH,
  MAX_PATHS,
  MAX_VALUE_LENGTH,
  buildPayloadDiagnostics,
  hasAttributionSignal,
} from './debug';

const inboundPayload = {
  phone_number_id: 'pn-1',
  conversation: { id: 'conv-1', phone_number: '+591 700-00001', contact_name: 'Juana Pérez' },
  message: {
    id: 'wamid.in',
    type: 'text',
    timestamp: 1_780_000_000,
    from: '59170000001',
    text: { body: 'Hola, tengo diabetes y quiero un perfil lipídico' },
    kapso: { direction: 'inbound' },
  },
};

describe('buildPayloadDiagnostics', () => {
  it('registra rutas con su tipo y nunca los valores', () => {
    const { payloadShape } = buildPayloadDiagnostics(inboundPayload);

    expect(payloadShape['phone_number_id']).toBe('string');
    expect(payloadShape['message.text.body']).toBe('string');
    expect(payloadShape['message.timestamp']).toBe('number');
    expect(payloadShape['conversation']).toBe('object');

    const serialized = JSON.stringify(payloadShape);
    expect(serialized).not.toContain('diabetes');
    expect(serialized).not.toContain('59170000001');
    expect(serialized).not.toContain('Juana');
    expect(serialized).not.toContain('wamid.in');
  });

  it('no captura candidatos cuando no hay claves de atribución', () => {
    const { attributionCandidates } = buildPayloadDiagnostics(inboundPayload);
    expect(attributionCandidates).toEqual({});
  });

  it('captura valores técnicos de atribución con su ruta', () => {
    const { attributionCandidates } = buildPayloadDiagnostics({
      ...inboundPayload,
      message: {
        ...inboundPayload.message,
        referral: {
          ctwa_clid: 'ctwa-123',
          source_id: '120200000000000',
          source_url: 'https://fb.me/ad',
          source_type: 'ad',
          headline: 'Perfil lipídico 50% off',
          body: 'Texto del anuncio',
        },
      },
    });

    expect(attributionCandidates).toEqual({
      'message.referral.ctwa_clid': 'ctwa-123',
      'message.referral.source_id': '120200000000000',
      'message.referral.source_url': 'https://fb.me/ad',
      'message.referral.source_type': 'ad',
    });
  });

  it('acepta camelCase y claves de campaña', () => {
    const { attributionCandidates } = buildPayloadDiagnostics({
      tracking: { ctwaClid: 'c-1', campaignId: 'camp-1', adgroupId: 'ag-1', fbclid: 'fb-1' },
    });

    expect(attributionCandidates).toEqual({
      'tracking.ctwaClid': 'c-1',
      'tracking.campaignId': 'camp-1',
      'tracking.adgroupId': 'ag-1',
      'tracking.fbclid': 'fb-1',
    });
  });

  it('ignora claves no relacionadas aunque contengan texto sensible', () => {
    const { attributionCandidates } = buildPayloadDiagnostics({
      message: { caption: 'Resultado de laboratorio', name: 'Juana', media_url: 'https://cdn/x' },
    });

    expect(attributionCandidates).toEqual({});
  });

  it('no captura valores no escalares ni cadenas vacías', () => {
    const { attributionCandidates } = buildPayloadDiagnostics({
      referral: { source_id: { nested: 'x' }, source_url: '   ', source_type: 'ad' },
    });

    expect(attributionCandidates).toEqual({ 'referral.source_type': 'ad' });
  });

  it('trunca valores largos', () => {
    const { attributionCandidates } = buildPayloadDiagnostics({
      referral: { source_url: `https://fb.me/${'a'.repeat(500)}` },
    });

    expect(attributionCandidates['referral.source_url']).toHaveLength(MAX_VALUE_LENGTH);
  });

  it('limita la profundidad', () => {
    let deep: Record<string, unknown> = { ctwa_clid: 'muy-profundo' };
    for (let i = 0; i < 12; i += 1) deep = { [`n${i}`]: deep };

    const { payloadShape } = buildPayloadDiagnostics(deep);
    const maxSegments = Math.max(...Object.keys(payloadShape).map((p) => p.split('.').length));

    expect(maxSegments).toBeLessThanOrEqual(MAX_DEPTH);
    expect(payloadShape.__truncated).toBe('true');
    expect(Object.values(payloadShape).some((t) => t.endsWith(':depth_limit'))).toBe(true);
  });

  it('muestrea arrays y marca truncado', () => {
    const { payloadShape } = buildPayloadDiagnostics({
      entries: Array.from({ length: 50 }, (_, i) => ({ id: `e${i}` })),
    });

    expect(payloadShape.entries).toBe('array(50)');
    expect(payloadShape['entries[].id']).toBe('string');
    expect(payloadShape.__truncated).toBe('true');
  });

  it('no marca truncado un array dentro del límite de muestra', () => {
    const { payloadShape } = buildPayloadDiagnostics({
      entries: Array.from({ length: MAX_ARRAY_SAMPLE }, (_, i) => ({ id: `e${i}` })),
    });

    expect(payloadShape.__truncated).toBeUndefined();
  });

  it('limita el número total de rutas', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < MAX_PATHS * 2; i += 1) wide[`k${i}`] = 'v';

    const { payloadShape } = buildPayloadDiagnostics(wide);

    expect(Object.keys(payloadShape).length).toBeLessThanOrEqual(MAX_PATHS + 1);
    expect(payloadShape.__truncated).toBe('true');
  });

  it('maneja payloads no objeto y valores nulos', () => {
    expect(buildPayloadDiagnostics(null).payloadShape).toEqual({ __root: 'null' });
    expect(buildPayloadDiagnostics('texto').payloadShape).toEqual({ __root: 'string' });
    expect(buildPayloadDiagnostics({ a: null }).payloadShape).toEqual({ a: 'null' });
  });

  it('no se cuelga con referencias circulares', () => {
    const node: Record<string, unknown> = { id: 'n1' };
    node.self = node;

    const { payloadShape } = buildPayloadDiagnostics({ node });

    expect(payloadShape['node.self']).toBe('circular');
  });

  it('describe hermanos repetidos sin marcarlos como circulares', () => {
    const shared = { source_type: 'ad' };
    const { payloadShape } = buildPayloadDiagnostics({ a: shared, b: shared });

    expect(payloadShape['a.source_type']).toBe('string');
    expect(payloadShape['b.source_type']).toBe('string');
  });
});

describe('hasAttributionSignal', () => {
  it('es falso para un payload sin referral', () => {
    expect(hasAttributionSignal(buildPayloadDiagnostics(inboundPayload))).toBe(false);
  });

  it('es verdadero cuando hay candidatos', () => {
    expect(hasAttributionSignal(buildPayloadDiagnostics({ ctwa_clid: 'c-1' }))).toBe(true);
  });

  it('es verdadero cuando existe un objeto referral aunque venga vacío', () => {
    expect(hasAttributionSignal(buildPayloadDiagnostics({ message: { referral: {} } }))).toBe(true);
  });
});
