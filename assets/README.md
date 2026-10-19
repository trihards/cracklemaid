# Mascot artwork

Save Cracklemaid's illustration here as **`mascot.png`** (transparent background,
roughly square, at least 900 px wide). The app detects it automatically and uses it
in place of the placeholder drawing. No code changes are needed.

If you add it after the app has been installed, bump `CACHE` in `sw.js` (and add
`assets/mascot.png` to its `ASSETS` list) so installed copies pick it up offline.
