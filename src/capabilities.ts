import { AGENT_ID } from './types.js';
const yes = { supported: true as const };
const no = (reason: string) => ({ supported: false as const, reason });

export function codexCapabilities() {
  return {
    agentId: AGENT_ID,
    nativeCli: yes,
    operations: {
      prompt: yes, cancel: yes,
      queue: no('Codex app-server does not expose Host queue'),
      intervene: yes, setModel: yes, setEffort: yes, setMode: yes,
      slashCommands: yes, fileReferences: yes, images: yes,
      rename: yes, delete: yes,
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

export function codexOptions(input: { models?: { id: string; label: string }[]; currentModelId?: string; commands?: { name: string }[] }) {
  return {
    agentId: AGENT_ID,
    models: input.models ?? [],
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
