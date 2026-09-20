export type AttributionSourceType = 'ctwa_ad' | 'referral_other';

export type AttributionPlatform = 'facebook' | 'instagram' | 'whatsapp' | 'other';

export interface ReferralAttribution {
  sourceType: AttributionSourceType;
  sourcePlatform: AttributionPlatform | null;
  sourceId: string | null;
  sourceUrl: string | null;
  ctwaClid: string | null;
  /**
   * Subconjunto técnico del referral encontrado.
   * Nunca el payload completo ni contenido del mensaje.
   */
  rawReferral: Record<string, unknown>;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Claves técnicas de atribución que sí guardamos.
 * Se excluye a propósito cualquier texto libre (body, headline, welcome_message)
 * para no arrastrar contenido del mensaje ni datos del paciente.
 */
const TECHNICAL_KEYS = [
  'ctwa_clid',
  'ctwaClid',
  'source_id',
  'source_ad_id',
  'source_url',
  'source_type',
  'source_platform',
  'platform',
  'media_type',
  'ad_id',
  'adset_id',
  'campaign_id',
] as const;

const CTWA_CLID_KEYS = ['ctwa_clid', 'ctwaClid'] as const;
const SOURCE_ID_KEYS = ['source_id', 'source_ad_id', 'ad_id'] as const;
const SOURCE_URL_KEYS = ['source_url'] as const;
const PLATFORM_KEYS = ['source_platform', 'platform'] as const;

const KNOWN_PLATFORMS = new Set<AttributionPlatform>([
  'facebook',
  'instagram',
  'whatsapp',
  'other',
]);

function firstString(source: Rec, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = str(source[key]);
    if (value) return value;
  }
  return null;
}

function normalizePlatform(value: string | null): AttributionPlatform | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === '' || normalized === 'unknown') return null;
  if (normalized === 'fb' || normalized === 'facebook') return 'facebook';
  if (normalized === 'ig' || normalized === 'instagram') return 'instagram';
  if (normalized === 'wa' || normalized === 'whatsapp') return 'whatsapp';
  return KNOWN_PLATFORMS.has(normalized as AttributionPlatform)
    ? (normalized as AttributionPlatform)
    : 'other';
}

/**
 * Rutas conocidas donde puede venir el referral de un Click-to-WhatsApp.
 * Búsqueda acotada a propósito: no recorremos el payload completo.
 */
function referralCandidates(payload: unknown): Rec[] {
  const root = rec(payload);
  if (!root) return [];

  const message = rec(root.message);
  const kapso = rec(message?.kapso);
  const context = rec(message?.context);
  const conversation = rec(root.conversation);

  const candidates = [
    rec(message?.referral),
    rec(context?.referral),
    rec(kapso?.referral),
    rec(root.referral),
    rec(conversation?.referral),
    rec(rec(root.metadata)?.referral),
    // ctwa_clid suelto, sin objeto referral
    kapso,
    message,
    conversation,
    root,
  ];

  return candidates.filter((candidate): candidate is Rec => candidate !== undefined);
}

function pickTechnicalFields(source: Rec): Rec {
  const picked: Rec = {};
  for (const key of TECHNICAL_KEYS) {
    const value = str(source[key]);
    if (value) picked[key] = value;
  }
  return picked;
}

/**
 * Extrae atribución de referral de un payload entrante.
 * Devuelve null cuando no hay ningún dato de referral utilizable.
 */
export function extractReferralAttribution(payload: unknown): ReferralAttribution | null {
  const candidates = referralCandidates(payload);

  let ctwaClid: string | null = null;
  let sourceId: string | null = null;
  let sourceUrl: string | null = null;
  let platform: string | null = null;
  const rawReferral: Rec = {};

  for (const candidate of candidates) {
    const isReferralObject =
      candidate.source_id !== undefined ||
      candidate.source_url !== undefined ||
      candidate.source_type !== undefined ||
      candidate.source_ad_id !== undefined ||
      CTWA_CLID_KEYS.some((key) => candidate[key] !== undefined);

    if (!isReferralObject) continue;

    ctwaClid = ctwaClid ?? firstString(candidate, CTWA_CLID_KEYS);
    sourceId = sourceId ?? firstString(candidate, SOURCE_ID_KEYS);
    sourceUrl = sourceUrl ?? firstString(candidate, SOURCE_URL_KEYS);
    platform = platform ?? firstString(candidate, PLATFORM_KEYS);

    for (const [key, value] of Object.entries(pickTechnicalFields(candidate))) {
      if (rawReferral[key] === undefined) rawReferral[key] = value;
    }
  }

  if (Object.keys(rawReferral).length === 0) return null;

  return {
    sourceType: ctwaClid ? 'ctwa_ad' : 'referral_other',
    sourcePlatform: normalizePlatform(platform),
    sourceId,
    sourceUrl,
    ctwaClid,
    rawReferral,
  };
}
