# Changelog

Running log of what's changed since the last GitHub release. I update this
as we go — you don't need to track it yourself. When you're ready to
publish, this becomes the release notes and then resets.

## Unreleased (since v0.1.0)

- Key/root note highlighting (ring around the letter when it matches the
  song's key)
- Manual per-song key override, plus a separate override for Virtuoso
- Scale display (shows song's scale when data exists)
- Full-fretboard scale overlay (3D) — dots on every matching fret/string,
  always on, independent of the chart
- Three "show all notes as letters" board modes (All Notes, All Notes on
  inlay frets only, Root Note Only)
- Chord-name centering — chord name now centers over the real strum frame
  instead of anchoring to the lowest string
- "Hide fingering numbers" toggle (3D)
- Several bug fixes: gem/board letter duplication and z-order, open-string
  scale-overlay position, settings-pane slider width, Virtuoso scale lock
- `highway_3d` release payload trimmed to just the two files we actually
  edit (`screen.js`, `settings.html`) instead of the whole plugin folder
- `static/` release payload now also ships `js/highway-state-primitives.js`
  (new file `highway.js` depends on)
- Default settings updated to match what's actually being used day-to-day
  (captured live from the running settings pane): chord letter size 6
  (was 5), scale overlay shows note letters instead of dots, scale overlay
  colors match string color, chord name position nudged (offsetX/Y)
- Fixed: chord name stopped drawing entirely when a struck chord's notes
  were all scale tones with the scale overlay on (3D) — the overlay's
  per-note suppression was accidentally removing the chord's notes before
  the chord-name grouping logic ever saw them. Individual note letters
  are still suppressed the same as before; only the separate chord-name
  label is now exempt.

<!--
When a real GitHub release is cut, move this list into the release notes,
then clear this section back to empty and start again.
-->
