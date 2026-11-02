// Switches shared by the worker and the list page, kept in storage.local under `settings`.
export const DEFAULT_SETTINGS = {
  askEnabled: true,
  autoReload: true,
  bridgeEnabled: false,
  bridgePort: 8787,
};

export function withDefaults(stored) {
  return { ...DEFAULT_SETTINGS, ...stored };
}
