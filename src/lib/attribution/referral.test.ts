import { describe, expect, it } from 'vitest';
import { extractReferralAttribution } from './referral';

const base = {
  phone_number_id: 'pn-1',
  conversation: { id: 'conv-1', phone_number: '+591 700-00001' },
};

function inbound(message: Record<string, unknown>) {
  return {
    ...base,
    message: {
      id: 'wamid.in',
      type: 'text',
      timestamp: 1_780_000_000,
      from: '59170000001',
      text: { body: 'Hola, quiero un examen' },
      kapso: { direction: 'inbound' },
      ...message,
    },
  };
}

describe('extractReferralAttribution', () => {
  it('devuelve null cuando no hay datos de referral', () => {
    expect(extractReferralAttribution(inbound({}))).toBeNull();
  });

  it('devuelve null para payloads no objeto', () => {
    expect(extractReferralAttribution(null)).toBeNull();
    expect(extractReferralAttribution('referral')).toBeNull();
    expect(extractReferralAttribution([{ referral: { ctwa_clid: 'abc' } }])).toBeNull();
  });

  it('clasifica como ctwa_ad cuando hay ctwa_clid', () => {
    const result = extractReferralAttribution(
      inbound({
        referral: {
          ctwa_clid: 'ctwa-123',
          source_id: '120200000000000',
          source_url: 'https://fb.me/ad',
          source_type: 'ad',
          source_platform: 'instagram',
        },
      }),
    );

    expect(result).not.toBeNull();
    expect(result?.sourceType).toBe('ctwa_ad');
    expect(result?.ctwaClid).toBe('ctwa-123');
    expect(result?.sourceId).toBe('120200000000000');
    expect(result?.sourceUrl).toBe('https://fb.me/ad');
    expect(result?.sourcePlatform).toBe('instagram');
  });

  it('clasifica como referral_other cuando hay referral sin ctwa_clid', () => {
    const result = extractReferralAttribution(
      inbound({ referral: { source_id: 'post-9', source_type: 'post' } }),
    );

    expect(result?.sourceType).toBe('referral_other');
    expect(result?.ctwaClid).toBeNull();
    expect(result?.sourceId).toBe('post-9');
  });

  it('encuentra el referral dentro de context', () => {
    const result = extractReferralAttribution(
      inbound({ context: { referral: { ctwa_clid: 'ctwa-ctx' } } }),
    );

    expect(result?.sourceType).toBe('ctwa_ad');
    expect(result?.ctwaClid).toBe('ctwa-ctx');
  });

  it('encuentra el referral dentro de kapso', () => {
    const result = extractReferralAttribution(
      inbound({
        kapso: { direction: 'inbound', referral: { source_id: 'ad-7', source_url: 'https://x' } },
      }),
    );

    expect(result?.sourceType).toBe('referral_other');
    expect(result?.sourceId).toBe('ad-7');
  });

  it('acepta un ctwa_clid suelto sin objeto referral', () => {
    const result = extractReferralAttribution(
      inbound({ kapso: { direction: 'inbound', ctwa_clid: 'ctwa-suelto' } }),
    );

    expect(result?.sourceType).toBe('ctwa_ad');
    expect(result?.ctwaClid).toBe('ctwa-suelto');
  });

  it('acepta referral en la raíz del payload', () => {
    const result = extractReferralAttribution({
      ...inbound({}),
      referral: { ctwa_clid: 'ctwa-root', source_platform: 'fb' },
    });

    expect(result?.ctwaClid).toBe('ctwa-root');
    expect(result?.sourcePlatform).toBe('facebook');
  });

  it('normaliza plataformas desconocidas a other y unknown a null', () => {
    const otra = extractReferralAttribution(
      inbound({ referral: { ctwa_clid: 'c1', source_platform: 'tiktok' } }),
    );
    const desconocida = extractReferralAttribution(
      inbound({ referral: { ctwa_clid: 'c2', source_platform: 'unknown' } }),
    );
    const sinPlataforma = extractReferralAttribution(inbound({ referral: { ctwa_clid: 'c3' } }));

    expect(otra?.sourcePlatform).toBe('other');
    expect(desconocida?.sourcePlatform).toBeNull();
    expect(sinPlataforma?.sourcePlatform).toBeNull();
  });

  it('solo guarda campos técnicos en rawReferral', () => {
    const result = extractReferralAttribution(
      inbound({
        referral: {
          ctwa_clid: 'ctwa-1',
          source_id: 'ad-1',
          source_url: 'https://fb.me/ad',
          source_type: 'ad',
          media_type: 'image',
          headline: 'Perfil lipídico 50% off',
          body: 'Texto del anuncio',
          welcome_message: 'Hola, tengo diabetes y quiero cotizar',
          thumbnail_url: 'https://cdn/thumb.jpg',
        },
      }),
    );

    expect(result?.rawReferral).toEqual({
      ctwa_clid: 'ctwa-1',
      source_id: 'ad-1',
      source_url: 'https://fb.me/ad',
      source_type: 'ad',
      media_type: 'image',
    });
  });

  it('nunca arrastra el contenido del mensaje', () => {
    const result = extractReferralAttribution(
      inbound({ referral: { ctwa_clid: 'ctwa-1' } }),
    );

    expect(JSON.stringify(result)).not.toContain('quiero un examen');
    expect(result?.rawReferral).toEqual({ ctwa_clid: 'ctwa-1' });
  });

  it('ignora valores vacíos o no escalares', () => {
    const result = extractReferralAttribution(
      inbound({
        referral: {
          source_id: '   ',
          source_url: { nested: true },
          source_type: 'ad',
        },
      }),
    );

    expect(result?.sourceType).toBe('referral_other');
    expect(result?.sourceId).toBeNull();
    expect(result?.sourceUrl).toBeNull();
    expect(result?.rawReferral).toEqual({ source_type: 'ad' });
  });

  it('acepta source_id numérico y lo normaliza a texto', () => {
    const result = extractReferralAttribution(
      inbound({ referral: { source_id: 120200000000000, ctwa_clid: 'ctwa-n' } }),
    );

    expect(result?.sourceId).toBe('120200000000000');
  });

  it('prioriza el referral del mensaje sobre el de la conversación', () => {
    const payload = {
      ...inbound({ referral: { ctwa_clid: 'ctwa-mensaje' } }),
      conversation: { ...base.conversation, referral: { ctwa_clid: 'ctwa-conversacion' } },
    };

    expect(extractReferralAttribution(payload)?.ctwaClid).toBe('ctwa-mensaje');
  });
});
