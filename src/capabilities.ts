import { AGENT_ID, type CodexModelOption } from './types.js';
const yes = { supported: true as const };
const no = (reason: string) => ({ supported: false as const, reason });

export const DEFAULT_CODEX_CONTEXT_TOKENS = 272_000;

export const DEFAULT_CODEX_MODELS: readonly CodexModelOption[] = [
  { id: 'gpt-5.4', label: 'GPT-5.4', contextTokens: DEFAULT_CODEX_CONTEXT_TOKENS },
  { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', contextTokens: DEFAULT_CODEX_CONTEXT_TOKENS },
];

export function codexCapabilities() {
  return {
    agentId: AGENT_ID,
    nativeCli: yes,
    operations: {
      prompt: yes, cancel: yes,
      queue: no('Codex app-server does not expose Host queue'),
      intervene: yes, setModel: yes, setEffort: no('Codex effort apply is not acknowledged yet'), setMode: no('Codex mode apply is not acknowledged yet'),
      slashCommands: no('Codex slash commands are not a Host control yet'), fileReferences: no('File chips are not a Host Codex operation'), images: no('Image input is not implemented in this revision'),
      rename: no('Codex catalog rename is not implemented'), delete: no('Codex catalog delete is not implemented'),
      archive: no('Codex archive is native-owned'),
      pin: no('Codex pin is not a Host operation'),
      export: no('Export stays in native Codex history'),
      fork: no('Codex fork is native-owned'),
      rewind: no('Codex rewind is not a Host operation'),
      duplicate: no('Codex duplicate is not a Host operation'),
      pause: no('Codex has no Host pause'),
      compact: no('Compaction is native-owned'),
      conversationTree: no('No Host conversation tree'),
      coldStorage: no('No Host cold storage'),
      hostSubagents: no('Host subagents are Pi-only'),
      hostTools: no('Host tools are not injected into Codex'),
    },
  };
}

export function codexOptions(input: {
  models?: readonly CodexModelOption[];
  currentModelId?: string;
  commands?: { name: string }[];
}) {
  return {
    agentId: AGENT_ID,
    models: (input.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      ...(typeof model.contextTokens === 'number' && Number.isFinite(model.contextTokens) && model.contextTokens > 0
        ? { contextTokens: model.contextTokens }
        : {}),
    })),
    ...(input.currentModelId === undefined ? {} : { currentModelId: input.currentModelId }),
    modes: [{ id: 'default', label: 'Default' }],
    currentModeId: 'default',
    modeConfirmed: true,
    commands: input.commands ?? [],
  };
}

export const DEFAULT_PERMISSION_OPTIONS = [
  { optionId: 'allow_once', label: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'reject_once', label: 'Reject once', kind: 'reject_once' as const },
];
