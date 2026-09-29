import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { parseProvider, type Provider } from '@/lib/prescription/analyze-command';
import { anthropicCreate, createClaudePrescriptionReader } from '@/lib/prescription/claude-reader';
import { createOpenAIPrescriptionReader, openaiCreate } from '@/lib/prescription/openai-reader';
import type { PrescriptionReader } from '@/lib/prescription/reader';

/**
 * Lector según PRESCRIPTION_PROVIDER, para los comandos locales. Nunca se
 * importa desde src/app (lo comprueba un test).
 */
export function createReaderFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): { provider: Provider; reader: PrescriptionReader } | { error: string } {
  const provider = parseProvider(env.PRESCRIPTION_PROVIDER);
  if ('error' in provider) return provider;

  if (provider.value === 'openai') {
    if (!env.OPENAI_API_KEY) return { error: 'Falta OPENAI_API_KEY en .env.local (o usa PRESCRIPTION_PROVIDER=anthropic).' };
    return {
      provider: 'openai',
      reader: createOpenAIPrescriptionReader(openaiCreate(new OpenAI({ apiKey: env.OPENAI_API_KEY }))),
    };
  }

  // Credenciales de Anthropic: ANTHROPIC_API_KEY o un perfil de `ant auth login`.
  return { provider: 'anthropic', reader: createClaudePrescriptionReader(anthropicCreate(new Anthropic())) };
}
