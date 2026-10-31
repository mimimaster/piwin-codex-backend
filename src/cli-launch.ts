export function codexCliLaunch(backendSessionId: string): { backendSessionId: string; args: string[] } {
  if (backendSessionId.length === 0) throw new Error('native-thread-required');
  return { backendSessionId, args: ['resume', backendSessionId] };
}
