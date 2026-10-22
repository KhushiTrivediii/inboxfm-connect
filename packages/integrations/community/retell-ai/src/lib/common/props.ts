import { Property } from '@inboxfm-connect/pieces-framework';
import { HttpMethod } from '@inboxfm-connect/pieces-common';
import { retellAiApiCall } from './client';
import { PiecePropValueSchema } from '@inboxfm-connect/pieces-framework';
import { retellAiAuth } from './auth';

interface RetellAiAgent {
  agent_id: string;
  version: number;
  is_published: boolean;
  agent_name: string;
  voice_id: string;
  voice_model?: string;
  fallback_voice_ids?: string[];
  voice_temperature?: number;
  voice_speed?: number;
  volume?: number;
  responsiveness?: number;
  interruption_sensitivity?: number;
  enable_backchannel?: boolean;
  backchannel_frequency?: number;
  backchannel_words?: string[];
  reminder_trigger_ms?: number;
  reminder_max_count?: number;
  ambient_sound?: string;
  ambient_sound_volume?: number;
  language?: string;
  webhook_url?: string;
  boosted_keywords?: string[];
  opt_out_sensitive_data_storage?: boolean;
  opt_in_signed_url?: boolean;
  pronunciation_dictionary?: Array<{
    word: string;
    alphabet: string;
    phoneme: string;
  }>;
  normalize_for_speech?: boolean;
  end_call_after_silence_ms?: number;
  max_call_duration_ms?: number;
  voicemail_option?: {
    action: {
      type: string;
      text: string;
    };
  };
  post_call_analysis_data?: Array<{
    type: string;
    name: string;
    description: string;
    examples: string[];
  }>;
  post_call_analysis_model?: string;
  begin_message_delay_ms?: number;
  ring_duration_ms?: number;
  stt_mode?: string;
  vocab_specialization?: string;
  allow_user_dtmf?: boolean;
  user_dtmf_options?: {
    digit_limit: number;
    termination_key: string;
    timeout_ms: number;
  };
  denoising_mode?: string;
  last_modification_timestamp?: number;
  response_engine?: {
    type: string;
    llm_id: string;
    version: number;
  };
}

// Retell removed GET /list-agents on 2026-07-31. The unified replacement is
// POST /v2/list-agents, which serves both voice and chat agents and returns the
// paginated envelope rather than a top-level array.
type RetellAiAgentListResponse = {
  items?: RetellAiAgent[];
  has_more?: boolean;
  pagination_key?: string;
};

// Retell caps `limit` at 1000; 100 keeps each response small while still
// covering the overwhelming majority of workspaces in a single request.
const AGENT_PAGE_SIZE = 100
// Safety bound on the pagination loop - a dropdown is not worth unbounded paging.
const MAX_AGENT_PAGES = 20

interface RetellAiCall {
  call_id: string;
  agent_id: string;
  call_status: string;
  call_type: string;
  start_timestamp?: number;
  end_timestamp?: number;
}

interface RetellAiVoice {
  voice_id: string;
  voice_name: string;
  provider: string;
  gender: string;
  accent?: string;
  age?: string;
}

// --- Agent Dropdown ---
export const agentIdDropdown = (displayName:string,required=false)=>  Property.Dropdown({
  auth: retellAiAuth,
  displayName,
  description: 'Select the Retell AI agent.',
  required,
  refreshers: [],
  options: async ({ auth }) => {
    if (!auth) {
      return {
        disabled: true,
        options: [],
        placeholder: 'Connect your Retell AI account first',
      };
    }
    try {
      // `limit` is a query parameter on v2 (the body schema documents only
      // filter_criteria), and v2 lists voice AND chat agents - filter to voice so
      // this dropdown keeps its pre-migration behaviour.
      // v2 is paginated: results arrive in pages with has_more + pagination_key.
      // Walk them so a workspace with more than one page of voice agents can
      // still select them. Bounded so a malformed cursor can never spin.
      const agentList: RetellAiAgent[] = [];
      let paginationKey: string | undefined
      let exhaustedBound = false
      for (let page = 0; page < MAX_AGENT_PAGES; page++) {
        const query = paginationKey
          ? `?limit=${AGENT_PAGE_SIZE}&pagination_key=${encodeURIComponent(paginationKey)}`
          : `?limit=${AGENT_PAGE_SIZE}`
        const response = await retellAiApiCall<RetellAiAgentListResponse>({
          auth,
          method: HttpMethod.POST,
          url: `/v2/list-agents${query}`,
          body: {
            filter_criteria: {
              channel: {
                type: 'string',
                op: 'eq',
                value: 'voice',
              },
            },
          },
        })
        if (Array.isArray(response?.items)) {
          agentList.push(...response.items)
        }
        // Stop when the API says there is no more, or when it hands back a
        // cursor we have already followed (guards against a repeat-key loop).
        if (!response?.has_more || !response.pagination_key || response.pagination_key === paginationKey) {
          break
        }
        paginationKey = response.pagination_key
        // The API still had more after the final permitted page, so the dropdown
        // is showing a truncated list. Say so - a silently short dropdown is
        // indistinguishable from a workspace that genuinely has few agents.
        if (page === MAX_AGENT_PAGES - 1) {
          exhaustedBound = true
        }
      }
      if (exhaustedBound) {
        console.warn(
          `[retell-ai] agent dropdown stopped at the ${MAX_AGENT_PAGES}-page bound `
          + `(${agentList.length} agents loaded); more voice agents exist. `
          + 'Raise MAX_AGENT_PAGES if this workspace needs them.',
        )
      }
      if (agentList.length === 0) {
        return {
          disabled: true,
          options: [],
          placeholder: 'No agents found in your workspace.',
        };
      }
      return {
        disabled: false,
        options: agentList.map((agent) => ({
          label: `${agent.agent_name || 'Unnamed Agent'} (${agent.agent_id})`,
          value: agent.agent_id,
        })),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        disabled: true,
        options: [],
        placeholder: `Error loading agents: ${errorMessage}`,
      };
    }
  },
});

