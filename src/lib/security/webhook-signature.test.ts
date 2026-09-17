import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyKapsoSignature } from './webhook-signature';

describe('verifyKapsoSignature', () => {
  it('acepta la firma HMAC SHA-256 correcta', () => {
    const body = '{"ok":true}';
    const secret = 'secret-test';
    const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(verifyKapsoSignature(body, signature, secret)).toBe(true);
  });

  it('rechaza firma inválida', () => {
    expect(verifyKapsoSignature('{}', '00'.repeat(32), 'secret-test')).toBe(false);
  });
});
