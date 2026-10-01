// Preview-only font stacks.
//
// The themes name the fonts PowerPoint should use (Calibri, Cambria, Consolas,
// Calibri Light). Those ship with Office and do NOT exist on a stock macOS, so
// a browser asked for "Calibri" silently falls back to whatever it likes and
// the preview stops matching the export.
//
// This maps each to a stack whose first entries are metric-compatible where
// such a font exists (Carlito ≈ Calibri, Caladea ≈ Cambria — the same
// substitution LibreOffice uses), then to a sane system face. The pptx side is
// untouched: it keeps sending the real name so PowerPoint on Windows uses the
// genuine font.
//
// See shared/deck/page.ts for the purity rules that apply to this whole folder.

const STACKS: Record<string, string> = {
  'calibri':       "Calibri, Carlito, 'Helvetica Neue', Helvetica, sans-serif",
  'calibri light': "'Calibri Light', Carlito, 'Helvetica Neue', Helvetica, sans-serif",
  'cambria':       "Cambria, Caladea, Georgia, 'Times New Roman', serif",
  'consolas':      "Consolas, Menlo, 'SF Mono', monospace",
  'georgia':       "Georgia, 'Times New Roman', serif",
  'trebuchet ms':  "'Trebuchet MS', 'Helvetica Neue', Helvetica, sans-serif",
  'arial':         "Arial, Helvetica, sans-serif",
  'arial black':   "'Arial Black', 'Helvetica Neue', Helvetica, sans-serif",
}

/** CSS font-family for a theme font name. */
export function fontStack(fontFace: string): string {
  return STACKS[fontFace.toLowerCase()] ?? `${fontFace}, sans-serif`
}
