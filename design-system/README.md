# StegoShard Design System

Source of truth for StegoShard's visual identity, formalized from `src/ui/ui.css`.
Each `.html` file is a self-contained preview that renders as one card in the
Claude Design project (claude.ai/design). The first line of every file is a
`<!-- @dsCard group="…" name="…" -->` marker that drives the Design System pane.

## Structure

- `foundations/`: colors, typography, radii & elevation (the design tokens)
- `components/`: app bar, buttons, pills & badges, cards, form fields,
  segmented control, dropzone, chooser cards, wizard, modal, password meter,
  result & status

## Editing the visual

1. Edit the relevant `.html` file(s) here (tokens are inlined in each `<style>`).
   To change the palette everywhere, update the `:root` values; for a lasting
   change, also edit the real `:root` block in `src/ui/ui.css`.
2. Re-sync to Claude Design (via the `/design-sync` skill or the DesignSync
   tool), one component at a time, never a wholesale replace.

The canonical runtime stylesheet is still `src/ui/ui.css`; this folder mirrors
it for design work.
