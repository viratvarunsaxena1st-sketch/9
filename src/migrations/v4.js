/**
 * v4 — dual and quad are replaced by Constant Change.
 *
 * Anyone sitting on dual or quad is moved onto the new mode, and the two old
 * presets are folded into it so a returning player keeps their trial time and
 * match chance rather than being reset.
 */
export const migrateToV4 = (settings) => {
  if (settings?.version !== 'v3') {
    return settings
  }

  settings.version = 'v4'

  const gameSettings = settings.gameSettings ?? {}
  if (!gameSettings.constant) {
    const inherited = gameSettings.dual ?? gameSettings.quad
    if (inherited) {
      gameSettings.constant = {
        ...structuredClone(inherited),
        enableAudio: true,
        enableShape: false,
        enableColor: false,
        enableImage: false,
        rules: 'none',
      }
    }
  }
  delete gameSettings.quad
  delete gameSettings.dual
  settings.gameSettings = gameSettings

  if (settings.mode === 'quad' || settings.mode === 'dual') {
    settings.mode = 'constant'
  }

  if (Array.isArray(settings.enabledModes)) {
    const kept = settings.enabledModes.filter((m) => m !== 'quad' && m !== 'dual')
    if (kept.length !== settings.enabledModes.length && !kept.includes('constant')) {
      kept.unshift('constant')
    }
    settings.enabledModes = kept.length > 0 ? kept : ['constant', 'custom']
  }

  return settings
}
