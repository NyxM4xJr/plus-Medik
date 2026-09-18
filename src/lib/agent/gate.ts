import type { SupabaseClient } from '@supabase/supabase-js';

export interface AgentGateResult {
    allowed: boolean;
    conversationState: 'active' | 'paused';
    resumed: boolean;
    pauseExpiresAt: string | null;
}

export async function resolveAgentGate(
    supabase: SupabaseClient,
    conversationId: string,
): Promise<AgentGateResult> {
    const { data, error } = await supabase.rpc('resolve_agent_gate', {
        p_conversation_id: conversationId,
    });

    if (error) {
        throw new Error(`resolve_agent_gate: ${error.message}`);
    }

    const row = Array.isArray(data) ? data[0] : null;

    if (!row) {
        throw new Error('resolve_agent_gate: no_data');
    }

    return {
        allowed: row.allowed === true,
        conversationState: row.conversation_state,
        resumed: row.resumed === true,
        pauseExpiresAt: row.current_pause_expires_at ?? null,
    };
}