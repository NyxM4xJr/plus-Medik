import { createHmac, timingSafeEqual } from 'node:crypto';

const HEX_SHA256 = /^[a-f0-9]{64}$/i;

export function verifyKapsoSignature(
  rawBody: string,
  providedSignature: string | null,
  secret: string,
): boolean {
  if (!secret || !providedSignature || !HEX_SHA256.test(providedSignature)) return false;

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(providedSignature.toLowerCase(), 'hex');

  return expectedBuffer.length === providedBuffer.length && timingSafeEqual(expectedBuffer, providedBuffer);
}
