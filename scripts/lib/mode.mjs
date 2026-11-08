// Lite is the app's default mode (Nov 7, 2026). The suites written before it drive Full (the map, its layers and
// tiles), so a context opens in the mode a suite asks for: Full unless it says otherwise. A mode the page saves
// itself (Settings > Mode) is kept across reloads — the script only fills an empty setting.

/** Opens every page of the context in `mode` ('full' | 'lite'); null leaves the app's own default (Lite). */
export async function startInMode(context, mode = 'full') {
  if (!mode) return
  await context.addInitScript((m) => {
    try {
      if (!localStorage.getItem('stormscope.mode')) localStorage.setItem('stormscope.mode', m)
    } catch {
      /* storage blocked: the app's default */
    }
  }, mode)
}
