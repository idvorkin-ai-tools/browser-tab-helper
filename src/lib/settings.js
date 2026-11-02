// Switches shared by the worker and the list page, kept in storage.local under `settings`.
export const DEFAULT_SETTINGS = {
  askEnabled: true,
  autoReload: true,
  bridgeEnabled: false,
  bridgePort: 8787,
  // Roomy, since a click on a background tab takes about 5 s, but inside the server's 95 s wait for an answer.
  bridgeCommandTimeoutMs: 60_000,
};

export function withDefaults(stored) {
  return { ...DEFAULT_SETTINGS, ...stored };
}