// --- Call ID Dropdown ---
export const callIdDropdown =  Property.Dropdown({
  auth: retellAiAuth,
  displayName: 'Call ID',
  required: true,
  refreshers: ['auth'],
  options: async ({ auth }) => {
    if (!auth) {
      return {
        disabled: true,
        options: [],
        placeholder: 'Connect your Retell AI account first',
      };
    }
    try {
      const response = await retellAiApiCall<RetellAiCall[]>({
       auth,
        method: HttpMethod.POST,
        url: '/v2/list-calls',
        body: {
          limit: 50,
          sort_order: 'descending'
        }
      });
      
      if (!response || response.length === 0) {
        return {
          disabled: true,
          options: [],
          placeholder: 'No calls found in your workspace.',
        };
      }
      
      return {
        disabled: false,
        options: response.map((call) => ({
          label: `${call.call_id} (${call.call_status} - ${call.call_type})`,
          value: call.call_id,
        })),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        disabled: true,
        options: [],
        placeholder: `Error loading calls: ${errorMessage}`,
      };
    }
  },
});

// --- Voice Dropdown ---
export const voiceIdDropdown =  Property.Dropdown({
  auth: retellAiAuth,
  displayName: 'Voice',
  required: true,
  refreshers: ['auth'],
  options: async ({ auth }) => {
    if (!auth) {
      return {
        disabled: true,
        options: [],
        placeholder: 'Connect your Retell AI account first',
      };
    }
    try {
      const response = await retellAiApiCall<RetellAiVoice[]>({
       auth,
        method: HttpMethod.GET,
        url: '/list-voices',
      });
      const voices = response;
      if (voices.length === 0) {
        return {
          disabled: true,
          options: [],
          placeholder: 'No voices found in your workspace.',
        };
      }
      return {
        disabled: false,
        options: voices.map((voice) => {
          const voiceInfo = voice.accent ? `${voice.gender}, ${voice.accent}` : voice.gender;
          return {
            label: `${voice.voice_name} (${voiceInfo})`,
            value: voice.voice_id,
          };
        }),
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred';
      return {
        disabled: true,
        options: [],
        placeholder: `Error loading voices: ${errorMessage}`,
      };
    }
  },
});

// --- Number Provider Dropdown ---
export const numberProviderDropdown = Property.StaticDropdown({
  displayName: 'Number Provider',
  description: 'The provider to purchase the phone number from.',
  required: false,
  options: {
    options: [
      { label: 'Twilio', value: 'twilio' },
      { label: 'Telnyx', value: 'telnyx' },
    ],
  },
  defaultValue: 'twilio',
});

// --- Language Dropdown ---
export const languageDropdown = Property.StaticDropdown({
  displayName: 'Language',
  description: 'The language for the agent to use.',
  required: false,
  options: {
    options: [
      { label: 'English (US)', value: 'en-US' },
      { label: 'English (UK)', value: 'en-GB' },
      { label: 'Spanish', value: 'es-ES' },
      { label: 'French', value: 'fr-FR' },
      { label: 'German', value: 'de-DE' },
      { label: 'Italian', value: 'it-IT' },
      { label: 'Portuguese', value: 'pt-PT' },
      { label: 'Dutch', value: 'nl-NL' },
      { label: 'Japanese', value: 'ja-JP' },
      { label: 'Chinese (Mandarin)', value: 'zh-CN' },
    ],
  },
  defaultValue: 'en-US',
});

// --- STT Mode Dropdown ---
export const sttModeDropdown = Property.StaticDropdown({
  displayName: 'Speech-to-Text Mode',
  description: 'The speech-to-text mode for the agent.',
  required: false,
  options: {
    options: [
      { label: 'Fast', value: 'fast' },
      { label: 'Standard', value: 'standard' },
    ],
  },
  defaultValue: 'fast',
});

// --- Denoising Mode Dropdown ---
export const denoisingModeDropdown = Property.StaticDropdown({
  displayName: 'Denoising Mode',
  description: 'The denoising mode for audio processing.',
  required: false,
  options: {
    options: [
      { label: 'Noise Cancellation', value: 'noise-cancellation' },
      { label: 'None', value: 'none' },
    ],
  },
  defaultValue: 'noise-cancellation',
});