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
