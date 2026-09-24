import { describe, expect, it } from 'vitest';
import { parseKapsoProvenance } from './provenance';

const base = {
  phone_number_id: 'pn-1',
  conversation: { id: 'conv-1', phone_number: '+591 700-00001' },
};

describe('parseKapsoProvenance', () => {
  it('clasifica un entrante como customer', () => {
    const result = parseKapsoProvenance('whatsapp.message.received', {
      ...base,
      message: {
        id: 'wamid.in',
        type: 'text',
        timestamp: 1_780_000_000,
        from: '59170000001',
        text: { body: 'Hola' },
        kapso: { direction: 'inbound' },
      },
    });

    expect(result.kind).toBe('customer_inbound');
    if (result.kind === 'customer_inbound') {
      expect(result.message.actor).toBe('customer');
      expect(result.message.customerPhone).toBe('59170000001');
      expect(result.message.content).toBe('Hola');
    }
  });

  it('solo considera humano un sent outbound origin business_app', () => {
    const result = parseKapsoProvenance('whatsapp.message.sent', {
      ...base,
      message: {
        id: 'wamid.human',
        type: 'text',
        timestamp: 1_780_000_000,
        to: '59170000001',
        text: { body: 'Le ayudo enseguida' },
        kapso: { direction: 'outbound', origin: 'business_app' },
      },
    });

    expect(result.kind).toBe('human_outbound');
  });

  it('clasifica cloud_api como automatización y no como humano', () => {
    const result = parseKapsoProvenance('whatsapp.message.sent', {
      ...base,
      message: {
        id: 'wamid.api',
        type: 'text',
        timestamp: 1_780_000_000,
        to: '59170000001',
        text: { body: 'Mensaje automático' },
        kapso: { direction: 'outbound', origin: 'cloud_api' },
      },
    });

    expect(result.kind).toBe('system_outbound');
  });

  it('un delivered nunca dispara takeover aunque diga business_app', () => {
    const result = parseKapsoProvenance('whatsapp.message.delivered', {
      ...base,
      message: {
        id: 'wamid.human',
        kapso: { direction: 'outbound', origin: 'business_app' },
      },
    });

    expect(result.kind).toBe('lifecycle');
  });
});

function received(message: Record<string, unknown>) {
  const result = parseKapsoProvenance('whatsapp.message.received', {
    ...base,
    message: {
      timestamp: '1780000000',
      from: '59170000001',
      kapso: { direction: 'inbound' },
      ...message,
    },
  });
  if (result.kind !== 'customer_inbound') throw new Error(`kind inesperado: ${result.kind}`);
  return result.message;
}

describe('parseKapsoProvenance con texto y adjuntos', () => {
  it('un texto no tiene adjunto', () => {
    const message = received({ id: 'wamid.t', type: 'text', text: { body: 'Hola' } });

    expect(message.contentType).toBe('text');
    expect(message.content).toBe('Hola');
    expect(message.attachment).toBeNull();
    expect(message.metadata).toBeNull();
  });

  it('una imagen con pie de foto guarda el pie como contenido y el archivo como adjunto', () => {
    const message = received({
      id: 'wamid.img',
      type: 'image',
      image: {
        id: 'media-1',
        mime_type: 'image/jpeg',
        sha256: 'abc123',
        caption: 'Receta del doctor',
      },
    });

    expect(message.content).toBe('Receta del doctor');
    expect(message.attachment).toEqual({
      kind: 'image',
      providerMediaId: 'media-1',
      mimeType: 'image/jpeg',
      filename: null,
      sha256: 'abc123',
      fileSizeBytes: null,
    });
  });

  it('una imagen sin pie de foto sigue registrando el adjunto', () => {
    const message = received({
      id: 'wamid.img2',
      type: 'image',
      image: { id: 'media-2', mime_type: 'image/jpeg' },
    });

    expect(message.content).toBeNull();
    expect(message.attachment?.providerMediaId).toBe('media-2');
  });

  it('un documento conserva nombre de archivo y tamaño', () => {
    const message = received({
      id: 'wamid.doc',
      type: 'document',
      document: {
        id: 'media-3',
        mime_type: 'application/pdf',
        filename: 'orden_laboratorio.pdf',
        file_size: '48213',
      },
    });

    expect(message.attachment).toMatchObject({
      kind: 'document',
      filename: 'orden_laboratorio.pdf',
      mimeType: 'application/pdf',
      fileSizeBytes: 48213,
    });
    expect(message.metadata).toMatchObject({ has_media: true, filename: 'orden_laboratorio.pdf' });
  });

  it('reconoce sticker como adjunto', () => {
    const message = received({
      id: 'wamid.stk',
      type: 'sticker',
      sticker: { id: 'media-4', mime_type: 'image/webp' },
    });

    expect(message.attachment?.kind).toBe('sticker');
    expect(message.metadata).toMatchObject({ has_media: true, media_id: 'media-4' });
  });

  it('usa kapso.media_data como respaldo y nunca guarda la URL', () => {
    const message = received({
      id: 'wamid.kmedia',
      type: 'image',
      kapso: {
        direction: 'inbound',
        has_media: true,
        media_url: 'https://cdn.example/secret.jpg',
        media_data: {
          url: 'https://cdn.example/secret.jpg',
          content_type: 'image/png',
          filename: 'foto.png',
          byte_size: 1024,
        },
      },
    });

    expect(message.attachment).toEqual({
      kind: 'image',
      providerMediaId: null,
      mimeType: 'image/png',
      filename: 'foto.png',
      sha256: null,
      fileSizeBytes: 1024,
    });
    expect(JSON.stringify(message.attachment)).not.toContain('cdn.example');
  });

  it('descarta tamaños inválidos', () => {
    const message = received({
      id: 'wamid.bad',
      type: 'document',
      document: { id: 'media-5', file_size: -1 },
    });

    expect(message.attachment?.fileSizeBytes).toBeNull();
  });

  it('una receta de tres imágenes produce tres adjuntos independientes y en orden', () => {
    const pages = [1, 2, 3].map((page) =>
      received({
        id: `wamid.receta.${page}`,
        type: 'image',
        timestamp: String(1_780_000_000 + page),
        image: { id: `media-receta-${page}`, mime_type: 'image/jpeg' },
      }),
    );

    expect(pages.map((p) => p.attachment?.providerMediaId)).toEqual([
      'media-receta-1',
      'media-receta-2',
      'media-receta-3',
    ]);
    expect(pages.map((p) => p.messageTimestamp)).toEqual([
      '2026-05-28T20:26:41.000Z',
      '2026-05-28T20:26:42.000Z',
      '2026-05-28T20:26:43.000Z',
    ]);
    expect(new Set(pages.map((p) => p.customerPhone))).toEqual(new Set(['59170000001']));
  });
});
