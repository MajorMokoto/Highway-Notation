// highway_notation — shows the chromatic note letter on each gem, on
// EITHER highway renderer (classic 2D canvas or the 3D Highway plugin).
// One file, two independent draw paths — see "Renderer split" below — so a
// fix to one renderer's geometry can never silently affect the other's
// (the 3D Highway used to get stray-marker bugs from exactly this kind of
// sharing before it was split out in core; see notedetect's drawOverlay
// for the precedent this follows).
//
// Reads:
//   1. window.highway — feedBack core's highway client, explicitly exposed
//      "for plugins" (static/highway.js). Gives us notes/tuning/capo/song
//      info already parsed, no separate WebSocket needed. Also the SOURCE
//      of the 2D draw path below (addDrawHook/project/fretX/getStringColors).
//   2. window.__h3dGemPositions — a small read-only bridge published once per
//      frame by highway_3d/screen.js (mirrors the read direction of that
//      plugin's own FREECAM_BRIDGE.md / window.__h3dCamCtl). An array of
//      { s, f, t, sx, sy } for each visible gem, sx/sy already in NDC
//      (-1..1) screen space. Requires that bridge to exist in the installed
//      highway_3d — no-ops entirely if it's absent or the 3D Highway isn't
//      the active visualization.
//
// ── Renderer split ───────────────────────────────────────────────────────
// draw()   — 3D path. Own RAF loop + its own overlay <canvas> anchored to
//            '.h3d-wrap', reads window.__h3dGemPositions (already-projected
//            NDC screen coords). Runs only while that bridge has entries,
//            i.e. only while highway_3d is actually the mounted renderer.
// draw2D() — 2D path. Registered as a highway draw hook (window.highway.
//            addDrawHook) so it paints straight onto the highway's OWN
//            canvas/context — no overlay canvas of its own needed. Bails
//            immediately when a custom renderer (3D Highway, piano, ...) is
//            active (hw.isDefaultRenderer() false), same guard notedetect's
//            drawOverlay uses and for the same reason: this path's geometry
//            (hw.project/hw.fretX) is only meaningful on the 2D canvas.
// Both paths funnel their per-note positions into the SAME shared
// renderNoteLetters() for the actual letter/chord-mode/color/background
// logic, so that part never has to be maintained twice — only how each
// renderer's gem positions get computed differs.
(function () {
    'use strict';

    // ── Settings (localStorage-backed, live-applied) ────────────────────────
    // Mirrors highway_3d's own window.h3dBgSet* convention: settings.html calls
    // these setters directly on change, they persist to localStorage, and the
    // draw loop below just reads the in-memory copy each frame — no polling,
    // no round trip, so a settings-panel edit shows up on the very next frame.
    const LS_PREFIX = 'highway_notation.';
    // Chord-name drag pad's logical value range — asymmetric per Leah's
    // 2026-09-05 ask: more reach left/right and upward (the anchor sits at
    // the chord frame's BOTTOM edge, see chordCenterOf, so upward is what's
    // needed to clear the box), and downward cut to HALF the old range since
    // it's never needed that far. Letter pad is untouched (still the
    // original symmetric -1..1) — these three constants only ever apply to
    // the chord pad's clamp (dnlSetChordOffset, loadSettings) and its own
    // buildDragPad() extents, so the letter position pad's own math and any
    // already-tuned value inside the old ±1 range are completely unaffected.
    const CHORD_PAD_X_EXTENT = 1.5;
    const CHORD_PAD_Y_EXTENT_UP = 1.6;
    const CHORD_PAD_Y_EXTENT_DOWN = 0.5;
    // chordMode: 'all' (every note in a chord gets a letter), 'root' (only the
    // chord's lowest-pitched note), 'none' (skip chord notes — standalone notes
    // still show per showOpen/showFretted). Standalone (non-chord) notes are
    // never affected by chordMode.
    const DEFAULT_SETTINGS = {
        showOpen: true, showFretted: true, chordMode: 'all', sizeK: 5.0, chordSizeK: 6.0, color: '#ffffff',
        bgEnabled: false, bgColor: '#000000', bgOpacity: 70,
        matchGemColor: false, hideFretMarkers: false, hideOpenMarkers: false,
        hideChordGems: false, hideChordOpenGems: false,
        hidePalmMuteMarkers: false, hideFretHandMuteMarkers: false,
        hideFretWires: false, hideStringLines: false,
        // The pre-hit finger-position ghost numbers (1/2/3/4 markers on the
        // fretboard) — highway_3d's own terminology calls these "board
        // projection"/"fret ghost", not "fingering numbers", but that's what
        // they visually are. Existing core capability (window.
        // h3dBgSetProjectionVisible), just never had a checkbox in this
        // plugin's own pane before. Same "hide" convention as hideFretWires/
        // hideStringLines above.
        hideFingeringNumbers: false,
        // Letter position relative to the gem's own center, each -1..1 (drag-pad
        // control in the panel). Multiplied by the gem's own fontPx at render
        // time (see OFFSET_RANGE in renderNoteLetters) so the offset distance
        // scales with perspective the same way the letter size already does.
        offsetX: 0, offsetY: 0,
        // Same idea as offsetX/Y above, but a SEPARATE pair for chordMode
        // 'name' chord-name labels — Leah's explicit ask 2026-09-05: chord
        // names and single-note letters need independent placement (e.g. a
        // chord name nudged clear of the gold core chord label without
        // dragging every single note letter along with it). Two separate
        // drag pads in the pane, side by side, rather than a single shared
        // pad with a mode selector — simpler to build and faster to read.
        chordOffsetX: -0.7838541666666667, chordOffsetY: -0.8355555555555556,
        // Multiplier applied to the SAME chordOffsetX/Y dial once a chord
        // has actually struck the hit line, instead of the much larger
        // range used while it's still flying/approaching — added 2026-09-05
        // as a live-tunable slider after several blind guesses at a fixed
        // constant didn't land in the right spot (too high, then too low)
        // via screenshot-only iteration. Letting Leah drag this while
        // watching the real highway is far faster than another round-trip.
        // Locked in 2026-09-05 (Leah confirmed live: "4.9") — will be
        // removed once this whole struck-position area is finalized and the
        // tuning sliders come back out of the pane.
        chordStruckRange: 4.9,
        // Fade the chord name in as it approaches the strike line, mirroring
        // highway_3d's own chord-frame/label fade-in (screen.js ~13023/13348:
        // fade = max(0, 1 - dt/AHEAD), opacity = min(1, 0.3 + fade*0.7)).
        // Pre-strike only — once struck, opacity snaps to 1 and stays there;
        // no post-strike fade-out, to avoid the disappearing/overlapping-name
        // regressions from the 2026-09-05 repeat-run fix attempt (see
        // [[highway-notation-plugin]] "REVERTED 2026-09-05"). Default on to
        // match core's own look; a checkbox lets it be turned back off for a
        // flat, always-fully-opaque name instead.
        fadeChordName: true,
        // Rings the letter of any note matching the song's current key/root
        // (window.highway.getKeyTonicAt), when the active song has a keys
        // track at all — silently does nothing on songs without one.
        highlightRootNotes: false,
        // Ring drawn behind a highlighted root note's letter. Thickness is a
        // multiplier of that gem's own fontPx (same scaling convention as
        // OFFSET_RANGE/ringR below), not a fixed px value, so it stays
        // proportional across letter sizes and perspective.
        ringColor: '#e8c040', ringThickness: 0.1,
        // Full-fretboard scale overlay dot appearance. sizeMul scales the
        // base radius (Math.min(W,H)*0.006, see renderScaleOverlay) — 1.0 is
        // that default. opacity is the non-root dot's alpha (0-100, matching
        // the existing bgOpacity convention); the root dot always renders at
        // a fixed +0.3 above this so it stays visually distinct regardless
        // of how low the base opacity is set.
        scaleDotSizeMul: 1.0, scaleDotOpacity: 65,
        // Real-scale (not All Notes/Root Only) display: 'dots' draws a plain
        // dot per scale-tone position (the original/only behavior); 'notes'
        // draws the actual note letter there instead, same idea as the All
        // Notes overlay's letters but filtered to the active scale's tones.
        // scaleUseFretColor mirrors matchGemColor's own on/off convention
        // (see colorRow/matchGemRow) but for the scale overlay specifically:
        // off (default) colors dots/notes with the plain Letter color
        // (settings.color); on colors them per-string via gemColorForString,
        // same source highway_3d's own fret markers use. No separate color
        // picker — deliberately reuses settings.color, per Leah's call
        // 2026-09-06 ("we don't need a new color picker for the scale
        // colors. It can just use the letter color").
        scaleDisplayMode: 'notes', scaleUseFretColor: true,
        // How far back (in units of that string's own fret-0-to-fret-1
        // spacing) to pull the open-string (fret 0) marker off the nut and
        // toward the headstock, roughly lining it up with where the core
        // tuning label used to sit before it gets auto-hidden (see
        // setTuningLabelsHiddenForScale). 0.7 confirmed live 2026-09-06 —
        // no pane control for this (was a tuning slider during that
        // session, removed once the value was locked in), only exposed via
        // window.dnlSetScaleOpenStringOffsetK for future CDP tuning if ever
        // needed again.
        scaleOpenStringOffsetK: 0.7,
        // Virtuoso doesn't expose the Panes sidebar itself (see the README
        // caveat this plugin already ships with), so the settings pane has
        // to be opened BEFORE switching into Virtuoso or there's no way to
        // reach it — auto-opening on Virtuoso activation removes that gotcha.
        // Default true since it's solving a real, otherwise-easy-to-hit
        // annoyance; a checkbox lets anyone who finds the auto-pop-up
        // intrusive turn it back off.
        autoOpenPaneInVirtuoso: true,
        // Virtuoso's OWN reported key/scale (window.Virtuoso.getActiveBundleInfo)
        // is unreliable in several places — confirmed stale/wrong in Workout
        // mode specifically, see [[virtuoso-requests-for-maintainer]] — and
        // until Virtuoso's maintainer fixes that, the scale overlay had no
        // way to turn itself off/override while Virtuoso was active at all
        // (the picker was fully disabled there). This is a SEPARATE override
        // from the normal per-filename scaleOverrides blob (Virtuoso doesn't
        // expose a stable per-song filename the way the normal player does),
        // one single value: null (auto — trust Virtuoso's own report), 'none'
        // (force the overlay off), ALL_NOTES_ID, or a real scale id.
        virtuosoScaleOverride: null,
        // Same idea as virtuosoScaleOverride above, but for the key/tonic —
        // added 2026-09-06 after initially just disabling the key picker
        // entirely in Virtuoso ("no manual override applies here"). Leah's
        // call: a lockout was the wrong move, same escape-hatch pattern as
        // the scale override is better — null (auto, trust Virtuoso's own
        // report), 'none' (force root-highlighting off), or a real tonic
        // pitch class (0-11) to force regardless of what Virtuoso reports.
        virtuosoKeyOverride: null,
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS);

    function loadSettings() {
        try {
            const so = localStorage.getItem(LS_PREFIX + 'showOpen');
            const sf = localStorage.getItem(LS_PREFIX + 'showFretted');
            const cm = localStorage.getItem(LS_PREFIX + 'chordMode');
            const s = localStorage.getItem(LS_PREFIX + 'sizeK');
            const cs = localStorage.getItem(LS_PREFIX + 'chordSizeK');
            const c = localStorage.getItem(LS_PREFIX + 'color');
            const be = localStorage.getItem(LS_PREFIX + 'bgEnabled');
            const bc = localStorage.getItem(LS_PREFIX + 'bgColor');
            const bo = localStorage.getItem(LS_PREFIX + 'bgOpacity');
            const mgc = localStorage.getItem(LS_PREFIX + 'matchGemColor');
            const hfm = localStorage.getItem(LS_PREFIX + 'hideFretMarkers');
            const hom = localStorage.getItem(LS_PREFIX + 'hideOpenMarkers');
            const hcg = localStorage.getItem(LS_PREFIX + 'hideChordGems');
            const hncg = localStorage.getItem(LS_PREFIX + 'hideChordOpenGems');
            const hpm = localStorage.getItem(LS_PREFIX + 'hidePalmMuteMarkers');
            const hfhm = localStorage.getItem(LS_PREFIX + 'hideFretHandMuteMarkers');
            const hfw = localStorage.getItem(LS_PREFIX + 'hideFretWires');
            const hsl = localStorage.getItem(LS_PREFIX + 'hideStringLines');
            const hfn = localStorage.getItem(LS_PREFIX + 'hideFingeringNumbers');
            const ox = localStorage.getItem(LS_PREFIX + 'offsetX');
            const oy = localStorage.getItem(LS_PREFIX + 'offsetY');
            const cox = localStorage.getItem(LS_PREFIX + 'chordOffsetX');
            const coy = localStorage.getItem(LS_PREFIX + 'chordOffsetY');
            const csr = localStorage.getItem(LS_PREFIX + 'chordStruckRange');
            const fcn = localStorage.getItem(LS_PREFIX + 'fadeChordName');
            const hrn = localStorage.getItem(LS_PREFIX + 'highlightRootNotes');
            const rc = localStorage.getItem(LS_PREFIX + 'ringColor');
            const rt = localStorage.getItem(LS_PREFIX + 'ringThickness');
            const sds = localStorage.getItem(LS_PREFIX + 'scaleDotSizeMul');
            const sdo = localStorage.getItem(LS_PREFIX + 'scaleDotOpacity');
            const sdm = localStorage.getItem(LS_PREFIX + 'scaleDisplayMode');
            const sufc = localStorage.getItem(LS_PREFIX + 'scaleUseFretColor');
            const sosk = localStorage.getItem(LS_PREFIX + 'scaleOpenStringOffsetK');
            const aopv = localStorage.getItem(LS_PREFIX + 'autoOpenPaneInVirtuoso');
            const vso = localStorage.getItem(LS_PREFIX + 'virtuosoScaleOverride');
            const vko = localStorage.getItem(LS_PREFIX + 'virtuosoKeyOverride');
            settings = {
                showOpen: so === null ? DEFAULT_SETTINGS.showOpen : so === '1',
                showFretted: sf === null ? DEFAULT_SETTINGS.showFretted : sf === '1',
                chordMode: (cm === 'all' || cm === 'root' || cm === 'none' || cm === 'name') ? cm : DEFAULT_SETTINGS.chordMode,
                sizeK: s === null ? DEFAULT_SETTINGS.sizeK : (Number.isFinite(parseFloat(s)) ? parseFloat(s) : DEFAULT_SETTINGS.sizeK),
                chordSizeK: cs === null ? DEFAULT_SETTINGS.chordSizeK : (Number.isFinite(parseFloat(cs)) ? parseFloat(cs) : DEFAULT_SETTINGS.chordSizeK),
                color: c || DEFAULT_SETTINGS.color,
                bgEnabled: be === null ? DEFAULT_SETTINGS.bgEnabled : be === '1',
                bgColor: bc || DEFAULT_SETTINGS.bgColor,
                bgOpacity: bo === null ? DEFAULT_SETTINGS.bgOpacity : (Number.isFinite(parseFloat(bo)) ? Math.max(0, Math.min(100, parseFloat(bo))) : DEFAULT_SETTINGS.bgOpacity),
                matchGemColor: mgc === null ? DEFAULT_SETTINGS.matchGemColor : mgc === '1',
                hideFretMarkers: hfm === null ? DEFAULT_SETTINGS.hideFretMarkers : hfm === '1',
                hideOpenMarkers: hom === null ? DEFAULT_SETTINGS.hideOpenMarkers : hom === '1',
                hideChordGems: hcg === null ? DEFAULT_SETTINGS.hideChordGems : hcg === '1',
                hideChordOpenGems: hncg === null ? DEFAULT_SETTINGS.hideChordOpenGems : hncg === '1',
                hidePalmMuteMarkers: hpm === null ? DEFAULT_SETTINGS.hidePalmMuteMarkers : hpm === '1',
                hideFretHandMuteMarkers: hfhm === null ? DEFAULT_SETTINGS.hideFretHandMuteMarkers : hfhm === '1',
                hideFretWires: hfw === null ? DEFAULT_SETTINGS.hideFretWires : hfw === '1',
                hideStringLines: hsl === null ? DEFAULT_SETTINGS.hideStringLines : hsl === '1',
                hideFingeringNumbers: hfn === null ? DEFAULT_SETTINGS.hideFingeringNumbers : hfn === '1',
                offsetX: ox === null ? DEFAULT_SETTINGS.offsetX : (Number.isFinite(parseFloat(ox)) ? Math.max(-1, Math.min(1, parseFloat(ox))) : DEFAULT_SETTINGS.offsetX),
                offsetY: oy === null ? DEFAULT_SETTINGS.offsetY : (Number.isFinite(parseFloat(oy)) ? Math.max(-1, Math.min(1, parseFloat(oy))) : DEFAULT_SETTINGS.offsetY),
                chordOffsetX: cox === null ? DEFAULT_SETTINGS.chordOffsetX : (Number.isFinite(parseFloat(cox)) ? Math.max(-CHORD_PAD_X_EXTENT, Math.min(CHORD_PAD_X_EXTENT, parseFloat(cox))) : DEFAULT_SETTINGS.chordOffsetX),
                chordOffsetY: coy === null ? DEFAULT_SETTINGS.chordOffsetY : (Number.isFinite(parseFloat(coy)) ? Math.max(-CHORD_PAD_Y_EXTENT_UP, Math.min(CHORD_PAD_Y_EXTENT_DOWN, parseFloat(coy))) : DEFAULT_SETTINGS.chordOffsetY),
                chordStruckRange: csr === null ? DEFAULT_SETTINGS.chordStruckRange : (Number.isFinite(parseFloat(csr)) ? Math.max(0, Math.min(8, parseFloat(csr))) : DEFAULT_SETTINGS.chordStruckRange),
                fadeChordName: fcn === null ? DEFAULT_SETTINGS.fadeChordName : fcn === '1',
                highlightRootNotes: hrn === null ? DEFAULT_SETTINGS.highlightRootNotes : hrn === '1',
                ringColor: rc || DEFAULT_SETTINGS.ringColor,
                ringThickness: rt === null ? DEFAULT_SETTINGS.ringThickness : (Number.isFinite(parseFloat(rt)) ? Math.max(0.02, Math.min(0.3, parseFloat(rt))) : DEFAULT_SETTINGS.ringThickness),
                scaleDotSizeMul: sds === null ? DEFAULT_SETTINGS.scaleDotSizeMul : (Number.isFinite(parseFloat(sds)) ? Math.max(0.2, Math.min(3, parseFloat(sds))) : DEFAULT_SETTINGS.scaleDotSizeMul),
                scaleDotOpacity: sdo === null ? DEFAULT_SETTINGS.scaleDotOpacity : (Number.isFinite(parseFloat(sdo)) ? Math.max(0, Math.min(100, parseFloat(sdo))) : DEFAULT_SETTINGS.scaleDotOpacity),
                scaleDisplayMode: (sdm === 'dots' || sdm === 'notes') ? sdm : DEFAULT_SETTINGS.scaleDisplayMode,
                scaleUseFretColor: sufc === null ? DEFAULT_SETTINGS.scaleUseFretColor : sufc === '1',
                scaleOpenStringOffsetK: sosk === null ? DEFAULT_SETTINGS.scaleOpenStringOffsetK : (Number.isFinite(parseFloat(sosk)) ? Math.max(0, Math.min(3, parseFloat(sosk))) : DEFAULT_SETTINGS.scaleOpenStringOffsetK),
                autoOpenPaneInVirtuoso: aopv === null ? DEFAULT_SETTINGS.autoOpenPaneInVirtuoso : aopv === '1',
                // Not validated against SCALE_INTERVALS here — that const is
                // declared further down this file and loadSettings() runs at
                // module init, before it exists yet (would throw on the
                // temporal-dead-zone reference). Downstream readers
                // (effectiveScaleName) already guard with SCALE_INTERVALS[id]
                // checks, so an invalid stored value just resolves to
                // nothing rather than crashing anything.
                virtuosoScaleOverride: (vso === null || vso === '') ? DEFAULT_SETTINGS.virtuosoScaleOverride : vso,
                virtuosoKeyOverride: (vko === null || vko === '') ? DEFAULT_SETTINGS.virtuosoKeyOverride
                    : vko === 'none' ? 'none'
                    : (Number.isFinite(parseInt(vko, 10)) && parseInt(vko, 10) >= 0 && parseInt(vko, 10) <= 11) ? parseInt(vko, 10)
                    : DEFAULT_SETTINGS.virtuosoKeyOverride,
            };
        } catch (_) { settings = Object.assign({}, DEFAULT_SETTINGS); }
        // hideChordNames used to be its own persisted checkbox setting —
        // removed 2026-09-06 in favor of driving core's chord-name
        // visibility directly off chordMode (see setCoreChordNameVisible),
        // never persisted under its own key at all now. Clean up any old
        // stored value so it can't linger as dead data.
        try { localStorage.removeItem(LS_PREFIX + 'hideChordNames'); } catch (_) {}
    }
    loadSettings();
    // Drives core's own chord-name label visibility directly off chordMode
    // (see dnlSetChordMode and the init push below) — replaces the old
    // "Hide Default Note Highway Chord Names" checkbox/hideChordNames
    // setting (removed 2026-09-06, Leah's ask: link it to the dropdown
    // instead and don't persist it separately, so an uninstalled plugin
    // can't leave core's chord names stuck hidden).
    function setCoreChordNameVisible(visible) {
        if (window.h3dBgSetChordNameVisible) window.h3dBgSetChordNameVisible(visible);
        if (window.highway && window.highway.setChordNameVisible) window.highway.setChordNameVisible(visible);
    }
    // Re-apply our stored "hide markers" preferences to BOTH renderers' core
    // setters on every load (page refresh, plugin re-init) — the settings
    // themselves live in each renderer's own localStorage, this plugin only
    // remembers which way the user last left ITS checkboxes and pushes that
    // through whichever core setters exist. Calling both sets is harmless:
    // only the currently-mounted renderer's setter has any visible effect,
    // and each no-ops on its own when its bridge/setters aren't present
    // (an older core build that predates these hooks).
    if (window.h3dBgSetGemBodyVisible) window.h3dBgSetGemBodyVisible(!settings.hideFretMarkers);
    if (window.h3dBgSetOpenGemBodyVisible) window.h3dBgSetOpenGemBodyVisible(!settings.hideOpenMarkers);
    if (window.h3dBgSetChordGemBodyVisible) window.h3dBgSetChordGemBodyVisible(!settings.hideChordGems);
    if (window.h3dBgSetChordOpenGemBodyVisible) window.h3dBgSetChordOpenGemBodyVisible(!settings.hideChordOpenGems);
    if (window.h3dBgSetPalmMuteMarkerVisible) window.h3dBgSetPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
    if (window.h3dBgSetFretHandMuteMarkerVisible) window.h3dBgSetFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
    if (window.highway && window.highway.setGemVisible) window.highway.setGemVisible(!settings.hideFretMarkers);
    if (window.highway && window.highway.setOpenBarVisible) window.highway.setOpenBarVisible(!settings.hideOpenMarkers);
    if (window.highway && window.highway.setPalmMuteMarkerVisible) window.highway.setPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
    if (window.highway && window.highway.setFretHandMuteMarkerVisible) window.highway.setFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
    // Core's own chord-name label is hidden ONLY while chordMode is 'name'
    // (this plugin drawing its own chord name instead) — driven directly by
    // chordMode, not a separate persisted checkbox (see
    // setCoreChordNameVisible below, and dnlSetChordMode). Never written to
    // its own localStorage key, so an uninstall/removal of this plugin
    // can't leave core's chord names stuck hidden — the only way they're
    // hidden at all is this line running while the plugin (and chordMode
    // 'name') is actually active.
    setCoreChordNameVisible(settings.chordMode !== 'name');
    // Fret wires (highway_3d's window.h3dBgSetFretWiresVisible) — 3D only, no
    // 2D equivalent exists (the classic highway doesn't render wire meshes
    // the same way), so no window.highway.* counterpart to call here.
    if (window.h3dBgSetFretWiresVisible) window.h3dBgSetFretWiresVisible(!settings.hideFretWires);
    // String lines — same 3D-only, no-2D-equivalent situation as fret wires.
    if (window.h3dBgSetStringLinesVisible) window.h3dBgSetStringLinesVisible(!settings.hideStringLines);
    // Fingering (finger-position ghost) numbers — same 3D-only situation,
    // existing core capability (window.h3dBgSetProjectionVisible), just
    // never had a checkbox in this plugin's own pane before.
    if (window.h3dBgSetProjectionVisible) window.h3dBgSetProjectionVisible(!settings.hideFingeringNumbers);

    // Per-song manual key override — a SEPARATE localStorage entry from
    // `settings` above, since it's per-song data (keyed by song filename,
    // one combined JSON blob covering every song ever set — NOT one
    // localStorage entry per song, which would be unmanageable across a
    // library of thousands), not a plugin-wide preference. Value is a tonic
    // pitch class (0-11) or absent entirely (never set / cleared back to
    // auto-detect). Takes priority over the song's own auto-detected key
    // (window.highway.getKeyTonicAt) once set, on ANY song — including ones
    // that already have real key data — per Leah's call: "the user setting
    // is preferred and saved as the default for that file."
    // Scale-shape data for the full-fretboard scale overlay. Copied directly
    // from Virtuoso's own SCALE_INTERVALS table (plugins/virtuoso/screen.js)
    // rather than re-derived — same ids, same semitone-offset values — so a
    // keys.json `scale` string written to match Virtuoso's naming (which is
    // itself already the source most songs' scale data would be authored
    // against) resolves correctly here with no separate mapping table.
    const SCALE_INTERVALS = {
        major:[0,2,4,5,7,9,11], natural_minor:[0,2,3,5,7,8,10], harmonic_minor:[0,2,3,5,7,8,11],
        melodic_minor:[0,2,3,5,7,9,11],
        minor_pentatonic:[0,3,5,7,10], major_pentatonic:[0,2,4,7,9], blues:[0,3,5,6,7,10],
        bebop_major:[0,2,4,5,7,8,9,11], bebop_dominant:[0,2,4,5,7,9,10,11],
        bebop_dorian:[0,2,3,4,5,7,9,10],
        dorian:[0,2,3,5,7,9,10], phrygian:[0,1,3,5,7,8,10], lydian:[0,2,4,6,7,9,11],
        mixolydian:[0,2,4,5,7,9,10], locrian:[0,1,3,5,6,8,10],
        phrygian_dominant:[0,1,4,5,7,8,10], lydian_dominant:[0,2,4,6,7,9,10],
        whole_tone:[0,2,4,6,8,10], diminished:[0,2,3,5,6,8,9,11],
        dorian_b2:[0,1,3,5,7,9,10], lydian_augmented:[0,2,4,6,8,9,11],
        mixolydian_b6:[0,2,4,5,7,8,10], locrian_sharp2:[0,2,3,5,6,8,10],
        altered:[0,1,3,4,6,8,10],
        half_whole_dim:[0,1,3,4,6,7,9,10], double_harmonic:[0,1,4,5,7,8,11],
        hungarian_minor:[0,2,3,6,7,8,11], neapolitan_minor:[0,1,3,5,7,8,11],
    };
    // Display labels, in the order offered in the settings dropdown.
    const SCALE_LABELS = [
        ['major', 'Major'], ['natural_minor', 'Natural Minor'], ['harmonic_minor', 'Harmonic Minor'],
        ['melodic_minor', 'Melodic Minor'],
        ['minor_pentatonic', 'Minor Pentatonic'], ['major_pentatonic', 'Major Pentatonic'], ['blues', 'Blues'],
        ['dorian', 'Dorian'], ['phrygian', 'Phrygian'], ['lydian', 'Lydian'],
        ['mixolydian', 'Mixolydian'], ['locrian', 'Locrian'],
        ['bebop_major', 'Bebop Major'], ['bebop_dominant', 'Bebop Dominant'], ['bebop_dorian', 'Bebop Dorian'],
        ['phrygian_dominant', 'Phrygian Dominant'], ['lydian_dominant', 'Lydian Dominant'],
        ['whole_tone', 'Whole Tone'], ['diminished', 'Diminished'],
        ['dorian_b2', 'Dorian ♭2'], ['lydian_augmented', 'Lydian Augmented'],
        ['mixolydian_b6', 'Mixolydian ♭6'], ['locrian_sharp2', 'Locrian ♯2'], ['altered', 'Altered'],
        ['half_whole_dim', 'Half-Whole Diminished'], ['double_harmonic', 'Double Harmonic'],
        ['hungarian_minor', 'Hungarian Minor'], ['neapolitan_minor', 'Neapolitan Minor'],
    ];
    // Common short forms that don't literally match any SCALE_INTERVALS id —
    // confirmed live 2026-09-05 that real feedpak keys.json data uses these
    // (e.g. "311 - Love Song.feedpak" ships scale:"minor", not "natural_minor").
    // "minor"/"major" bare are the standard informal shorthand for the
    // natural minor / major scale specifically, same convention as calling a
    // chord just "C" instead of "C major" — safe to assume, not a guess.
    const SCALE_NAME_ALIASES = { minor: 'natural_minor', major: 'major' };
    // Sentinel scale-override value (never a real SCALE_INTERVALS key): draws
    // every fret/string on the board with no scale filtering at all, key-
    // independent — a plain reference overlay, not "relative to a tonic"
    // like every real scale id. Same override storage as any other scale
    // pick (scaleOverrides[filename] = 'all_notes'), just handled specially
    // wherever a real scale id would otherwise be required.
    const ALL_NOTES_ID = 'all_notes';
    // Same idea as ALL_NOTES_ID, but only at the standard inlay marker frets
    // (3/5/7/9/12/15/17/19/21/24 — same list highway_3d's own static inlay
    // dots use) rather than every fret 0-24 — a lighter reference for
    // someone who just wants note names at the frets they already glance at
    // for position, not the full neck. Leah's ask 2026-09-05.
    const ALL_NOTES_INLAY_ID = 'all_notes_inlay';
    const INLAY_FRETS = new Set([3, 5, 7, 9, 12, 15, 17, 19, 21, 24]);
    // Draws ONLY the root/tonic note's letter across the whole board (every
    // fret/string whose pitch class matches the current key), nothing else.
    // Unlike ALL_NOTES_ID/ALL_NOTES_INLAY_ID this DOES need a resolved tonic
    // (it's meaningless without one) — same tonic requirement as a real
    // scale, just with an interval set of exactly [0]. Leah's ask 2026-09-05.
    const ROOT_ONLY_ID = 'root_only';
    // Buffer (seconds) subtracted from window.highway.getTime() before
    // comparing against a gem's onset time to decide it's been "struck" —
    // see its use site. NOT compensating for a clock-overshoot bug: live
    // CDP measurement 2026-09-05 found the actual now-vs-onset lag at the
    // suppression instant is only ~1-6ms, ruling that theory out. This is
    // just Leah's own preferred hang time — she asked for the gem's letter
    // to stay visible roughly 25-50ms past the strike before disappearing,
    // independent of any clock inaccuracy.
    // Loose name matching for keys.json's free-text `scale` field: lowercase,
    // strip spaces/hyphens, so "Natural Minor", "natural-minor", "naturalminor"
    // all resolve to the same key. Returns null (not a fallback) for anything
    // unrecognized — an unmatched scale name means the overlay stays off,
    // same as the existing "no scale data" no-op behavior elsewhere in this
    // file, rather than silently guessing wrong.
    function resolveScaleId(raw) {
        if (typeof raw !== 'string' || !raw) return null;
        const norm = raw.toLowerCase().replace(/[\s_-]+/g, '');
        if (SCALE_NAME_ALIASES[norm]) return SCALE_NAME_ALIASES[norm];
        for (const id of Object.keys(SCALE_INTERVALS)) {
            if (id.replace(/_/g, '') === norm) return id;
        }
        return null;
    }

    // Per-song scale override, same one-combined-blob storage pattern as
    // keyOverrides above. Three effective states per filename: absent (defer
    // to the song's own keys.json scale, if any), 'none' (force the overlay
    // off even if the song has scale data), or a real SCALE_INTERVALS id
    // (force that scale on regardless of song data).
    const SCALE_OVERRIDE_LS_KEY = LS_PREFIX + 'scaleOverrides';
    let scaleOverrides = {};
    (function loadScaleOverrides() {
        try {
            const raw = localStorage.getItem(SCALE_OVERRIDE_LS_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') scaleOverrides = parsed;
        } catch (_) { scaleOverrides = {}; }
    })();
    function saveScaleOverrides() {
        try { localStorage.setItem(SCALE_OVERRIDE_LS_KEY, JSON.stringify(scaleOverrides)); } catch (_) {}
    }

    const KEY_OVERRIDE_LS_KEY = LS_PREFIX + 'keyOverrides';
    let keyOverrides = {};
    (function loadKeyOverrides() {
        try {
            const raw = localStorage.getItem(KEY_OVERRIDE_LS_KEY);
            const parsed = raw ? JSON.parse(raw) : null;
            if (parsed && typeof parsed === 'object') keyOverrides = parsed;
        } catch (_) { keyOverrides = {}; }
    })();
    function saveKeyOverrides() {
        try { localStorage.setItem(KEY_OVERRIDE_LS_KEY, JSON.stringify(keyOverrides)); } catch (_) {}
    }
    function currentSongFilename() {
        return (window.feedBack && window.feedBack.currentSong && window.feedBack.currentSong.filename) || null;
    }
    // Virtuoso doesn't fire 'song:loaded' when its own jam session changes
    // context, so currentSongFilename() can go stale while Virtuoso is open —
    // pointing at whatever song was active on the normal highway before the
    // user switched over. Block writes while Virtuoso is the foreground
    // screen so a stale filename never gets a key saved against it.
    function isVirtuosoActive() {
        const el = document.getElementById('plugin-virtuoso');
        return !!(el && el.classList.contains('active'));
    }
    // window.feedBack.currentSong can stay set to the LAST song even after
    // backing out to the library/home screen — it's not cleared just because
    // the player screen isn't showing. So currentSongFilename() alone isn't
    // enough to know "the user is actually looking at a song right now";
    // this checks the real player screen container (same "screen active"
    // convention as plugin-virtuoso above) so a key can't get saved against
    // a song the user has already left.
    function isPlayerScreenActive() {
        const el = document.getElementById('player');
        return !!(el && el.classList.contains('active'));
    }
    // Virtuoso's own live jam-session key, read straight from its bundle
    // config rather than anything song/override-related — Virtuoso generates
    // its own practice/jam context, it isn't "a song with a key track" in the
    // usual sense. Returns null if Virtuoso isn't running a session or the
    // key string doesn't parse.
    function getVirtuosoBundleInfo() {
        try {
            return window.Virtuoso && typeof window.Virtuoso.getActiveBundleInfo === 'function'
                ? window.Virtuoso.getActiveBundleInfo()
                : null;
        } catch (_) { return null; }
    }
    function virtuosoKeyTonic(hw, info) {
        const key = info && info.config && info.config.key;
        if (!key) return null;
        return (hw && typeof hw.parseKeyToTonicPc === 'function') ? hw.parseKeyToTonicPc(key) : null;
    }
    // Same bundle config as virtuosoKeyTonic() above, just the scale string
    // instead of the parsed tonic — no parsing needed, it's already a plain
    // name ("phrygian", "major", ...). Display-only for now, same as the
    // normal-song scale readout in updateKeyStatus().
    function virtuosoScale(info) {
        const s = info && info.config && info.config.scale;
        return (typeof s === 'string' && s) ? s : null;
    }
    // Cosmetic only — these raw scale strings ("natural_minor",
    // "bebop_dominant") come straight from song keys.json data or Virtuoso's
    // own config, not from this plugin's own SCALE_LABELS (those are
    // already hand-written friendly names), so the status-row readouts need
    // their own formatting pass: underscores -> spaces, each word
    // capitalized. Leah's ask 2026-09-06.
    function prettyScaleName(raw) {
        if (typeof raw !== 'string' || !raw) return raw;
        return raw.split('_').map(w => w ? w[0].toUpperCase() + w.slice(1) : w).join(' ');
    }
    // The tonic pitch class actually used for root-highlighting right now.
    // While Virtuoso is the foreground screen, it's Virtuoso's own live jam
    // key — never a saved override or the normal song's keys.json track,
    // since currentSongFilename() can be stale in that context (see
    // isVirtuosoActive() above). Otherwise: this song's manual override if
    // one was ever set, else the song's own auto-detected key (if any), else
    // null (nothing highlighted).
    function effectiveKeyTonic(hw, t) {
        if (isVirtuosoActive()) {
            const ov = settings.virtuosoKeyOverride;
            if (ov === 'none') return null;
            if (typeof ov === 'number') return ov;
            return virtuosoKeyTonic(hw, getVirtuosoBundleInfo());
        }
        const filename = currentSongFilename();
        if (filename && Object.prototype.hasOwnProperty.call(keyOverrides, filename)) {
            const ov = keyOverrides[filename];
            return ov === 'none' ? null : ov;
        }
        return (hw && typeof hw.getKeyTonicAt === 'function') ? hw.getKeyTonicAt(t) : null;
    }
    // The raw keys.json event active at time t (last event with event.t <=
    // t), or null. Same "last event at-or-before t" search core's own
    // getKeyTonicAt() does internally, just run client-side over the raw
    // array — there's no core method that hands back the whole event
    // (getKeyTonicAt only returns the parsed tonic), and the only other
    // field on an event worth reading right now is `scale`, which is
    // display-only (nothing highlights off it yet).
    function activeKeyEvent(hw, t) {
        const keys = (hw && typeof hw.getKeys === 'function') ? hw.getKeys() : null;
        if (!Array.isArray(keys) || !keys.length) return null;
        let lo = 0, hi = keys.length - 1, idx = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (keys[mid].t <= t) { idx = mid; lo = mid + 1; }
            else { hi = mid - 1; }
        }
        return idx < 0 ? null : keys[idx];
    }
    // The scale id actually used for the full-fretboard overlay right now.
    // Priority: this song's manual override ('none' forces off, a real id
    // forces that scale, either way skipping song data entirely) — else the
    // song's own keys.json scale at time t, matched via resolveScaleId() —
    // else null (overlay stays off, same as no key/scale data at all).
    // Virtuoso branch: settings.virtuosoScaleOverride wins when set (see its
    // declaration in DEFAULT_SETTINGS) — added because Virtuoso's own
    // reported scale is confirmed unreliable in places (stale in Workout
    // mode, see [[virtuoso-requests-for-maintainer]]), so a read-only
    // reflection with no way to override/turn it off left no escape when
    // Virtuoso reports something wrong. 'none' forces off, ALL_NOTES_ID or a
    // real scale id forces that, else falls through to Virtuoso's own report.
    function effectiveScaleName(hw, t) {
        if (isVirtuosoActive()) {
            const ov = settings.virtuosoScaleOverride;
            if (ov === 'none') return null;
            if (ov === ALL_NOTES_ID || ov === ALL_NOTES_INLAY_ID || ov === ROOT_ONLY_ID || SCALE_INTERVALS[ov]) return ov;
            return resolveScaleId(virtuosoScale(getVirtuosoBundleInfo()));
        }
        const filename = currentSongFilename();
        if (filename && Object.prototype.hasOwnProperty.call(scaleOverrides, filename)) {
            const v = scaleOverrides[filename];
            return v === 'none' ? null : v;
        }
        const ev = activeKeyEvent(hw, t);
        return ev ? resolveScaleId(ev.scale) : null;
    }
    window.dnlSetScaleOverride = (v) => {
        if (isVirtuosoActive() || !isPlayerScreenActive()) return;
        const filename = currentSongFilename();
        if (!filename) return;
        if (v === null || v === '' || v === undefined) {
            delete scaleOverrides[filename];
        } else if (v === 'none' || v === ALL_NOTES_ID || v === ALL_NOTES_INLAY_ID || v === ROOT_ONLY_ID || SCALE_INTERVALS[v]) {
            scaleOverrides[filename] = v;
        } else {
            return;
        }
        saveScaleOverrides();
    };
    // Virtuoso-only counterpart to dnlSetScaleOverride above — opposite gate
    // (only while Virtuoso IS active), single stored value rather than a
    // per-filename blob since Virtuoso doesn't expose a stable per-song file
    // name the way the normal player does. See effectiveScaleName's Virtuoso
    // branch and settings.virtuosoScaleOverride's declaration for why this
    // exists: Virtuoso's own reported scale can be stale/wrong with no other
    // way to override or turn it off.
    window.dnlSetVirtuosoScaleOverride = (v) => {
        if (!isVirtuosoActive()) return;
        const val = (v === null || v === '' || v === undefined) ? null
            : (v === 'none' || v === ALL_NOTES_ID || v === ALL_NOTES_INLAY_ID || v === ROOT_ONLY_ID || SCALE_INTERVALS[v]) ? v : null;
        settings.virtuosoScaleOverride = val;
        try {
            if (val === null) localStorage.removeItem(LS_PREFIX + 'virtuosoScaleOverride');
            else localStorage.setItem(LS_PREFIX + 'virtuosoScaleOverride', val);
        } catch (_) {}
    };
    // Virtuoso-only counterpart to dnlSetKeyOverride below — same pattern as
    // dnlSetVirtuosoScaleOverride above (single stored value, not a
    // per-filename blob). Added 2026-09-06 after initially locking the key
    // picker entirely in Virtuoso; see virtuosoKeyOverride's declaration.
    window.dnlSetVirtuosoKeyOverride = (v) => {
        if (!isVirtuosoActive()) return;
        let val = null;
        if (v === 'none') val = 'none';
        else if (v !== null && v !== '' && v !== undefined) {
            const n = parseInt(v, 10);
            if (Number.isFinite(n) && n >= 0 && n <= 11) val = n;
        }
        settings.virtuosoKeyOverride = val;
        try {
            if (val === null) localStorage.removeItem(LS_PREFIX + 'virtuosoKeyOverride');
            else localStorage.setItem(LS_PREFIX + 'virtuosoKeyOverride', String(val));
        } catch (_) {}
    };
    window.dnlSetKeyOverride = (v) => {
        if (isVirtuosoActive() || !isPlayerScreenActive()) return;
        const filename = currentSongFilename();
        if (!filename) return;
        if (v === null || v === '' || v === undefined) {
            delete keyOverrides[filename];
        } else if (v === 'none') {
            // Forces root-highlighting off for this song regardless of any
            // real keys.json data — distinct from the blank/absent case
            // (auto: defer to that data), same 3-state shape the scale
            // override already has. Added 2026-09-06 — blank used to be
            // labeled "— none —" while actually behaving as "auto", with no
            // real way to force key off at all; that conflated the two.
            keyOverrides[filename] = 'none';
        } else {
            const n = parseInt(v, 10);
            if (!Number.isFinite(n) || n < 0 || n > 11) return;
            keyOverrides[filename] = n;
        }
        saveKeyOverrides();
    };

    window.dnlGetSettings = () => Object.assign({}, settings);
    window.dnlSetShowOpen = (v) => {
        settings.showOpen = !!v;
        try { localStorage.setItem(LS_PREFIX + 'showOpen', settings.showOpen ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetShowFretted = (v) => {
        settings.showFretted = !!v;
        try { localStorage.setItem(LS_PREFIX + 'showFretted', settings.showFretted ? '1' : '0'); } catch (_) {}
    };
    // Both axes set together (one drag-pad control, not two separate sliders).
    window.dnlSetOffset = (x, y) => {
        const nx = parseFloat(x), ny = parseFloat(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        settings.offsetX = Math.max(-1, Math.min(1, nx));
        settings.offsetY = Math.max(-1, Math.min(1, ny));
        try {
            localStorage.setItem(LS_PREFIX + 'offsetX', String(settings.offsetX));
            localStorage.setItem(LS_PREFIX + 'offsetY', String(settings.offsetY));
        } catch (_) {}
    };
    // Chord-name drag pad — separate from dnlSetOffset above.
    window.dnlSetChordOffset = (x, y) => {
        const nx = parseFloat(x), ny = parseFloat(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) return;
        settings.chordOffsetX = Math.max(-CHORD_PAD_X_EXTENT, Math.min(CHORD_PAD_X_EXTENT, nx));
        settings.chordOffsetY = Math.max(-CHORD_PAD_Y_EXTENT_UP, Math.min(CHORD_PAD_Y_EXTENT_DOWN, ny));
        try {
            localStorage.setItem(LS_PREFIX + 'chordOffsetX', String(settings.chordOffsetX));
            localStorage.setItem(LS_PREFIX + 'chordOffsetY', String(settings.chordOffsetY));
        } catch (_) {}
    };
    window.dnlSetChordStruckRange = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0) return;
        settings.chordStruckRange = Math.min(8, n);
        try { localStorage.setItem(LS_PREFIX + 'chordStruckRange', String(settings.chordStruckRange)); } catch (_) {}
    };
    window.dnlSetFadeChordName = (v) => {
        settings.fadeChordName = !!v;
        try { localStorage.setItem(LS_PREFIX + 'fadeChordName', settings.fadeChordName ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetHighlightRootNotes = (v) => {
        settings.highlightRootNotes = !!v;
        try { localStorage.setItem(LS_PREFIX + 'highlightRootNotes', settings.highlightRootNotes ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetRingColor = (v) => {
        if (typeof v !== 'string' || !v) return;
        settings.ringColor = v;
        try { localStorage.setItem(LS_PREFIX + 'ringColor', v); } catch (_) {}
    };
    window.dnlSetRingThickness = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        settings.ringThickness = Math.max(0.02, Math.min(0.3, n));
        try { localStorage.setItem(LS_PREFIX + 'ringThickness', String(settings.ringThickness)); } catch (_) {}
    };
    window.dnlSetScaleDotSizeMul = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        settings.scaleDotSizeMul = Math.max(0.2, Math.min(3, n));
        try { localStorage.setItem(LS_PREFIX + 'scaleDotSizeMul', String(settings.scaleDotSizeMul)); } catch (_) {}
    };
    window.dnlSetScaleDotOpacity = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        settings.scaleDotOpacity = Math.max(0, Math.min(100, n));
        try { localStorage.setItem(LS_PREFIX + 'scaleDotOpacity', String(settings.scaleDotOpacity)); } catch (_) {}
    };
    window.dnlSetScaleDisplayMode = (v) => {
        if (v !== 'dots' && v !== 'notes') return;
        settings.scaleDisplayMode = v;
        try { localStorage.setItem(LS_PREFIX + 'scaleDisplayMode', v); } catch (_) {}
    };
    window.dnlSetScaleUseFretColor = (v) => {
        settings.scaleUseFretColor = !!v;
        try { localStorage.setItem(LS_PREFIX + 'scaleUseFretColor', settings.scaleUseFretColor ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetScaleOpenStringOffsetK = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        settings.scaleOpenStringOffsetK = Math.max(0, Math.min(3, n));
        try { localStorage.setItem(LS_PREFIX + 'scaleOpenStringOffsetK', String(settings.scaleOpenStringOffsetK)); } catch (_) {}
    };
    window.dnlSetAutoOpenPaneInVirtuoso = (v) => {
        settings.autoOpenPaneInVirtuoso = !!v;
        try { localStorage.setItem(LS_PREFIX + 'autoOpenPaneInVirtuoso', settings.autoOpenPaneInVirtuoso ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetChordMode = (v) => {
        if (v !== 'all' && v !== 'root' && v !== 'none' && v !== 'name') return;
        settings.chordMode = v;
        try { localStorage.setItem(LS_PREFIX + 'chordMode', v); } catch (_) {}
        // Core's own chord-name label is only ever hidden while this
        // plugin is actively drawing its OWN chord name in its place —
        // see setCoreChordNameVisible's own comment for why this isn't a
        // separate persisted setting anymore.
        setCoreChordNameVisible(v !== 'name');
    };
    window.dnlSetSizeK = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.sizeK = n;
        try { localStorage.setItem(LS_PREFIX + 'sizeK', String(n)); } catch (_) {}
    };
    window.dnlSetChordSizeK = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.chordSizeK = n;
        try { localStorage.setItem(LS_PREFIX + 'chordSizeK', String(n)); } catch (_) {}
    };
    window.dnlSetColor = (v) => {
        if (typeof v !== 'string' || !v) return;
        settings.color = v;
        try { localStorage.setItem(LS_PREFIX + 'color', v); } catch (_) {}
    };
    window.dnlSetBgEnabled = (v) => {
        settings.bgEnabled = !!v;
        try { localStorage.setItem(LS_PREFIX + 'bgEnabled', settings.bgEnabled ? '1' : '0'); } catch (_) {}
    };
    window.dnlSetBgColor = (v) => {
        if (typeof v !== 'string' || !v) return;
        settings.bgColor = v;
        try { localStorage.setItem(LS_PREFIX + 'bgColor', v); } catch (_) {}
    };
    window.dnlSetBgOpacity = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n)) return;
        settings.bgOpacity = Math.max(0, Math.min(100, n));
        try { localStorage.setItem(LS_PREFIX + 'bgOpacity', String(settings.bgOpacity)); } catch (_) {}
    };
    window.dnlSetMatchGemColor = (v) => {
        settings.matchGemColor = !!v;
        try { localStorage.setItem(LS_PREFIX + 'matchGemColor', settings.matchGemColor ? '1' : '0'); } catch (_) {}
    };
    // Drive BOTH renderers' 'Show fret markers' / 'Show open-note markers'
    // core settings — highway_3d's window.h3dBgSet* and the classic 2D
    // highway's window.highway.set* (added specifically to support this
    // plugin, mirroring the h3d naming) — the plugin's checkboxes are
    // inverted ("Hide...") from the core setters' sense ("show"), so flip
    // here. Calling both is harmless; only the mounted renderer's setter
    // has any visible effect.
    window.dnlSetHideFretMarkers = (v) => {
        settings.hideFretMarkers = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideFretMarkers', settings.hideFretMarkers ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetGemBodyVisible) window.h3dBgSetGemBodyVisible(!settings.hideFretMarkers);
        if (window.highway && window.highway.setGemVisible) window.highway.setGemVisible(!settings.hideFretMarkers);
    };
    window.dnlSetHideOpenMarkers = (v) => {
        settings.hideOpenMarkers = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideOpenMarkers', settings.hideOpenMarkers ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetOpenGemBodyVisible) window.h3dBgSetOpenGemBodyVisible(!settings.hideOpenMarkers);
        if (window.highway && window.highway.setOpenBarVisible) window.highway.setOpenBarVisible(!settings.hideOpenMarkers);
    };
    // 3D only — highway_3d core capability added 2026-09-05 specifically for
    // this ask ([[highway3d-core-changes-for-upstream]] entry 11); no 2D
    // equivalent exists yet. 4 fully independent toggles, no cross-axis AND
    // with hideFretMarkers/hideOpenMarkers above — those now apply ONLY to
    // non-chord gems, these two apply ONLY to chord gems (Leah's explicit
    // call: "chord changes are governed by their new 2 options only now...
    // I still want 4 toggles. So keep them separated"). Gated in core on a
    // dedicated isRealChordMember parameter, NOT the pre-existing fromChord
    // (which is also true for arpeggio-ghost-inferred standalone notes —
    // see that core entry for the bug this caused before the split).
    window.dnlSetHideChordGems = (v) => {
        settings.hideChordGems = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideChordGems', settings.hideChordGems ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetChordGemBodyVisible) window.h3dBgSetChordGemBodyVisible(!settings.hideChordGems);
    };
    window.dnlSetHideChordOpenGems = (v) => {
        settings.hideChordOpenGems = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideChordOpenGems', settings.hideChordOpenGems ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetChordOpenGemBodyVisible) window.h3dBgSetChordOpenGemBodyVisible(!settings.hideChordOpenGems);
    };
    window.dnlSetHidePalmMuteMarkers = (v) => {
        settings.hidePalmMuteMarkers = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hidePalmMuteMarkers', settings.hidePalmMuteMarkers ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetPalmMuteMarkerVisible) window.h3dBgSetPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
        if (window.highway && window.highway.setPalmMuteMarkerVisible) window.highway.setPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
    };
    window.dnlSetHideFretHandMuteMarkers = (v) => {
        settings.hideFretHandMuteMarkers = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideFretHandMuteMarkers', settings.hideFretHandMuteMarkers ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetFretHandMuteMarkerVisible) window.h3dBgSetFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
        // On the 2D highway there's no separate fret-hand-mute visual — it
        // shares the single "PM" text label with palm-mute (see
        // _dnlMuteLabelOn in highway-draw.js), so either hide toggle being
        // off hides that same label.
        if (window.highway && window.highway.setFretHandMuteMarkerVisible) window.highway.setFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
    };
    window.dnlSetHideFretWires = (v) => {
        settings.hideFretWires = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideFretWires', settings.hideFretWires ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetFretWiresVisible) window.h3dBgSetFretWiresVisible(!settings.hideFretWires);
    };
    window.dnlSetHideStringLines = (v) => {
        settings.hideStringLines = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideStringLines', settings.hideStringLines ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetStringLinesVisible) window.h3dBgSetStringLinesVisible(!settings.hideStringLines);
    };
    window.dnlSetHideFingeringNumbers = (v) => {
        settings.hideFingeringNumbers = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideFingeringNumbers', settings.hideFingeringNumbers ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetProjectionVisible) window.h3dBgSetProjectionVisible(!settings.hideFingeringNumbers);
    };

    // #rrggbb + 0-100 opacity -> an rgba() string for canvas fillStyle.
    function hexToRgba(hex, opacityPct) {
        const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
        const rgb = m ? m[1] : '000000';
        const r = parseInt(rgb.slice(0, 2), 16);
        const g = parseInt(rgb.slice(2, 4), 16);
        const b = parseInt(rgb.slice(4, 6), 16);
        const a = Math.max(0, Math.min(100, opacityPct)) / 100;
        return `rgba(${r},${g},${b},${a})`;
    }

    // Per-string color source, renderer-aware: the 3D path publishes numeric
    // 0xRRGGBB hex via window.__h3dActivePalette (mirrors the read direction
    // of window.__h3dGemPositions); the 2D path has no such bridge but
    // exposes the same information first-class via window.highway.
    // getStringColors() (hex strings). Checking __h3dActivePalette FIRST
    // means a session with highway_3d installed but not currently mounted
    // still prefers it correctly once it IS mounted; when it's absent this
    // just falls through to the 2D getter, or to null if neither renderer's
    // color source is available yet.
    function currentPalette() {
        const hw = window.highway;
        // Renderer-aware, not just "does the array exist": window.__h3dActivePalette
        // is set by highway_3d's own code and never cleared when you switch
        // AWAY from it — a stale array from an earlier 3D session sticks
        // around in memory forever after. Checking Array.isArray() alone
        // (as this used to) meant a palette pick made on the 2D highway was
        // silently ignored for the rest of the session once __h3dActivePalette
        // had ever been set (reported 2026-09-03: "just defaults" no matter
        // what was picked). isDefaultRenderer() tells us which renderer is
        // ACTUALLY mounted right now — only trust the 3D bridge while 3D is
        // genuinely active.
        const is3DActive = !!(hw && hw.isDefaultRenderer && !hw.isDefaultRenderer());
        if (is3DActive && Array.isArray(window.__h3dActivePalette)) return window.__h3dActivePalette;
        if (hw && typeof hw.getStringColors === 'function') return hw.getStringColors();
        // Older core without isDefaultRenderer at all: fall back to the old
        // behavior rather than returning nothing.
        if (Array.isArray(window.__h3dActivePalette)) return window.__h3dActivePalette;
        return null;
    }

    // Resolves string index `s` to the color the gem for that string is
    // ACTUALLY drawn in right now, on whichever renderer is active.
    // Automatically theme-aware: currentPalette() already reflects whichever
    // built-in palette or user custom per-string colors are active, with no
    // separate lookup needed here. Falls back to the plain letter color if
    // no palette source is available at all.
    function gemColorForString(s) {
        const pal = currentPalette();
        if (!Array.isArray(pal)) return settings.color;
        const v = pal[s];
        if (typeof v === 'number' && Number.isFinite(v)) return '#' + (v & 0xffffff).toString(16).padStart(6, '0');
        if (typeof v === 'string' && v) return v;
        return settings.color;
    }

    const NOTE_NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

    // Open-string MIDI (thick -> thin), matched to RS string index 0 low.
    // Mirrors highway_3d's own _BASE_OPEN_MIDI_* tables.
    const BASE_OPEN_MIDI_BASS4 = [28, 33, 38, 43];
    const BASE_OPEN_MIDI_BASS5 = [23, 28, 33, 38, 43];
    const BASE_OPEN_MIDI_GUITAR6 = [40, 45, 50, 55, 59, 64];
    const BASE_OPEN_MIDI_GUITAR7 = [35, 40, 45, 50, 55, 59, 64];
    const BASE_OPEN_MIDI_GUITAR8 = [28, 35, 40, 45, 50, 55, 59, 64];

    function baseOpenStringMidis(sc, arrangement) {
        const isBass = /bass/i.test(arrangement || '');
        if (sc === 4 && isBass) return BASE_OPEN_MIDI_BASS4.slice();
        if (sc === 4) return BASE_OPEN_MIDI_GUITAR6.slice(0, 4);
        if (sc === 5 && isBass) return BASE_OPEN_MIDI_BASS5.slice();
        if (sc === 5) return BASE_OPEN_MIDI_GUITAR6.slice(0, 5);
        if (sc === 7) return BASE_OPEN_MIDI_GUITAR7.slice();
        if (sc === 8) return BASE_OPEN_MIDI_GUITAR8.slice();
        if (Number.isFinite(sc) && sc > 8) {
            const out = BASE_OPEN_MIDI_GUITAR8.slice();
            let last = out[out.length - 1];
            while (out.length < sc) { last += 5; out.push(last); }
            return out.slice(0, sc);
        }
        const g6 = BASE_OPEN_MIDI_GUITAR6.slice();
        if (Number.isFinite(sc) && sc < 6 && sc >= 1) return g6.slice(0, sc);
        return g6;
    }

    function noteMidi(tuning, capo, arrangement, s, f) {
        const base = baseOpenStringMidis(Array.isArray(tuning) ? tuning.length : 6, arrangement);
        const offRaw = Array.isArray(tuning) ? tuning[s] : undefined;
        const off = Number.isFinite(offRaw) ? offRaw : 0;
        const cap = Number.isFinite(capo) ? capo : 0;
        const fret = Number.isFinite(f) ? f : 0;
        return (base[s] !== undefined ? base[s] : 40) + off + cap + fret;
    }

    function letterForMidi(midi) {
        return NOTE_NAMES_SHARP[(Math.round(midi) % 12 + 12) % 12];
    }

    const FLAT_TO_SHARP = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', Cb: 'B', Fb: 'E' };

    // The chord's real musical root, read off the chart's own chord name
    // (e.g. "Am7" -> A, "G/B" -> G — a slash chord's root is the part BEFORE
    // the slash, not the bass note after it) rather than guessed from pitch.
    // Only meaningful for a chart-authored chord that actually has a name;
    // returns null for anything else (a coincidental simultaneous standalone
    // note grouping has no chord name to read).
    function rootLetterFromChordName(name) {
        if (typeof name !== 'string' || !name) return null;
        const m = name.match(/^([A-G])([#b]?)/);
        if (!m) return null;
        const raw = m[1] + m[2];
        return FLAT_TO_SHARP[raw] || raw;
    }

    function noteLetter(tuning, capo, arrangement, s, f) {
        return letterForMidi(noteMidi(tuning, capo, arrangement, s, f));
    }

    // ── Shared render core ───────────────────────────────────────────────
    // Both renderer paths (3D's draw() and 2D's draw2D()) reduce their own
    // gem/note source down to the SAME entry shape — { s, f, t, px, py,
    // fontPx } (screen pixels + font size already resolved) — and hand it
    // here. Everything renderer-agnostic (chord-mode grouping, letter
    // lookup, color, background box) lives in exactly one place.
    function renderNoteLetters(ctx, entries, tuning, capo, arrangement, hw, chordFrames) {
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = settings.color;
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';

        // "Chord" here means the strum-line definition, not the chart's own
        // chord authoring: any onset time (t) with more than one entry is a
        // chord for chordMode purposes, whether the chart calls it a chord, an
        // arpeggio, or it's just a coincidental simultaneous standalone note —
        // the chart's own ch/cid tagging is NOT used here on purpose. Bucket
        // to whole milliseconds so float noise on an identical onset can't
        // split one strum into two groups.
        const timeGroups = new Map(); // "t-bucket" -> entry[]
        for (const g of entries) {
            const key = Math.round(g.t * 1000);
            let arr = timeGroups.get(key);
            if (!arr) { arr = []; timeGroups.set(key, arr); }
            arr.push(g);
        }
        // Root lookup (needed for chordMode 'root' and 'name'): within each
        // >1-entry group, prefer the chart's own chord name (real musical root,
        // not a pitch guess — see rootLetterFromChordName) when this onset
        // matches a chart-authored chord instance; otherwise fall back to
        // lowest sounding pitch (a coincidental simultaneous grouping has no
        // chord name at all). Object identity against the stored entry picks it
        // back out in the render pass below. 'name' mode also needs the
        // chord's actual display name text (chordDisplayNameByTime) to draw
        // instead of a plain letter — falls back to the root letter itself
        // when there's no chart chord name for that onset.
        // Real chart-authored chord instances, keyed the same way as
        // timeGroups. Needed for ALL THREE of chordMode 'none'/'root'/'name'
        // — not just root/name — because timeGroups' own "chord" definition
        // is deliberately loose (any 2+ notes sharing an onset time, chart
        // tagging or not, see the comment above). Without cross-checking
        // against a REAL chord instance here, a coincidental simultaneous
        // pair of otherwise-unrelated single notes (not an actual chart
        // chord) got treated exactly like a real chord by every one of
        // these three modes — 'none' silently dropped both notes entirely,
        // 'root'/'name' kept only one and dropped the other. Bug found and
        // fixed 2026-09-05 ("we are hiding note letters on gems/strings that
        // are not actually chords"). realChordKeys is the fix: only a key
        // present here is treated as a real chord for filtering purposes;
        // anything else in timeGroups is coincidental and always draws its
        // own letter regardless of chordMode, same as a genuinely standalone
        // note.
        let chordRootOf = null;
        let chordDisplayNameByTime = null;
        let realChordKeys = null;
        if (settings.chordMode === 'none' || settings.chordMode === 'root' || settings.chordMode === 'name') {
            // Chart chord instances -> their template's root letter + display
            // name, keyed the same way as timeGroups so both line up by onset.
            const chordNameRootByTime = new Map();
            chordDisplayNameByTime = new Map();
            realChordKeys = new Set();
            const chordInstances = hw && hw.getChords ? hw.getChords() : null;
            const chordTemplates = hw && hw.getChordTemplates ? hw.getChordTemplates() : null;
            if (Array.isArray(chordInstances) && Array.isArray(chordTemplates)) {
                for (const c of chordInstances) {
                    const tmpl = chordTemplates[c.id];
                    if (!tmpl) continue;
                    const key = Math.round(c.t * 1000);
                    realChordKeys.add(key);
                    const root = rootLetterFromChordName(tmpl.name);
                    if (root) chordNameRootByTime.set(key, root);
                    // .trim() matters: some chart-authored chord templates
                    // carry a blank/whitespace-only name (a single space, " ",
                    // confirmed live 2026-09-05 in "Love Song"'s chord ids 8/9)
                    // — a plain truthy check treats " " as a real name, so
                    // chordMode 'name' collapsed the group down to an
                    // invisible blank label while still hiding every other
                    // note, with nothing visible in their place. Trimmed here
                    // so a blank name is treated as no-name-at-all everywhere
                    // downstream, same as a chord with no displayName/name.
                    const display = (tmpl.displayName || tmpl.name || '').trim();
                    if (display) chordDisplayNameByTime.set(key, display);
                }
            }

            chordRootOf = new Map();
            for (const [key, arr] of timeGroups) {
                if (arr.length < 2 || !realChordKeys.has(key)) continue;
                const namedRoot = chordNameRootByTime.get(key);
                let best = null;
                let namedMatch = null;
                for (const g of arr) {
                    const midi = noteMidi(tuning, capo, arrangement, g.s, g.f);
                    if (!best || midi < best.midi) best = { midi, gem: g };
                    if (namedRoot && letterForMidi(midi) === namedRoot
                        && (!namedMatch || midi < namedMatch.midi)) {
                        namedMatch = { midi, gem: g };
                    }
                }
                // Prefer the entry that actually sounds the named root; if the
                // voicing omits that pitch class entirely (rare, but shapes can
                // do this), fall back to lowest pitch rather than showing nothing.
                chordRootOf.set(key, namedMatch || best);
            }
        }

        // chordMode 'name' draw position: anchored to the ACTUAL strum-bar
        // frame (the light-blue box core draws around a chord's gems), via
        // window.__h3dChordFramePositions (core, 2026-09-05) — not the voiced
        // notes' own span. The frame's real width reflects the chord SHAPE
        // (its fret span), not just which strings happen to sound, so
        // anchoring to voiced-string min/max px drifted from the real frame
        // on partial/muted-string voicings. Falls back to the old voiced-span
        // method when no frame data is available (2D highway — this bridge is
        // 3D-only — or an unpatched core missing the bridge).
        const chordFrameByTime = new Map();
        if (Array.isArray(chordFrames)) {
            for (const f of chordFrames) chordFrameByTime.set(Math.round(f.t * 1000), f);
        }
        let chordCenterOf = null;
        if (settings.chordMode === 'name') {
            chordCenterOf = new Map();
            for (const [key, arr] of timeGroups) {
                if (arr.length < 2) continue;
                const frame = chordFrameByTime.get(key);
                if (frame) {
                    // Anchor to the BOTTOM edge only (bl/br corners), not all
                    // 4 — core's repeat frames use half height but anchor at
                    // the SAME bottom edge as a full-height frame (only the
                    // top shrinks down, see highway_3d's own "Repeat frames...
                    // anchor at yMinF" comment). Averaging all 4 corners
                    // pulled the center down for a repeat's genuinely shorter
                    // box, dropping the chord name's Y position on every
                    // repeat strike even though X stayed put — bug found live
                    // 2026-09-05, screenshot-confirmed ("Bsus2" visibly lower
                    // on the second/repeat strike). Bottom-edge anchoring is
                    // the one Y reference that's identical between a full
                    // strike and a repeat, so the drag-pad offset now lands
                    // the same relative spot regardless of repeat state.
                    chordCenterOf.set(key, { px: (frame.blx + frame.brx) / 2, py: (frame.bly + frame.brY) / 2 });
                    continue;
                }
                let minPx = Infinity, maxPx = -Infinity, sumPy = 0;
                for (const g of arr) {
                    if (g.px < minPx) minPx = g.px;
                    if (g.px > maxPx) maxPx = g.px;
                    sumPy += g.py;
                }
                chordCenterOf.set(key, { px: (minPx + maxPx) / 2, py: sumPy / arr.length });
            }
        }

        for (const g of entries) {
            const key = Math.round(g.t * 1000);
            const isOpen = g.f === 0;
            if (isOpen ? !settings.showOpen : !settings.showFretted) continue;
            // isChordGem now also requires realChordKeys — a REAL chart-
            // authored chord instance at this onset, not just "2+ notes
            // happen to share a timestamp." Without this second check, a
            // coincidental simultaneous pair of unrelated single notes got
            // treated exactly like a chord by every chordMode: 'none' hid
            // both, 'root'/'name' kept only one. See realChordKeys' own
            // comment above for the full story.
            const isChordGem = (timeGroups.get(key) || []).length > 1 && !!realChordKeys && realChordKeys.has(key);
            let overrideText = null; // set for chordMode 'name' — draws the chord name, not a note letter
            if (isChordGem) {
                if (settings.chordMode === 'none') continue;
                if (settings.chordMode === 'root') {
                    const root = chordRootOf.get(key);
                    if (!root || root.gem !== g) continue;
                } else if (settings.chordMode === 'name') {
                    // Only collapse to a single label when there's an actual
                    // NAME to show — a real chart chord instance (double-stop,
                    // triad, etc.) with no meaningful displayName/name still
                    // passes realChordKeys, but hiding every other note with
                    // nothing displayed in their place makes no sense. Bug
                    // found and fixed 2026-09-05 ("these feel more like
                    // double stops or triads that are not really chords and
                    // they don't get their note letters displayed") — fall
                    // through and let every gem in the group draw its own
                    // plain letter when there's no name for this onset.
                    const name = chordDisplayNameByTime.get(key);
                    if (name) {
                        const root = chordRootOf.get(key);
                        if (!root || root.gem !== g) continue;
                        overrideText = name;
                    }
                }
            }
            const letter = overrideText || noteLetter(tuning, capo, arrangement, g.s, g.f);
            if (!letter || !Number.isFinite(g.fontPxUnit)) continue;
            // Drag-pad offset (settings.offsetX/Y, each -1..1) scaled by this
            // gem's own fontPx so the letter moves a consistent distance
            // relative to its own size regardless of perspective/zoom —
            // OFFSET_RANGE tunes the pad's full-drag distance to roughly one
            // letter-height-and-a-half, enough to clear the gem/fret number
            // underneath at max drag without needing a separate distance control.
            const OFFSET_RANGE = 1.5;
            const center = (overrideText && chordCenterOf) ? chordCenterOf.get(key) : null;
            const basePx = center ? center.px : g.px;
            const basePy = center ? center.py : g.py;
            const offX = overrideText ? settings.chordOffsetX : settings.offsetX;
            const offY = overrideText ? settings.chordOffsetY : settings.offsetY;
            // Chord pad reaches 4x as far as the letter pad — Leah's explicit
            // asks 2026-09-05 to expand the chord name's draggable range.
            // See the "Chord-name drag-reach scaling" entry in
            // [[highway-notation-plugin]] for the full history of what was
            // tried and reverted here.
            const CHORD_OFFSET_RANGE = OFFSET_RANGE * 4;
            const fontPx = Math.max(1, g.fontPxUnit * (overrideText ? settings.chordSizeK : settings.sizeK));
            const offsetFontPx = overrideText
                ? Math.max(1, g.fontPxUnit * DEFAULT_SETTINGS.chordSizeK)
                : fontPx;
            // hw.getTime() returns the AUDIO-aligned clock (chartTime), but
            // the actual on-screen chord frame is drawn against a SEPARATE
            // render clock (chartTime + A/V offset) — confirmed 2026-09-05 by
            // reading static/highway.js directly. getAvOffset() (ms) reads
            // the LIVE per-user setting every frame, self-correcting for
            // whatever each individual player has their own A/V offset
            // dialed to.
            const avOffsetSec = hw && hw.getAvOffset ? (hw.getAvOffset() / 1000) : 0;
            const nowT = hw && hw.getTime ? hw.getTime() + avOffsetSec : null;
            const isStruck = overrideText && nowT !== null && g.t <= nowT;
            const range = overrideText ? (isStruck ? settings.chordStruckRange : CHORD_OFFSET_RANGE) : OFFSET_RANGE;
            // Fade the chord name in as it approaches the strike line —
            // mirrors highway_3d's own chord-label fade-in exactly (screen.js
            // ~13023/13348: fade = max(0, 1 - dt/AHEAD), opacity = min(1,
            // 0.3 + fade*0.7)). Pre-strike only: once struck, alpha snaps to
            // 1 and stays there — no post-strike fade-out, since that's the
            // exact mechanism that caused the disappearing/overlapping-name
            // regressions reverted 2026-09-05 (see [[highway-notation-plugin]]).
            const CHORD_FADE_AHEAD_S = 4.0;
            let chordNameAlpha = 1;
            if (overrideText && settings.fadeChordName && !isStruck && nowT !== null) {
                const dt = g.t - nowT;
                const fade = Math.max(0, Math.min(1, 1 - dt / CHORD_FADE_AHEAD_S));
                chordNameAlpha = Math.min(1, 0.3 + fade * 0.7);
            }
            // Flat correction, X only, once struck — Leah's final
            // live-confirmed value, 2026-09-05; retune by feel.
            const CHORD_STRUCK_X_CORRECTION_PX = -35;
            const px = basePx + offX * offsetFontPx * range + (isStruck ? CHORD_STRUCK_X_CORRECTION_PX : 0);
            const py = basePy + offY * offsetFontPx * range;
            // Chord names (chordMode 'name') borrow highway_3d's own gold
            // chord-label styling (#e8d080, bold) instead of the plain note
            // letter's color/weight — a visual cue that this is a chord name,
            // not a single note, matching what the core highway already uses
            // for its own always-on chord label elsewhere on screen.
            ctx.font = (overrideText ? 'bold ' : '') + Math.round(fontPx) + 'px sans-serif';
            ctx.lineWidth = Math.max(1, fontPx * 0.12);
            // 'miter' (canvas default) spikes at a glyph's acute inner
            // vertices — most visible on "M"'s inner V — once the stroke
            // gets this thick. 'round' rounds those corners off instead.
            ctx.lineJoin = 'round';
            const letterColor = overrideText ? '#e8d080' : (settings.matchGemColor ? gemColorForString(g.s) : settings.color);
            ctx.fillStyle = letterColor;
            const _fadeActive = chordNameAlpha < 1;
            if (_fadeActive) { ctx.save(); ctx.globalAlpha *= chordNameAlpha; }
            // Chord names draw LEFT-aligned from the frame-center anchor
            // (px, unchanged by name length) rather than center-aligned like
            // single-note letters — Leah's explicit fix 2026-09-05: a
            // center-aligned draw means a longer chord name ("F#m7" vs "F")
            // shifts its own left edge every time the name changes, even
            // though the anchor point itself never moved, which reads as
            // "not aligned" when nudged with the drag pad. Left-aligned from
            // a fixed anchor means the name always starts at the same spot
            // and grows rightward ("right of center") instead.
            ctx.textAlign = overrideText ? 'left' : 'center';
            if (settings.bgEnabled) {
                // Background box: width is the measured text width plus 2px of
                // padding on each side (4px total). Height/vertical position use
                // the glyph's OWN measured ink bounds (actualBoundingBoxAscent/
                // Descent), not the font's nominal em-box (fontPx) — textBaseline
                // 'middle' centers on the full em-box, which reserves descender
                // room no note letter (always uppercase A-G) ever uses, so a
                // fontPx-tall box reads as lopsided with extra padding at the
                // bottom. Falls back to fontPx if a browser doesn't support the
                // actualBoundingBox* metrics.
                const tm = ctx.measureText(letter);
                const hasBounds = Number.isFinite(tm.actualBoundingBoxAscent) && Number.isFinite(tm.actualBoundingBoxDescent);
                const ascent = hasBounds ? tm.actualBoundingBoxAscent : fontPx * 0.7;
                const descent = hasBounds ? tm.actualBoundingBoxDescent : fontPx * 0.1;
                const boxW = tm.width + 4;
                const boxH = ascent + descent;
                const boxX = overrideText ? (px - 2) : (px - boxW / 2);
                ctx.fillStyle = hexToRgba(settings.bgColor, settings.bgOpacity);
                ctx.fillRect(boxX, py - ascent, boxW, boxH);
                ctx.fillStyle = letterColor;
            }
            // Root/key highlight: a ring around any note matching the
            // effective key tonic — a user-set manual override for this
            // song file if one was ever chosen (takes priority even on
            // songs with real key data), else the song's own auto-detected
            // key (window.highway.getKeyTonicAt, a timeline — a song can
            // modulate, not one fixed value), else nothing. Independent of
            // what's actually being displayed as `letter` (works under
            // chordMode 'name' too) since it's about the note's own pitch,
            // not its label text.
            if (settings.highlightRootNotes) {
                const tonic = effectiveKeyTonic(hw, g.t);
                if (tonic !== null && tonic !== undefined) {
                    const midi = noteMidi(tuning, capo, arrangement, g.s, g.f);
                    if (((Math.round(midi) % 12) + 12) % 12 === tonic) {
                        const ringR = fontPx * 0.72;
                        ctx.save();
                        ctx.strokeStyle = settings.ringColor;
                        ctx.lineWidth = Math.max(1.5, fontPx * settings.ringThickness);
                        ctx.beginPath();
                        ctx.arc(px, py, ringR, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.restore();
                    }
                }
            }
            ctx.strokeText(letter, px, py);
            ctx.fillText(letter, px, py);
            if (_fadeActive) ctx.restore();
        }
    }

    // ── 3D path ───────────────────────────────────────────────────────────
    // Overlay canvas, sized/positioned to match the 3D Highway's own render
    // area. highway_3d mounts its WebGL canvas (plus a 2D HUD canvas) inside
    // a container with class 'h3d-wrap' — confirmed live via CDP inspection
    // (2026-09-02): '.viz3d-bc' does NOT reliably exist (only created for a
    // background-color visualizer feature, not always active), so anchor on
    // '.h3d-wrap' itself rather than hunting for a specific sibling canvas.
    let overlay = null, ctx = null, wrap = null;
    let rafId = 0;
    // Set once window.highway.addDrawHook becomes available (see draw()
    // below, which always runs and so is a convenient place to poll for it
    // without a second timer) — registers draw2D as the 2D path's entry
    // point. Kept separate from the 3D path's own always-on RAF loop so
    // neither path's lifecycle depends on the other.
    let hw2dHookRegistered = false;

    // Full-fretboard scale overlay (3D only) — draws a marker on every fret,
    // every string, whose pitch belongs to the given scale relative to
    // tonicPc, using the fret-grid bridge (window.__h3dFretGridPositions,
    // highway_3d's own xFret()/sY() positions run through the real camera
    // each frame) rather than any separately-maintained position math, so
    // markers land exactly on the physical board regardless of camera angle.
    // Always-on and independent of the current chart — the whole point is a
    // reference that isn't limited to whatever frets the song happens to use.
    // The fret-grid bridge places its f=0 (open string) point at the nut
    // wire itself (see highway_3d's own fret-grid bridge comment: xFret(0)),
    // which is well onto the fretboard, not where the game's own open-string
    // pitch labels sit — those are drawn further back, over the headstock
    // (highway_3d's boardTuningLabelX). Since this overlay's own open-string
    // markers replace those labels whenever a scale is active (see
    // setTuningLabelsHiddenForScale below), pull f=0 back toward the
    // headstock too, so the marker lands roughly where the label used to be
    // instead of sitting on top of the nut. No core bridge for the label's
    // exact X exists, so this approximates it as a multiple of the same
    // string's own fret-0-to-fret-1 spacing (already on the bridge, still
    // camera/zoom-correct every frame) — tunable via settings.
    // scaleOpenStringOffsetK, Leah's ask 2026-09-06.
    function openStringShiftedSx(grid, i, p) {
        if (p.f !== 0) return p.sx;
        const next = grid[i + 1];
        if (!next || next.s !== p.s) return p.sx;
        const perFret = next.sx - p.sx;
        return p.sx - perFret * settings.scaleOpenStringOffsetK;
    }

    function renderScaleOverlay(ctx, grid, W, H, tuning, capo, arrangement, tonicPc, scaleId) {
        // ALL_NOTES_ID draws the actual note LETTER at every fret/string,
        // not a dot — Leah's explicit ask 2026-09-05: "My goal for that was
        // to have all the letter notes displayed instead of the dots." A
        // real scale, by contrast, still draws dots (the shape/pattern is
        // the point there, not each individual pitch's name). No interval
        // filter and no tonic/root distinction for All Notes either — it's
        // a flat chromatic reference, not relative to anything.
        const isAllNotes = scaleId === ALL_NOTES_ID || scaleId === ALL_NOTES_INLAY_ID;
        const isRootOnly = scaleId === ROOT_ONLY_ID;
        if (isAllNotes || isRootOnly) {
            const inlayOnly = scaleId === ALL_NOTES_INLAY_ID;
            const fontPx = Math.max(8, Math.min(W, H) * 0.018) * settings.scaleDotSizeMul;
            const alpha = settings.scaleDotOpacity / 100;
            ctx.font = Math.round(fontPx) + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = Math.max(1, fontPx * 0.15);
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#000000';
            ctx.globalAlpha = alpha;
            for (let i = 0; i < grid.length; i++) {
                const p = grid[i];
                // Open strings (f===0) count as a marker position too, same
                // as the real inlay frets — Leah's ask 2026-09-06: the nut
                // is as natural a reference point as the dot inlays are.
                if (inlayOnly && p.f !== 0 && !INLAY_FRETS.has(p.f)) continue;
                const midi = noteMidi(tuning, capo, arrangement, p.s, p.f);
                // Root Note Only: skip every position that isn't the current
                // key's tonic pitch class — the whole point of this mode.
                if (isRootOnly && ((Math.round(midi) % 12) + 12) % 12 !== tonicPc) continue;
                const letter = letterForMidi(midi);
                const sx = openStringShiftedSx(grid, i, p);
                const px = ((sx + 1) / 2) * W;
                const py = ((1 - p.sy) / 2) * H;
                ctx.fillStyle = settings.matchGemColor ? gemColorForString(p.s) : settings.color;
                ctx.strokeText(letter, px, py);
                ctx.fillText(letter, px, py);
            }
            ctx.globalAlpha = 1;
            return;
        }
        // Real scale ids: dots or note letters (settings.scaleDisplayMode),
        // colored either by the plain Letter color or per-string fret color
        // (settings.scaleUseFretColor, same on/off convention as
        // matchGemColor/matchGemRow — no separate color picker, reuses
        // settings.color). Root notes are distinguished by size/opacity
        // (dots mode) — see this file's own memory for why not a separate
        // color there too.
        const intervals = SCALE_INTERVALS[scaleId];
        const baseAlpha = settings.scaleDotOpacity / 100;
        const rootAlpha = Math.min(1, baseAlpha + 0.3);
        const asNotes = settings.scaleDisplayMode === 'notes';
        if (asNotes) {
            const fontPx = Math.max(8, Math.min(W, H) * 0.018) * settings.scaleDotSizeMul;
            ctx.font = Math.round(fontPx) + 'px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineWidth = Math.max(1, fontPx * 0.15);
            ctx.lineJoin = 'round';
            ctx.strokeStyle = '#000000';
        }
        const RADIUS = Math.max(2, Math.min(W, H) * 0.006) * settings.scaleDotSizeMul;
        for (let i = 0; i < grid.length; i++) {
            const p = grid[i];
            const midi = noteMidi(tuning, capo, arrangement, p.s, p.f);
            const degree = ((midi % 12) - tonicPc + 12) % 12;
            if (!intervals.includes(degree)) continue;
            const isRoot = degree === 0;
            // NDC (-1..1, +y up) -> canvas pixels (+y down), same conversion
            // the gem/letter path above uses.
            const sx = openStringShiftedSx(grid, i, p);
            const px = ((sx + 1) / 2) * W;
            const py = ((1 - p.sy) / 2) * H;
            const fillColor = settings.scaleUseFretColor ? gemColorForString(p.s) : settings.color;
            ctx.globalAlpha = isRoot ? rootAlpha : baseAlpha;
            if (asNotes) {
                ctx.fillStyle = fillColor;
                const letter = letterForMidi(midi);
                ctx.strokeText(letter, px, py);
                ctx.fillText(letter, px, py);
            } else {
                ctx.beginPath();
                ctx.arc(px, py, isRoot ? RADIUS * 1.6 : RADIUS, 0, Math.PI * 2);
                ctx.fillStyle = fillColor;
                ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
    }

    // The static fret-inlay position dots (highway_3d's window.h3dBgSetInlayDotsVisible,
    // added specifically for this) visually compete with the scale overlay's own
    // fret-position dots — Leah's call: auto-hide the inlay dots whenever the
    // scale overlay is actually drawing, restore them the instant it isn't,
    // rather than a separate manual toggle the user has to remember to flip.
    // Tracks the last-applied state so this only calls the core setter (which
    // writes to localStorage) on an actual transition, not every frame.
    let _inlayDotsHiddenForScale = false;
    function setInlayDotsHiddenForScale(hide) {
        if (hide === _inlayDotsHiddenForScale) return;
        _inlayDotsHiddenForScale = hide;
        if (window.h3dBgSetInlayDotsVisible) window.h3dBgSetInlayDotsVisible(!hide);
    }

    // Same idea as setInlayDotsHiddenForScale above, but for highway_3d's
    // own open-string pitch labels over the headstock
    // (window.h3dBgSetTuningLabelsVisible) — this overlay's own open-string
    // (fret 0) markers are pulled back toward that same spot
    // (openStringShiftedSx) whenever a scale is active, so the core labels
    // would otherwise sit right on top of / next to them. Leah's ask
    // 2026-09-06.
    let _tuningLabelsHiddenForScale = false;
    function setTuningLabelsHiddenForScale(hide) {
        if (hide === _tuningLabelsHiddenForScale) return;
        _tuningLabelsHiddenForScale = hide;
        if (window.h3dBgSetTuningLabelsVisible) window.h3dBgSetTuningLabelsVisible(!hide);
    }

    function findMounts() {
        // Prefer the tour-marked primary instance (highway_3d supports
        // multiple .h3d-wrap elements under splitscreen — see its own
        // screen.js comment on data-h3d-primary) so this doesn't silently
        // attach to a secondary/hidden instance when more than one exists.
        // Falls back to the first match when nothing's marked primary yet
        // (e.g. very early in load).
        wrap = document.querySelector('.h3d-wrap[data-h3d-primary]') || document.querySelector('.h3d-wrap');
        return !!wrap;
    }

    function ensureOverlay() {
        // `overlay.isConnected` alone isn't enough: highway_3d can have
        // MULTIPLE .h3d-wrap instances alive at once (one per screen/mode —
        // e.g. the normal player screen and a Virtuoso jam session each get
        // their own), and switching between them doesn't disconnect the old
        // one from the document, just leaves it unused/zero-sized while a
        // NEW wrap becomes the current `.h3d-wrap[data-h3d-primary]`. Bug
        // found live 2026-09-05: overlay created while Virtuoso was active
        // stayed attached to Virtuoso's own (now-stale, 0x0) wrap instance
        // after switching back to the normal player screen — still
        // `.isConnected` (never removed from the DOM), so this returned
        // early and never re-parented to the new primary wrap, leaving the
        // scale overlay silently dead on real songs. Now also checks the
        // overlay's actual parent matches the CURRENT primary/first wrap
        // every call, re-mounting (not recreating — same canvas/ctx, just
        // moved) whenever the current wrap has changed out from under it.
        if (overlay && overlay.isConnected) {
            const currentWrap = document.querySelector('.h3d-wrap[data-h3d-primary]') || document.querySelector('.h3d-wrap');
            if (currentWrap && overlay.parentElement === currentWrap) {
                wrap = currentWrap;
                return true;
            }
            if (currentWrap) {
                wrap = currentWrap;
                wrap.appendChild(overlay);
                return true;
            }
            // No wrap exists at all right now (mid-transition) — keep the
            // existing overlay/ctx as-is rather than tearing anything down.
            return true;
        }
        if (!findMounts()) return false;
        overlay = document.createElement('canvas');
        overlay.className = 'dnl-overlay';
        overlay.style.cssText = 'position:absolute;top:0;left:0;z-index:0;pointer-events:none;';
        wrap.appendChild(overlay);
        ctx = overlay.getContext('2d');
        return true;
    }

    function syncOverlaySize() {
        if (!wrap || !overlay) return;
        // Measure the real #highway canvas, not .h3d-wrap itself — wrap is
        // built by highway_3d as a zero-height absolute positioning anchor
        // (position:absolute;top:0;left:0;right:0 with no bottom/height —
        // see its own screen.js), so its own getBoundingClientRect() reads
        // 0x0 EVERY frame regardless of what's actually rendering inside it.
        // #highway is the real feedBack canvas element .h3d-wrap sits beside
        // (inserted as its next sibling), and carries the actual pixel size
        // — ON THE NORMAL PLAYER SCREEN. While Virtuoso is active, #highway
        // still EXISTS in the DOM (it's not removed, just not the visible
        // screen) and reports 0x0, while `wrap` (highway_3d's own mount for
        // Virtuoso's jam session) is the one with the real size — the exact
        // opposite of the normal-screen case (found 2026-09-05: nothing drew
        // at all in Virtuoso, canvas measured 1x1). So prefer whichever
        // element actually HAS size this frame, not just whichever exists —
        // `document.getElementById('highway') || wrap` alone only falls
        // back when #highway is completely absent, never when it's present
        // but zero-sized.
        const highwayEl = document.getElementById('highway');
        const highwayRect = highwayEl ? highwayEl.getBoundingClientRect() : null;
        const sizeSrc = (highwayRect && highwayRect.width > 0 && highwayRect.height > 0) ? highwayEl : wrap;
        const r = sizeSrc.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (overlay.width !== w || overlay.height !== h) {
            overlay.width = w;
            overlay.height = h;
        }
        overlay.style.width = r.width + 'px';
        overlay.style.height = r.height + 'px';
        overlay.style.left = '0px';
        overlay.style.top = '0px';
    }

    // Tracks the last-seen Virtuoso active state so the pane only auto-opens
    // ONCE on the false->true transition, not every frame while Virtuoso
    // stays active (which would fight anyone who manually closes the pane
    // while still on that screen). Polled from the draw() loop rather than
    // a screen-change event — this file already got burned once by a
    // Virtuoso event not firing reliably (song:loaded, see effectiveKeyTonic
    // above), so checking real DOM state every frame is the safer bet here too.
    let _lastVirtuosoActiveForAutoOpen = false;
    function checkAutoOpenPaneInVirtuoso() {
        const active = isVirtuosoActive();
        if (active && !_lastVirtuosoActiveForAutoOpen && settings.autoOpenPaneInVirtuoso) {
            const panes = window.feedBack && window.feedBack.panes;
            if (panes && typeof panes.open === 'function') panes.open('highway_notation');
        }
        _lastVirtuosoActiveForAutoOpen = active;
    }

    function draw() {
        rafId = requestAnimationFrame(draw);
        checkAutoOpenPaneInVirtuoso();

        // One-time 2D draw-hook registration, done here purely because this
        // RAF loop always runs regardless of which renderer is mounted, so
        // it's a convenient place to notice window.highway becoming ready —
        // NOT because draw2D is otherwise related to this 3D path.
        if (!hw2dHookRegistered && window.highway && typeof window.highway.addDrawHook === 'function') {
            window.highway.addDrawHook(draw2D);
            hw2dHookRegistered = true;
        }

        const gems = window.__h3dGemPositions;
        const grid = window.__h3dFretGridPositions;
        const haveGems = Array.isArray(gems) && gems.length;
        // The fret-grid bridge is a static per-string/per-fret board, always
        // published while highway_3d is mounted — unlike gems, which are only
        // present when the chart has notes visible right now. The full-neck
        // scale overlay must stay on its own even with no notes on screen
        // (that's the whole point — not tied to what the current song uses),
        // so this can't gate on gems the way the note-letter path always has.
        const haveGrid = Array.isArray(grid) && grid.length;
        if (!haveGems && !haveGrid) {
            if (ctx && overlay) ctx.clearRect(0, 0, overlay.width, overlay.height);
            return;
        }
        if (!ensureOverlay()) return;
        syncOverlaySize();
        if (!ctx || !overlay.width || !overlay.height) return;

        const hw = window.highway;
        const songInfo = hw && hw.getSongInfo ? hw.getSongInfo() : null;
        const tuning = hw && hw.getTuning ? hw.getTuning() : (songInfo && songInfo.tuning);
        const capo = hw && hw.getCapo ? hw.getCapo() : (songInfo && songInfo.capo);
        const arrangement = songInfo && songInfo.arrangement;

        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // Computed up front (independent of haveGrid — effectiveScaleName
        // only needs hw/t) so the gem-letter loop below can know whether a
        // letter-drawing board overlay (All Notes / All Notes inlay-only /
        // Root Note Only) is currently active, and if so, suppress a FLYING
        // gem's own letter once it strikes the board — the static board
        // overlay already shows that same letter permanently at that
        // position, so the gem's own label would otherwise land exactly on
        // top of it right at (and after) the moment it hits. Got this
        // backwards on the first pass (bug found live 2026-09-05, "we have
        // it backwards"): suppressing the STATIC board letter instead made
        // the always-on reference blink out for as long as an approaching
        // note was simply in flight toward that fret — wrong direction
        // entirely. The static overlay must stay uninterrupted; it's the
        // transient gem letter that should yield once it's redundant.
        // Corrected for A/V offset (see the chord struck-position fix's own
        // comment, same root cause) — this nowT is compared against g.t to
        // decide gem-letter suppression timing below, which needs to match
        // the RENDER clock the gem's on-screen position is actually drawn
        // against, not the raw audio clock.
        const avOffsetSec = hw && hw.getAvOffset ? (hw.getAvOffset() / 1000) : 0;
        const nowT = hw && hw.getTime ? hw.getTime() + avOffsetSec : 0;
        const scaleId = effectiveScaleName(hw, nowT);
        const isAllNotesOrRoot = scaleId === ALL_NOTES_ID || scaleId === ALL_NOTES_INLAY_ID || scaleId === ROOT_ONLY_ID;
        const needsTonic = scaleId === ROOT_ONLY_ID || (scaleId && !!SCALE_INTERVALS[scaleId]);
        const isAllNotes = scaleId === ALL_NOTES_ID || scaleId === ALL_NOTES_INLAY_ID;
        const tonicPc = (!isAllNotes && needsTonic) ? effectiveKeyTonic(hw, nowT) : null;
        // isPlayerScreenActive() OR isVirtuosoActive() gate: forces the
        // dots back on the moment the song exits (back to library/home),
        // rather than trusting a specific "song ended"/"song unloaded"
        // event to fire — this file already ran into an event not firing
        // reliably once (Virtuoso's missing song:loaded, see
        // effectiveKeyTonic above), so checking real screen state
        // directly every frame is the safer bet here. MUST include
        // isVirtuosoActive() too — Virtuoso is its OWN screen (#plugin-
        // virtuoso), never #player, so checking isPlayerScreenActive()
        // alone silently killed the entire overlay while Virtuoso was
        // active (bug found 2026-09-05: key/scale resolved and showed
        // correctly in the pane, but nothing drew on the highway).
        const scaleDrawing = (isAllNotes || (needsTonic && tonicPc !== null
            && tonicPc !== undefined)) && (isPlayerScreenActive() || isVirtuosoActive());
        const isRealScale = scaleId && !isAllNotesOrRoot && !!SCALE_INTERVALS[scaleId];
        // Suppress a struck gem's own letter whenever the scale overlay is
        // marking that same position AT ALL — dots included, not just the
        // letters display mode. Changed 2026-09-06 per Leah's ask: the
        // fretboard letter should follow the same "don't show once the
        // scale overlay already marks it" rule regardless of whether that
        // mark is a dot or a letter, not just the notes-mode overlap case
        // this was originally added for.
        const suppressStruckGemLetters = scaleDrawing && (isAllNotesOrRoot || isRealScale);

        // Draw order matters here: the scale/board overlay (dots or static
        // letters) draws FIRST, gem note-letters draw SECOND — so the gem
        // letters paint on TOP of the scale dots, not underneath them. Bug
        // found live 2026-09-05 ("we're just trying to make sure the
        // letters are on top of the scale dots. It's just a layering order
        // issue."): this used to be the other way around (gems drawn first,
        // scale overlay drawn after), so the dots painted over the letters
        // instead. Plain canvas z-order — nothing to do with position data.
        if (haveGrid) {
            if (scaleDrawing) {
                renderScaleOverlay(ctx, grid, overlay.width, overlay.height, tuning, capo, arrangement, tonicPc, scaleId);
            }
            setInlayDotsHiddenForScale(!!scaleDrawing);
            setTuningLabelsHiddenForScale(!!scaleDrawing);
        }

        if (haveGems) {
            // Letter height in highway K-units (the same world-space scale unit
            // highway_3d sizes gems/labels against), user-adjustable via the
            // settings panel. highway_3d's own fret-number labels use a sprite
            // scale of ~7.0*K, so that's the default here too (1*K alone projects
            // to only a few px — confirmed live, invisible). Derived per-gem below
            // from sxK, the bridge's second projected point one K-unit away, so
            // text tracks the gem's real perspective scale at that distance
            // rather than a fixed pixel size.
            const entries = [];
            for (const g of gems) {
                if (!Number.isFinite(g.sxK)) continue;
                // Only suppress THIS gem's own letter if the static board
                // overlay would actually draw a replacement letter at its
                // exact position — bug found live 2026-09-05 ("we lost the
                // other notes... in root only or inlay only, the other notes
                // do not strike the fretboard"): suppression was applied to
                // EVERY struck gem regardless of mode, so in Root Note Only
                // (which only draws a letter at the tonic pitch class) or
                // All Notes (inlay only) (which only draws at the marker
                // frets), a struck NON-root or NON-inlay-fret note lost its
                // own letter with no static replacement ever appearing —
                // it just vanished. Confirmed by "if I go none, they come
                // back": with the board overlay off (suppressStruckGemLetters
                // false), every gem's own letter was fine again.
                let hasStaticReplacement = false;
                if (suppressStruckGemLetters) {
                    if (scaleId === ALL_NOTES_ID) hasStaticReplacement = true;
                    else if (scaleId === ALL_NOTES_INLAY_ID) hasStaticReplacement = g.f === 0 || INLAY_FRETS.has(g.f);
                    else if (scaleId === ROOT_ONLY_ID) {
                        const gMidi = noteMidi(tuning, capo, arrangement, g.s, g.f);
                        hasStaticReplacement = ((Math.round(gMidi) % 12) + 12) % 12 === tonicPc;
                    } else if (isRealScale) {
                        // Mirrors renderScaleOverlay's own degree-in-scale
                        // check — only suppress this gem's own letter if the
                        // scale overlay actually draws a marker (dot OR
                        // letter, see suppressStruckGemLetters above) at this
                        // exact pitch; non-scale-tone frets get no overlay
                        // marker at all, so the gem's own letter must stay
                        // there.
                        const gMidi = noteMidi(tuning, capo, arrangement, g.s, g.f);
                        const degree = ((Math.round(gMidi) % 12) - tonicPc + 12) % 12;
                        hasStaticReplacement = SCALE_INTERVALS[scaleId].includes(degree);
                    }
                }
                // "Struck" = its onset time has reached/passed now — the gem
                // is at or past the hit line, not still approaching. Cuts
                // off immediately at that instant — a 200ms hang time was
                // tried here (STRIKE_SUPPRESS_LAG_SEC) but caused the gem's
                // own letter to visibly overlap the static board letter
                // right at the hit line, so it was dropped 2026-09-06.
                if (hasStaticReplacement && g.t <= nowT) continue;
                // NDC (-1..1, +y up) -> canvas pixels (+y down).
                const px = ((g.sx + 1) / 2) * overlay.width;
                const py = ((1 - g.sy) / 2) * overlay.height;
                const pxPerK = Math.abs(g.sxK - g.sx) / 2 * overlay.width;
                // fontPxUnit: per-gem size scale BEFORE the sizeK/chordSizeK
                // multiplier is applied — that multiplier now happens inside
                // renderNoteLetters, once it knows whether this entry is a
                // chord name or a single-note letter (settings.sizeK vs
                // settings.chordSizeK, split 2026-09-05 into two independent
                // sliders). Previously baked sizeK in here directly since
                // there was only ever one size setting.
                entries.push({ s: g.s, f: g.f, t: g.t, px, py, fontPxUnit: pxPerK });
            }
            // Chord-frame bridge (window.__h3dChordFramePositions, core 2026-09-05):
            // the strum-bar frame's real screen quad per visible chord, so a
            // chordMode 'name' label can anchor to the actual frame instead of
            // approximating it from which strings happen to be voiced (the old
            // method drifted when a chord's frame is wider than its voiced
            // notes — e.g. a partial/muted-string voicing). Converted to canvas
            // px/py here (same NDC conversion as the gems above) since
            // renderNoteLetters doesn't otherwise know the overlay's pixel size.
            // 2D-only fallback: this bridge is 3D-only (highway_3d core), so
            // draw2D() below never has chordFrames and always uses the
            // voiced-span fallback in renderNoteLetters.
            const rawChordFrames = window.__h3dChordFramePositions;
            let chordFrames = null;
            if (Array.isArray(rawChordFrames) && rawChordFrames.length) {
                const ndcToPx = (x) => ((x + 1) / 2) * overlay.width;
                const ndcToPy = (y) => ((1 - y) / 2) * overlay.height;
                chordFrames = rawChordFrames.map((f) => ({
                    id: f.id, t: f.t,
                    tlx: ndcToPx(f.tlx), tly: ndcToPy(f.tly),
                    trx: ndcToPx(f.trx), trY: ndcToPy(f.trY),
                    blx: ndcToPx(f.blx), bly: ndcToPy(f.bly),
                    brx: ndcToPx(f.brx), brY: ndcToPy(f.brY),
                }));
            }
            renderNoteLetters(ctx, entries, tuning, capo, arrangement, hw, chordFrames);
        }
    }

    // ── 2D path ───────────────────────────────────────────────────────────
    // Registered as a highway draw hook (window.highway.addDrawHook, see
    // draw() above) rather than owning its own overlay canvas — it paints
    // straight onto the highway's own canvas/context on the SAME frame the
    // highway draws, using the highway's own coordinate helpers.
    const HW2D_VISIBLE_SECONDS = 3.0; // matches core's own VISIBLE_SECONDS window
    function draw2D(ctx2d, W, H) {
        const hw = window.highway;
        if (!hw || typeof hw.project !== 'function' || typeof hw.fretX !== 'function') return;
        // This path positions everything with the 2D highway's own
        // projection (hw.project/hw.fretX). A custom renderer (3D Highway,
        // piano, ...) has different geometry and fires this same hook
        // against ITS OWN overlay layer — so these letters would land in
        // meaningless places there. Bail when a non-default renderer is
        // active; the 3D path above (window.__h3dGemPositions) is what
        // draws letters for highway_3d instead. Mirrors notedetect's
        // drawOverlay, which hit exactly this as slopsmith#254. Older cores
        // without isDefaultRenderer → assume 2D (matches notedetect too).
        if (hw.isDefaultRenderer && !hw.isDefaultRenderer()) return;

        const songInfo = hw.getSongInfo ? hw.getSongInfo() : null;
        const tuning = hw.getTuning ? hw.getTuning() : (songInfo && songInfo.tuning);
        const capo = hw.getCapo ? hw.getCapo() : (songInfo && songInfo.capo);
        const arrangement = songInfo && songInfo.arrangement;

        const t = hw.getTime ? hw.getTime() : 0;
        const avOffset = hw.getAvOffset ? hw.getAvOffset() / 1000 : 0;
        const renderT = t + avOffset;

        // hw.getFilteredNotes() already includes every individual note
        // event, chord members included (confirmed against core's own
        // drawNotes(), which iterates this exact array to draw every flying
        // gem) — same flattened shape __h3dGemPositions gives the 3D path,
        // so no separate chord-template expansion is needed here.
        const notes = (hw.getFilteredNotes ? hw.getFilteredNotes() : null) || [];
        const entries = [];
        for (const n of notes) {
            const tOff = n.t - renderT;
            // Small past-grace so a note doesn't vanish the instant it
            // crosses the strike line; skip anything not yet in the
            // highway's own visible window.
            if (tOff < -0.15 || tOff > HW2D_VISIBLE_SECONDS) continue;
            const p = hw.project(tOff);
            if (!p) continue;
            const scale = p.scale || 1;
            // Open strings (fret 0) are a special case: core's own drawNote()
            // ignores fretX() for them entirely and centers the open-string
            // bar at W/2 (highway-draw.js) — fretX(0, ...) is just whatever
            // the fret-spacing formula extrapolates to at fret 0, which is
            // NOT "the open string position" and lands close to fret 1's
            // spot (confirmed live — that's what was showing up wrong).
            const px = n.f === 0 ? (W / 2) : hw.fretX(n.f, scale, W);
            const py = p.y * H;
            // Font size basis independent from the 3D path's K-units (there's
            // no equivalent concept here): derived from the actual on-screen
            // spacing between adjacent frets at this note's own scale, so
            // text tracks perspective the same way the 3D path's sxK does.
            // settings.sizeK (default 5.0) is the SAME slider as the 3D path
            // uses, kept as a relative multiplier here rather than literal
            // matching units — sizeK/5.0 so the slider's default position
            // looks reasonable on both renderers without needing a second
            // per-renderer size setting.
            const fretPx = Math.abs(hw.fretX(n.f + 1, scale, W) - hw.fretX(n.f, scale, W));
            // fontPxUnit: sizeK/chordSizeK multiplier applied in
            // renderNoteLetters, once it knows single-note vs. chord-name.
            const fontPxUnit = fretPx * 0.5 / 5.0;
            entries.push({ s: n.s, f: n.f, t: n.t, px, py, fontPxUnit });
        }

        // Chord notes are NOT in getFilteredNotes() at all on the 2D
        // highway — confirmed against core's own drawChords()
        // (highway-draw.js), which reads each chord instance's OWN
        // `.notes` array (from hw.getFilteredChords()) and positions them
        // with a deliberately STACKED layout (one column per chord, not
        // each note at its own natural row) rather than each note's normal
        // project()-derived position. Without this second pass, chord
        // notes silently got no letters at all (2026-09-03 bug report).
        //
        // This replicates core's stacking geometry (sz/spread/actualSpread
        // formulas) closely enough for letters to land on the visible
        // gems, but is an approximation, not a byte-for-byte port:
        //   - baseFret uses a simple "lowest fretted note in THIS chord"
        //     heuristic; core's real baseFret can inherit from a PREVIOUS
        //     chord in a chain (open/all-muted chords with no fretted note
        //     of their own) — a state machine that isn't exposed to
        //     plugins at all. Only affects the rare open/muted-with-no-
        //     fretted-note case.
        //   - Chain/repeat-box collapsing (only the first strum in a
        //     repeated chord chain draws full individual gems; later ones
        //     draw a translucent box with no per-note gems at all) isn't
        //     replicated — this always draws individual letters, even for
        //     a chord instance core would render as a collapsed box.
        const chords = (hw.getFilteredChords ? hw.getFilteredChords() : null) || [];
        const templates = (hw.getChordTemplates ? hw.getChordTemplates() : null) || [];
        const inverted = hw.getInverted ? !!hw.getInverted() : false;
        // Mirrors core's CHORD_FRAME_FRETS (static/js/highway-constants.js)
        // — not plugin-accessible, so hardcoded. Only used to center an
        // open-string note's letter on core's wide bar, same as the
        // standalone-note path above; a future core change to that
        // constant would only shift open-in-chord letters slightly, not
        // break anything.
        const CHORD_FRAME_FRETS = 4;
        for (const ch of chords) {
            if (!Array.isArray(ch.notes) || !ch.notes.length) continue;
            const tOff = ch.t - renderT;
            if (tOff < -0.15 || tOff > HW2D_VISIBLE_SECONDS) continue;
            const p = hw.project(tOff);
            if (!p) continue;
            const scale = p.scale || 1;
            const tmpl = templates[ch.id];
            const tmplFrets = tmpl && tmpl.frets ? tmpl.frets : [];
            const getTemplateFret = (cn) => (cn.s < tmplFrets.length ? tmplFrets[cn.s] : cn.f);
            const sorted = ch.notes.slice().sort((a, b) => inverted ? b.s - a.s : a.s - b.s);
            const nonZeroFrets = sorted.map(getTemplateFret).filter((f) => f !== 0);
            const baseFret = nonZeroFrets.length ? Math.min(...nonZeroFrets) : 0;
            const hasMultipleNotes = sorted.length > 1;
            const sz = Math.max(10, 28 * scale * (H / 900));
            const actualSpread = Math.max(sz * 0.85, sz + 16 * scale);
            const actualTotalH = actualSpread * Math.max(0, sorted.length - 1);
            const fretPx = Math.abs(hw.fretX(1, scale, W) - hw.fretX(0, scale, W));
            const fontPxUnit = fretPx * 0.5 / 5.0;
            for (let j = 0; j < sorted.length; j++) {
                const cn = sorted[j];
                const templateFret = getTemplateFret(cn);
                const py = p.y * H - actualTotalH / 2 + j * actualSpread;
                const px = (templateFret === 0 && hasMultipleNotes)
                    ? (hw.fretX(baseFret, scale, W) + hw.fretX(baseFret + CHORD_FRAME_FRETS, scale, W)) / 2
                    : hw.fretX(cn.f, scale, W);
                entries.push({ s: cn.s, f: cn.f, t: ch.t, px, py, fontPxUnit });
            }
        }

        renderNoteLetters(ctx2d, entries, tuning, capo, arrangement, hw);
    }

    function start() {
        if (rafId) return;
        rafId = requestAnimationFrame(draw);
    }

    function stop() {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        if (overlay && overlay.parentElement) overlay.parentElement.removeChild(overlay);
        overlay = null; ctx = null; wrap = null;
        if (hw2dHookRegistered && window.highway && typeof window.highway.removeDrawHook === 'function') {
            window.highway.removeDrawHook(draw2D);
        }
        // Safety net for setCoreChordNameVisible's own concern: if this
        // plugin is stopping while chordMode 'name' had core's own chord
        // name hidden, put it back rather than leaving core in that state
        // with nothing left running to ever restore it.
        setCoreChordNameVisible(true);
    }

    // Screen presence isn't tied to a nav entry (this plugin has none) — just
    // run for as long as the page is open. Each renderer path is a cheap
    // no-op on its own when that renderer isn't the one mounted (3D: empty
    // __h3dGemPositions; 2D: isDefaultRenderer() false).
    start();
    window.addEventListener('beforeunload', stop);

    // ── Panes registration ───────────────────────────────────────────────
    // The actual settings surface: a floating panel via window.feedBack.panes
    // (static/panes/pane-manager.js) — the same system Camera Director and
    // Stem Mixer use, opened from the sidebar's Panes popup. Stays open while
    // playing and across song switches (the manager's own behavior, nothing
    // this plugin has to implement). Builds its own tiny DOM panel rather than
    // loading settings.html, since a pane's `element` is a real live DOM node,
    // not a separate settings-screen template.
    function buildPanel() {
        const panel = document.createElement('div');
        // max-height + overflow-y: the desktop build's pane window never
        // auto-resizes to fit content (see registerPane's onHost below) — it
        // just reuses whatever bounds Electron remembered from a previous
        // open. As rows get added over time that remembered window can end
        // up shorter than the panel, and without this, the extra content
        // would be silently clipped past the window's edge with no way to
        // reach it. 100vh keeps it scrollable within whatever the window's
        // actual height is, in the browser-popup case too.
        panel.style.cssText = 'background:#0b1220;border:1px solid #1f2937;border-radius:10px;padding:14px;width:460px;max-height:100vh;overflow-y:auto;box-sizing:border-box;color:#d1d5db;font:12px sans-serif;';

        // Checkbox rows: only the checkbox itself (plus a small 3px margin on
        // every side, for an easier click target) should be clickable — not
        // the whole row's width, which is how a <label> wrapping both the
        // input and its text normally behaves. So the <label> here wraps ONLY
        // the checkbox (padding 3px, no compensating negative margin — that
        // was tried first and caused two real bugs: the panel's scrollHeight
        // undercounted the overflowing content, which fed straight into the
        // pane's auto-resize math and shrank the whole host window on open;
        // and the overlapping negative-margin box created an ambiguous hover
        // boundary against the sibling text, flickering the cursor between
        // pointer/default. Plain padding stays inside normal layout flow —
        // costs a few px of extra row spacing, nothing else.) and the text is
        // a plain, non-clickable sibling text node.
        const mkCb = (checked, onChange) => {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:inline-flex;padding:3px;cursor:pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.cursor = 'pointer';
            cb.checked = checked;
            cb.addEventListener('change', () => onChange(cb.checked));
            wrap.appendChild(cb);
            return wrap;
        };

        // Optional trailing `container` param: defaults to the panel itself,
        // but the two-column row below (Highway Notations / Highway Fret
        // Settings) passes its own column <div> so those rows land side by
        // side instead of stacked.
        const mkCheckRow = (labelText, checked, onChange, container) => {
            const row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:8px;padding-left:15px;';
            const cbWrap = mkCb(checked, onChange);
            row.appendChild(cbWrap);
            row.appendChild(document.createTextNode(labelText));
            (container || panel).appendChild(row);
            return cbWrap.querySelector('input');
        };

        // Top-right "bubble" reset button — pushes every settings row down a
        // row rather than floating over the content. The click handler itself
        // is defined near the end of this function, once every control it
        // needs to update (sliders, pad, color pickers, etc.) exists — safe to
        // reference them here before their own `const` lines run because this
        // arrow function only executes on a later click, after buildPanel has
        // finished running top to bottom.
        const resetRow = document.createElement('div');
        resetRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;';
        const liveBanner = document.createElement('div');
        liveBanner.textContent = 'Notation settings update in real-time, click things to see what happens!';
        liveBanner.style.cssText = 'color:#6b7280;font:bold 14px sans-serif;text-align:left;';
        resetRow.appendChild(liveBanner);
        const resetAllBtn = document.createElement('button');
        resetAllBtn.type = 'button';
        resetAllBtn.textContent = 'Reset to Defaults';
        resetAllBtn.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:999px;color:#d1d5db;padding:6px 14px;cursor:pointer;font:12px sans-serif;flex-shrink:0;';
        resetAllBtn.addEventListener('click', () => resetAllToDefaults());
        resetRow.appendChild(resetAllBtn);
        panel.appendChild(resetRow);

        // ── Two-column row: Highway Notations | Highway Fret Settings ──────
        // Same side-by-side pattern Marquee's settings pages use. Both
        // columns are flex:1 so they split the panel's width evenly.
        const twoColRow = document.createElement('div');
        twoColRow.style.cssText = 'display:flex;gap:16px;align-items:flex-start;margin-bottom:8px;';
        const col1 = document.createElement('div');
        col1.style.cssText = 'flex:1;min-width:0;';
        const col2 = document.createElement('div');
        col2.style.cssText = 'flex:1;min-width:0;';
        const colDivider = document.createElement('div');
        colDivider.style.cssText = 'width:1px;align-self:stretch;background:#1f2937;flex-shrink:0;';
        twoColRow.appendChild(col1);
        twoColRow.appendChild(colDivider);
        twoColRow.appendChild(col2);
        panel.appendChild(twoColRow);

        const hideMarkersLabel = document.createElement('div');
        hideMarkersLabel.textContent = 'Highway Notations';
        hideMarkersLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;';
        col1.appendChild(hideMarkersLabel);

        const cbShowOpen = mkCheckRow('Show strum note', settings.showOpen, window.dnlSetShowOpen, col1);
        const cbShowFretted = mkCheckRow('Show fretted notes', settings.showFretted, window.dnlSetShowFretted, col1);
        const cbHidePalmMute = mkCheckRow('Hide palm-mute markers (Not Recommend for 2D)', settings.hidePalmMuteMarkers, window.dnlSetHidePalmMuteMarkers, col1);
        const cbHideFretHandMute = mkCheckRow('Hide fret-hand-mute markers (Not Recommend for 2D)', settings.hideFretHandMuteMarkers, window.dnlSetHideFretHandMuteMarkers, col1);

        // ── 3D Highway settings ──────────────────────────────────────────
        // These two call CORE highway_3d setters directly (window.h3dBgSet*)
        // rather than anything highway_notation owns — convenient to
        // adjust from here since they're closely related (both about
        // reducing on-screen clutter around the gems), but the actual state
        // lives in highway_3d's own settings (localStorage h3d_bg_* keys),
        // same as toggling them from Settings > Graphics > 3D Highway would.
        // No-ops (setter undefined) on an older highway_3d that predates
        // flyingFretLabelVisible — see [[highway3d-core-changes-for-upstream]].
        const hwLabel = document.createElement('div');
        hwLabel.textContent = 'Highway Fret Settings';
        hwLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin-bottom:8px;';
        col2.appendChild(hwLabel);

        // Drives highway_3d's own 'Show gems' core setting — lets the letters
        // stand in for the gems entirely instead of labeling them. No-ops if
        // the installed highway_3d predates window.h3dBgSetGemBodyVisible.
        const cbHideFretMarkers = mkCheckRow('Hide fret markers (non-chord)', settings.hideFretMarkers, window.dnlSetHideFretMarkers, col2);
        const cbHideOpenMarkers = mkCheckRow('Hide open-note markers (non-chord)', settings.hideOpenMarkers, window.dnlSetHideOpenMarkers, col2);
        const cbHideChordGems = mkCheckRow('Hide chord fret gems (3D only)', settings.hideChordGems, window.dnlSetHideChordGems, col2);
        const cbHideChordOpenGems = mkCheckRow('Hide chord open gems (3D only)', settings.hideChordOpenGems, window.dnlSetHideChordOpenGems, col2);
        // Declutter controls for the full-fretboard scale overlay (3D only,
        // no 2D equivalent) — drives core capabilities added specifically
        // for this plugin, see [[highway3d-core-changes-for-upstream]].
        const cbHideFretWires = mkCheckRow('Hide fret wires (3D only)', settings.hideFretWires, window.dnlSetHideFretWires, col2);
        const cbHideStringLines = mkCheckRow('Hide string lines (3D only)', settings.hideStringLines, window.dnlSetHideStringLines, col2);
        const cbHideFingeringNumbers = mkCheckRow('Hide fingering numbers (3D only)', settings.hideFingeringNumbers, window.dnlSetHideFingeringNumbers, col2);

        let storedFlyingFret = true, storedFretColCadence = 1, storedChordBaseFret = true, storedDynamicRow = true;
        try {
            const f = localStorage.getItem('h3d_bg_flyingFretLabelVisible');
            storedFlyingFret = f === null ? true : f !== 'false' && f !== '0';
            const c = localStorage.getItem('h3d_bg_fretColumnMarkerCadence');
            storedFretColCadence = c === null ? 1 : parseFloat(c);
            const cb = localStorage.getItem('h3d_bg_chordBaseFretLabelsVisible');
            storedChordBaseFret = cb === null ? true : cb !== 'false' && cb !== '0';
            const dr = localStorage.getItem('h3d_bg_dynamicFretRowVisible');
            storedDynamicRow = dr === null ? true : dr !== 'false' && dr !== '0';
        } catch (_) {}

        // fret-column markers and chord-base fret numbers have no matching
        // feature anywhere in the 2D highway's code — checked 2026-09-03.
        // "Flying notes" fret numbers DOES have a 2D match though: split
        // out as its own hwState._dnlFretNumberVisible flag (separate from
        // the gem-body toggle "Hide fret markers" drives), same body/number
        // split highway_3d already has — see
        // [[highway-classic-core-changes-for-upstream]].
        const cbFlyingFret = mkCheckRow('Show fret numbers on flying notes', storedFlyingFret, (v) => {
            window.h3dBgSetFlyingFretLabelVisible?.(v);
            window.highway?.setFretNumberVisible?.(v);
        }, col2);
        const cbFretColCadence = mkCheckRow('Show fret-column markers (3D only)', storedFretColCadence > 0, (v) => {
            // Cadence is a number, not a boolean — 0 disables. Restores to
            // 1 (the field's own default) when re-enabled, since the prior
            // non-zero cadence isn't preserved once it's been zeroed.
            window.h3dBgSetFretColumnMarkerCadence?.(v ? 1 : 0);
        }, col2);
        const cbChordBaseFret = mkCheckRow('Show fret numbers on chord shapes (3D only)', storedChordBaseFret, (v) => {
            window.h3dBgSetChordBaseFretLabelsVisible?.(v);
        }, col2);
        // The ACTUAL "numbers at the bottom of the screen" source (confirmed
        // live 2026-09-02, after two wrong guesses — see
        // [[highway3d-core-changes-for-upstream]]): the row directly under
        // the strings, gray at standard positions + gold across the current
        // chord anchor's fret span (e.g. "12,13,14,15"). On 2D, the closest
        // match is the fret-line chord preview (highway-draw.js's
        // _drawFretLineChordPreview) — see
        // [[highway-classic-core-changes-for-upstream]] — so this one drives
        // both core setters instead of being 3D-only.
        const cbDynamicRow = mkCheckRow('Show fret number row under strings', storedDynamicRow, (v) => {
            window.h3dBgSetDynamicFretRowVisible?.(v);
            window.highway?.setFretLinePreviewVisible?.(v);
            window.highway?.setFretRulerVisible?.(v);
        }, col2);

        // Appearance used to be its OWN full-width row below a shared
        // twoColRow — meaning it could never start until BOTH col1 (short:
        // just Highway Notations) and col2 (long: Highway Fret Settings)
        // finished, leaving a big empty gap under col1. Fixed 2026-09-06 by
        // dropping straight into the SAME col1/col2 elements instead of a
        // separate row/columns pair — each side now just keeps stacking in
        // its own flex column, so col1's Appearance content starts right
        // under Highway Notations regardless of how much longer col2 is.
        // `colDivider` (declared with twoColRow above) already stretches to
        // whichever column ends up taller, so one divider now runs the full
        // height of both sections with no extra divider needed here.
        const appearanceCol1 = col1;
        const appearanceCol2 = col2;

        const appearanceLabel = document.createElement('div');
        appearanceLabel.textContent = 'Appearance';
        appearanceLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin:14px 0 8px;border-top:1px solid #1f2937;padding-top:12px;';
        appearanceCol1.appendChild(appearanceLabel);

        // Two size sliders side by side (letter / chord name), each half of
        // col1's own width — split 2026-09-05, same day as the two separate
        // drag pads, so chord names can be sized independently from
        // single-note letters instead of sharing one slider.
        // `opts` (min/max/step/suffix) defaults to the original letter/chord
        // SIZE slider's own range (2-16 step 0.5, no suffix) — added
        // 2026-09-06 so the same slider style/markup can be reused for
        // Background opacity (0-100 step 1, '%' suffix) instead of that
        // control having its own bespoke, differently-styled markup.
        function buildSizeSlider(labelText, initialValue, setter, opts) {
            opts = opts || {};
            const min = opts.min !== undefined ? opts.min : 2;
            const max = opts.max !== undefined ? opts.max : 16;
            const step = opts.step !== undefined ? opts.step : 0.5;
            const suffix = opts.suffix || '';
            const wrap = document.createElement('div');
            wrap.style.cssText = 'flex:1;min-width:0;';
            const label = document.createElement('div');
            label.style.cssText = 'color:#d1d5db;margin-bottom:4px;';
            const valSpan = document.createElement('span');
            valSpan.textContent = String(initialValue) + suffix;
            label.textContent = labelText;
            label.appendChild(valSpan);
            wrap.appendChild(label);

            const input = document.createElement('input');
            input.type = 'range';
            input.min = String(min); input.max = String(max); input.step = String(step);
            input.value = String(initialValue);
            // width: calc(100% - 3px) fills this slider's own half-width
            // wrapper (a real flex:1 column) minus a few px of visual
            // separation, same convention as every other full-width slider
            // in this panel.
            input.style.cssText = 'width:calc(100% - 3px);margin-bottom:10px;';
            input.addEventListener('input', () => {
                valSpan.textContent = input.value + suffix;
                setter(parseFloat(input.value));
            });
            wrap.appendChild(input);
            // Same disable/grey-out convention as buildDragPad's setEnabled
            // — used by the chord name size slider, inert while chordMode
            // isn't 'name'.
            const setEnabled = (on) => {
                input.disabled = !on;
                wrap.style.opacity = on ? '1' : '0.4';
            };
            return { wrap, input, valSpan, setEnabled };
        }

        const sizeSlidersRow = document.createElement('div');
        sizeSlidersRow.style.cssText = 'display:flex;gap:10px;';
        const sizeSlider = buildSizeSlider('Letter size — ', settings.sizeK, window.dnlSetSizeK);
        const chordSizeSlider = buildSizeSlider('Chord name size — ', settings.chordSizeK, window.dnlSetChordSizeK);
        sizeSlidersRow.appendChild(sizeSlider.wrap);
        sizeSlidersRow.appendChild(chordSizeSlider.wrap);
        appearanceCol1.appendChild(sizeSlidersRow);
        // Kept for the reset-to-defaults handler below, matching prior names.
        const sizeInput = sizeSlider.input;
        const sizeValSpan = sizeSlider.valSpan;

        // Drag-pad: click/drag a dot anywhere inside a small square to push a
        // label off the gem's own center in whatever direction/distance the
        // player wants — built instead of a single-axis slider because the
        // fret-number-overlap problem this solves isn't always "move it up,"
        // it depends on gem shape, chord stacking, etc. Dot position (-1..1 on
        // each axis, center = 0,0/no offset) maps to settings via `setter` —
        // see renderNoteLetters' OFFSET_RANGE for how that maps to actual
        // on-screen pixels.
        //
        // Two separate pads, side by side (single-note letters / chord
        // names), not one shared pad with a mode selector — Leah's explicit
        // call 2026-09-05: chord names and single-note letters need
        // independent placement, and two pads read faster at a glance than
        // a selector that changes what one pad is currently editing.
        function buildDragPad(labelText, initialX, initialY, setter, padSize, resetX, resetY, xExtent, yExtentUp, yExtentDown) {
            padSize = padSize || 90;
            resetX = resetX || 0;
            resetY = resetY || 0;
            // Extents let a pad's logical value range go beyond the default
            // -1..1 (or be asymmetric per axis-direction) while keeping the
            // SAME physical 90x90 box and the SAME linear offX/offY*range
            // render formula — the box's raw -1..1 drag position is just
            // rescaled per extent before being handed to `setter`. Default
            // 1/1/1 reproduces the original symmetric behavior exactly (used
            // by the letter pad), so only a pad that's explicitly passed
            // different extents (the chord pad) is affected.
            xExtent = xExtent || 1;
            yExtentUp = yExtentUp || 1;
            yExtentDown = yExtentDown || 1;
            const wrap = document.createElement('div');
            const label = document.createElement('div');
            label.style.cssText = 'color:#d1d5db;margin-bottom:4px;';
            label.textContent = labelText;
            wrap.appendChild(label);

            const padRow = document.createElement('div');
            padRow.style.cssText = 'display:flex;align-items:center;gap:10px;margin-bottom:10px;';
            const pad = document.createElement('div');
            pad.style.cssText = `position:relative;width:${padSize}px;height:${padSize}px;background:#1f2937;border:1px solid #374151;border-radius:6px;cursor:pointer;touch-action:none;flex-shrink:0;`;
            const crosshairV = document.createElement('div');
            crosshairV.style.cssText = 'position:absolute;left:50%;top:0;bottom:0;width:1px;background:#374151;transform:translateX(-50%);';
            const crosshairH = document.createElement('div');
            crosshairH.style.cssText = 'position:absolute;top:50%;left:0;right:0;height:1px;background:#374151;transform:translateY(-50%);';
            pad.appendChild(crosshairV);
            pad.appendChild(crosshairH);
            const dot = document.createElement('div');
            dot.style.cssText = 'position:absolute;width:10px;height:10px;background:#e8c040;border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;';
            pad.appendChild(dot);

            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.textContent = 'Reset';
            resetBtn.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:5px 10px;cursor:pointer;font:12px sans-serif;';

            // The pad's visual CENTER is the reset point (resetX/resetY), not
            // logical (0,0) — so hitting Reset always puts the dot back in
            // the middle of the box (the expected "reset" look) while still
            // landing on whatever position was actually chosen as the good
            // default. Dragging is relative to that center: raw -1..1 maps
            // to (resetX/Y + raw*extent), same extent-per-direction scaling
            // as before, just re-origined. Letter pad passes resetX=resetY=0,
            // so this is a no-op there — identical to the old behavior.
            const toRaw = (x, y) => {
                const dx = x - resetX, dy = y - resetY;
                return {
                    rx: Math.max(-1, Math.min(1, dx / xExtent)),
                    ry: Math.max(-1, Math.min(1, dy / (dy < 0 ? yExtentUp : yExtentDown))),
                };
            };
            const setDotFromOffset = (x, y) => {
                const { rx, ry } = toRaw(x, y);
                dot.style.left = ((rx + 1) / 2 * padSize) + 'px';
                dot.style.top = ((ry + 1) / 2 * padSize) + 'px';
            };
            setDotFromOffset(initialX, initialY);

            const applyFromEvent = (e) => {
                const r = pad.getBoundingClientRect();
                const rawX = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
                const rawY = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
                const x = resetX + rawX * xExtent;
                const y = resetY + rawY * (rawY < 0 ? yExtentUp : yExtentDown);
                setDotFromOffset(x, y);
                setter(x, y);
            };
            let dragging = false;
            pad.addEventListener('pointerdown', (e) => {
                dragging = true;
                pad.setPointerCapture(e.pointerId);
                applyFromEvent(e);
            });
            pad.addEventListener('pointermove', (e) => { if (dragging) applyFromEvent(e); });
            pad.addEventListener('pointerup', () => { dragging = false; });
            pad.addEventListener('pointercancel', () => { dragging = false; });
            resetBtn.addEventListener('click', () => {
                setDotFromOffset(resetX, resetY);
                setter(resetX, resetY);
            });

            padRow.appendChild(pad);
            padRow.appendChild(resetBtn);
            wrap.appendChild(padRow);
            // Lets a pad be greyed out/disabled when its position has no
            // effect — e.g. the chord pad while chordMode isn't 'name', see
            // the chordSelect wiring below. Only touches the pad+reset
            // button, not the whole wrap, so anything else appended into
            // the pad's own column (the chord-mode dropdown itself, its
            // checkboxes) stays interactive.
            const setEnabled = (on) => {
                pad.style.pointerEvents = on ? 'auto' : 'none';
                pad.style.opacity = on ? '1' : '0.4';
                resetBtn.disabled = !on;
                resetBtn.style.opacity = on ? '1' : '0.4';
            };
            return { wrap, setDotFromOffset, setEnabled };
        }

        const letterPad = buildDragPad('Letter position (drag)', settings.offsetX, settings.offsetY, window.dnlSetOffset);
        // Chord pad is the SAME visual size (90x90) as the letter pad. Reach
        // was originally a perspective-scaled multiplier (2x, then 4x per
        // Leah's asks), but that scaling itself turned out to be the wrong
        // approach — see CHORD_OFFSET_MAX_PX in renderNoteLetters, which
        // replaced it with a flat pixel distance after a screenshot showed
        // the perspective-scaled version making the label drift further
        // from its own chord frame the closer the chord got to the hit line.
        // Reset target for the chord pad only — (0,0) anchors on the chord
        // frame's BOTTOM-edge center (see chordCenterOf), and with left/
        // middle text alignment that reads as "bottom-right of the box" once
        // drawn. Nudging Reset's target left+up instead of changing the
        // anchor itself, OFFSET_RANGE, or the struck-position correction
        // keeps every already-tuned live position (chordOffsetX/Y,
        // chordStruckRange, CHORD_STRUCK_X_CORRECTION_PX) completely
        // untouched — this only changes where clicking Reset lands you.
        // First-pass guess; retune by feel same as the struck-X correction was.
        const CHORD_PAD_RESET_X = -0.3;
        const CHORD_PAD_RESET_Y = -0.55;
        const chordPad = buildDragPad('Chord name position (drag)', settings.chordOffsetX, settings.chordOffsetY, window.dnlSetChordOffset, 90, CHORD_PAD_RESET_X, CHORD_PAD_RESET_Y, CHORD_PAD_X_EXTENT, CHORD_PAD_Y_EXTENT_UP, CHORD_PAD_Y_EXTENT_DOWN);
        // Each pad's wrap gets flex:1 so the row splits into two even halves
        // of appearanceCol1's width — same convention as sizeSlidersRow above
        // — so the chord-notation controls appended below chordPad (dropdown
        // + its two checkboxes) land at that same half-width instead of the
        // pad's own narrower natural (90px + reset button) size.
        letterPad.wrap.style.flex = '1'; letterPad.wrap.style.minWidth = '0';
        chordPad.wrap.style.flex = '1'; chordPad.wrap.style.minWidth = '0';
        const padsRow = document.createElement('div');
        padsRow.style.cssText = 'display:flex;gap:10px;';
        padsRow.appendChild(letterPad.wrap);
        padsRow.appendChild(chordPad.wrap);
        appearanceCol1.appendChild(padsRow);

        // ── Chord Notation — folded into the chord-name-position half column
        // (was its own "Chord Notation" section under Highway Notations
        // until 2026-09-05; moved here so the mode dropdown sits right next
        // to the position control it actually governs).
        const chordSelect = document.createElement('select');
        chordSelect.style.cssText = 'width:100%;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:4px 6px;margin-bottom:10px;';
        [['all', 'Show all chord notes'], ['root', 'Show only root note'], ['name', 'Show chord name'], ['none', 'No letters on chords']]
            .forEach(([value, label]) => {
                const opt = document.createElement('option');
                opt.value = value; opt.textContent = label;
                if (value === settings.chordMode) opt.selected = true;
                chordSelect.appendChild(opt);
            });
        chordSelect.addEventListener('change', () => {
            // dnlSetChordMode itself now drives core's chord-name visibility
            // directly (hidden only while 'name' is selected, shown
            // otherwise) — see setCoreChordNameVisible. No separate
            // checkbox anymore; removed 2026-09-06 per Leah's ask to just
            // have the dropdown control it, and to stop persisting that
            // choice at all so an uninstalled plugin can never leave core's
            // chord names stuck hidden.
            window.dnlSetChordMode(chordSelect.value);
            chordPad.setEnabled(chordSelect.value === 'name');
            chordSizeSlider.setEnabled(chordSelect.value === 'name');
        });
        chordPad.wrap.appendChild(chordSelect);
        // Position/size only matter in 'name' mode (both govern the
        // chord-name draw) — greyed out/inert otherwise so they don't look
        // like live controls when they have no effect. Matches whatever
        // mode was already loaded/saved, not just the dropdown's own default.
        chordPad.setEnabled(settings.chordMode === 'name');
        chordSizeSlider.setEnabled(settings.chordMode === 'name');

        // Pre-strike fade-in, matching highway_3d's own chord-label fade
        // (see the fadeChordName comment in DEFAULT_SETTINGS). On by default;
        // unchecking draws the chord name at full opacity the whole time it's
        // on screen, same as before this feature existed.
        const cbFadeChordName = mkCheckRow('Fade chord name in on approach', settings.fadeChordName, window.dnlSetFadeChordName, chordPad.wrap);

        // chordStruckRange is locked at 4.9 (DEFAULT_SETTINGS) — the tuning
        // slider was pulled 2026-09-05 once Leah confirmed the value and
        // reverted to drag-pad-only control for both axes (see the
        // isStruck/range comment in renderNoteLetters). Not exposed in the
        // pane anymore; retune the DEFAULT_SETTINGS constant directly if
        // this ever needs to change again.


        // <div>, not <label> — a <label> wrapping both the text and the color
        // swatch makes the whole row's width open the color picker, same
        // issue as the checkbox rows above. The <input type=color> already
        // opens its own picker on click without a <label>, so nothing is lost.
        const colorRow = document.createElement('div');
        colorRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const colorSpan = document.createElement('span');
        colorSpan.style.color = '#d1d5db';
        colorSpan.textContent = 'Letter color';
        const colorInput = document.createElement('input');
        colorInput.type = 'color';
        colorInput.value = settings.color;
        colorInput.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:6px;height:28px;width:44px;padding:0;';
        // 'input', not 'change' — fires continuously while dragging in the
        // native picker, so the note letters update live instead of only
        // once the picker closes.
        colorInput.addEventListener('input', () => window.dnlSetColor(colorInput.value));
        colorRow.appendChild(colorSpan);
        colorRow.appendChild(colorInput);
        colorRow.style.marginBottom = '10px';
        // Appended to letterPad.wrap (not appearanceCol1 directly) — see the
        // "gap between letter pad and letter color" fix 2026-09-06: these
        // rows only apply to single-note letters (chord names always use
        // their own fixed gold styling, see overrideText in
        // renderNoteLetters), so they belong right under the letter pad
        // that governs the same letters, and doing so means they no longer
        // wait on chordPad's own now-taller column (dropdown + 2
        // checkboxes) before they can start — they flow straight under
        // whatever height the letter pad itself actually is.
        letterPad.wrap.appendChild(colorRow);

        // Theme-aware: each letter takes the color highway_3d is actually
        // drawing that string's gems in right now (window.__h3dActivePalette),
        // so it follows whatever built-in palette or custom per-string colors
        // the user has set there — no separate color picker to keep in sync.
        // Overrides the fixed "Letter color" above while on, so that picker
        // is dimmed (not removed — flipping this back off restores it as-is).
        const matchGemRow = document.createElement('div');
        matchGemRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:10px;';
        const matchGemCbWrap = mkCb(settings.matchGemColor, (v) => {
            window.dnlSetMatchGemColor(v);
            colorRow.style.opacity = v ? '0.4' : '1';
            colorInput.disabled = v;
        });
        const cbMatchGemColor = matchGemCbWrap.querySelector('input');
        matchGemRow.appendChild(matchGemCbWrap);
        matchGemRow.appendChild(document.createTextNode('Match fret color'));
        letterPad.wrap.appendChild(matchGemRow);
        colorRow.style.opacity = settings.matchGemColor ? '0.4' : '1';
        colorInput.disabled = settings.matchGemColor;

        const bgRow = document.createElement('div');
        bgRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:8px;';
        const bgCbWrap = mkCb(settings.bgEnabled, () => {});
        const bgCb = bgCbWrap.querySelector('input');
        bgRow.appendChild(bgCbWrap);
        bgRow.appendChild(document.createTextNode('Background color'));
        // Also into letterPad.wrap, not appearanceCol1 — same reasoning as
        // colorRow/matchGemRow above. Background actually applies to BOTH
        // letter and chord-name text, but appending it to appearanceCol1
        // directly means it can only start below the TALLER of the two pad
        // columns (chordPad, with its dropdown + 2 checkboxes) regardless of
        // how short letterPad's own column is — the real remaining source of
        // the "gap under Match fret color" Leah flagged 2026-09-06 after the
        // first pass only moved colorRow/matchGemRow. Keeping every
        // appearanceCol1-level control fully inside one pad column or the
        // other (never split across both) is what actually removes any
        // row-height dependency between them.
        letterPad.wrap.appendChild(bgRow);

        const bgColorRow = document.createElement('div');
        bgColorRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-left:18px;';
        const bgColorSpan = document.createElement('span');
        bgColorSpan.style.color = '#d1d5db';
        bgColorSpan.textContent = 'Background color';
        const bgColorInput = document.createElement('input');
        bgColorInput.type = 'color';
        bgColorInput.value = settings.bgColor;
        bgColorInput.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:6px;height:28px;width:44px;padding:0;';
        bgColorInput.addEventListener('input', () => window.dnlSetBgColor(bgColorInput.value));
        bgColorRow.appendChild(bgColorSpan);
        bgColorRow.appendChild(bgColorInput);
        letterPad.wrap.appendChild(bgColorRow);

        // Same slider style as Letter size/Chord size above (buildSizeSlider,
        // generalized 2026-09-06 to take a min/max/step/suffix override) —
        // was previously its own bespoke markup with a manually-indented
        // label/input pair.
        const bgOpSlider = buildSizeSlider('Background opacity — ', settings.bgOpacity, (v) => window.dnlSetBgOpacity(v), { min: 0, max: 100, step: 1, suffix: '%' });
        letterPad.wrap.appendChild(bgOpSlider.wrap);
        // Kept for the disable/reset wiring below, matching prior names.
        const bgOpInput = bgOpSlider.input;
        const bgOpValSpan = bgOpSlider.valSpan;

        // Own sub-heading for col2's appearance-adjacent content (key/scale
        // display+override, root highlight, scale overlay) — col1 and col2
        // no longer share one row, so each needs its own heading at
        // wherever its own content actually starts (see the comment on
        // appearanceCol1/appearanceCol2 above).
        const keyScaleLabel = document.createElement('div');
        keyScaleLabel.textContent = 'Key, Scale & Root Highlight';
        keyScaleLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin:14px 0 8px;border-top:1px solid #1f2937;padding-top:12px;';
        appearanceCol2.appendChild(keyScaleLabel);

        // Rings the letter of any note matching the song's current key/root.
        // Silently does nothing on songs without a keys track (most songs
        // today) — see window.highway.getKeyTonicAt in the core patch notes.
        const cbHighlightRootNotes = mkCheckRow('Highlight key/root notes', settings.highlightRootNotes, window.dnlSetHighlightRootNotes, appearanceCol2);

        // Most songs don't ship a keys.json track at all (see the core patch
        // notes) — this just tells the user whether the CURRENT song has one,
        // so "the highlight toggle isn't doing anything" isn't mistaken for a
        // bug when it's actually just this song having no key data.
        const keyStatusRow = document.createElement('div');
        keyStatusRow.style.cssText = 'color:#d1d5db;padding-left:15px;margin-top:2px;margin-bottom:4px;';
        appearanceCol2.appendChild(keyStatusRow);

        // Key picker: blank ("— auto (song data) —") + "None" + the 12
        // tonics — same 3-state shape as the scale picker below. Blank
        // defers to the song's own keys.json tonic if present; "None"
        // forces root-highlighting off even if the song has key data; a
        // real tonic forces that pitch class regardless of song data.
        // Always editable, on every song regardless of whether it has real
        // key data — picking a value here saves it as a permanent per-file
        // override (see window.dnlSetKeyOverride above), which then takes
        // priority over auto-detected data too, per Leah's call.
        //
        // Fixed 2026-09-06: blank used to be labeled "— none —" while its
        // actual behavior was "auto" (defer to song data) — there was no
        // way to genuinely force key highlighting off, so "none" was doing
        // double duty for both "auto" and "off" depending on whether the
        // song happened to have key data. Now a real distinct "None" state
        // exists, matching the scale picker's own already-correct 3-state
        // convention exactly.
        //
        // No standalone "Manually Set Key" label anymore — removed
        // 2026-09-06, dropdown now sits directly under the status row it
        // controls, same as the scale picker below.
        const keySelect = document.createElement('select');
        keySelect.style.cssText = 'width:calc(100% - 18px);background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:4px 6px;margin-left:15px;margin-bottom:8px;';
        const blankOpt = document.createElement('option');
        blankOpt.value = '';
        blankOpt.textContent = '— auto (song data) —';
        keySelect.appendChild(blankOpt);
        const keyNoneOpt = document.createElement('option');
        keyNoneOpt.value = 'none';
        keyNoneOpt.textContent = 'Off';
        keySelect.appendChild(keyNoneOpt);
        NOTE_NAMES_SHARP.forEach((name, pc) => {
            const opt = document.createElement('option');
            opt.value = String(pc);
            opt.textContent = name;
            keySelect.appendChild(opt);
        });
        keySelect.addEventListener('change', () => {
            const v = keySelect.value === '' ? null : keySelect.value;
            if (isVirtuosoActive()) window.dnlSetVirtuosoKeyOverride(v);
            else window.dnlSetKeyOverride(v);
        });
        appearanceCol2.appendChild(keySelect);

        // A keys.json event may optionally carry a `scale` string alongside
        // its `key` (spec §7.7) — nothing reads it for highlighting today,
        // this is just a text readout for now. Hidden entirely when there's
        // no scale data, same as the rest of this section staying quiet when
        // there's nothing to report.
        const scaleStatusRow = document.createElement('div');
        scaleStatusRow.style.cssText = 'color:#d1d5db;padding-left:15px;margin-bottom:4px;display:none;';
        appearanceCol2.appendChild(scaleStatusRow);

        // Scale picker for the full-fretboard scale overlay (3D only). Blank
        // ("— auto (song data) —") defers to the song's own keys.json scale
        // if present; "None" forces the overlay off even if the song has
        // scale data; any other option forces that scale regardless of song
        // data. Same per-file override storage pattern as the key picker.
        //
        // No standalone "Scale Overlay (3D only)" label anymore — removed
        // 2026-09-06, dropdown now sits directly under the status row it
        // controls, same as the key picker above.
        const scaleSelect = document.createElement('select');
        scaleSelect.style.cssText = 'width:calc(100% - 18px);background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:4px 6px;margin-left:15px;margin-bottom:8px;';
        const scaleBlankOpt = document.createElement('option');
        scaleBlankOpt.value = '';
        scaleBlankOpt.textContent = '— auto (song data) —';
        scaleSelect.appendChild(scaleBlankOpt);
        const scaleNoneOpt = document.createElement('option');
        scaleNoneOpt.value = 'none';
        scaleNoneOpt.textContent = 'None';
        scaleSelect.appendChild(scaleNoneOpt);
        const scaleAllNotesOpt = document.createElement('option');
        scaleAllNotesOpt.value = ALL_NOTES_ID;
        scaleAllNotesOpt.textContent = 'All Notes (no scale filter)';
        scaleSelect.appendChild(scaleAllNotesOpt);
        const scaleAllNotesInlayOpt = document.createElement('option');
        scaleAllNotesInlayOpt.value = ALL_NOTES_INLAY_ID;
        scaleAllNotesInlayOpt.textContent = 'All Notes (inlay frets only)';
        scaleSelect.appendChild(scaleAllNotesInlayOpt);
        const scaleRootOnlyOpt = document.createElement('option');
        scaleRootOnlyOpt.value = ROOT_ONLY_ID;
        scaleRootOnlyOpt.textContent = 'Root Note Only';
        scaleSelect.appendChild(scaleRootOnlyOpt);
        SCALE_LABELS.forEach(([id, label]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            scaleSelect.appendChild(opt);
        });
        scaleSelect.addEventListener('change', () => {
            const v = scaleSelect.value === '' ? null : scaleSelect.value;
            if (isVirtuosoActive()) window.dnlSetVirtuosoScaleOverride(v);
            else window.dnlSetScaleOverride(v);
        });
        appearanceCol2.appendChild(scaleSelect);

        // Real-scale display: dots (original behavior) vs the actual note
        // letters at each scale-tone position — Leah's ask 2026-09-06, same
        // "notes vs dots" split the All Notes overlay already has built in
        // (it always draws letters), just exposed as a choice here since a
        // real scale's shape-across-the-neck point works either way.
        const scaleModeLabel = document.createElement('div');
        scaleModeLabel.style.cssText = 'color:#d1d5db;margin-top:8px;margin-bottom:4px;padding-left:15px;';
        scaleModeLabel.textContent = 'Scale display:';
        appearanceCol2.appendChild(scaleModeLabel);

        const scaleModeSelect = document.createElement('select');
        scaleModeSelect.style.cssText = 'width:calc(100% - 18px);background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:4px 6px;margin-left:15px;';
        [['dots', 'Dots'], ['notes', 'Note letters']].forEach(([id, label]) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = label;
            scaleModeSelect.appendChild(opt);
        });
        scaleModeSelect.value = settings.scaleDisplayMode;
        scaleModeSelect.addEventListener('change', () => window.dnlSetScaleDisplayMode(scaleModeSelect.value));
        appearanceCol2.appendChild(scaleModeSelect);

        // Same on/off convention as matchGemRow above (see colorRow/
        // matchGemRow comment) but for the scale overlay's own color: off
        // uses the plain Letter color (settings.color, no separate picker
        // needed — Leah's explicit call), on uses each string's fret color.
        const scaleColorRow = document.createElement('div');
        scaleColorRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-top:8px;margin-bottom:8px;padding-left:15px;';
        const scaleColorCbWrap = mkCb(settings.scaleUseFretColor, (v) => window.dnlSetScaleUseFretColor(v));
        const cbScaleUseFretColor = scaleColorCbWrap.querySelector('input');
        scaleColorRow.appendChild(scaleColorCbWrap);
        scaleColorRow.appendChild(document.createTextNode('Use fret color for scale'));
        appearanceCol2.appendChild(scaleColorRow);

        // Scale overlay dot size + opacity — same slider convention as the
        // ring-thickness control below (label with live value, then a
        // <input type=range>).
        const dotSizeLabel = document.createElement('div');
        dotSizeLabel.style.cssText = 'color:#d1d5db;margin:8px 0 4px;padding-left:15px;';
        const dotSizeValSpan = document.createElement('span');
        dotSizeValSpan.textContent = settings.scaleDotSizeMul.toFixed(2);
        dotSizeLabel.textContent = 'Scale size — ';
        dotSizeLabel.appendChild(dotSizeValSpan);
        appearanceCol2.appendChild(dotSizeLabel);

        const dotSizeInput = document.createElement('input');
        dotSizeInput.type = 'range';
        dotSizeInput.min = '0.2'; dotSizeInput.max = '3'; dotSizeInput.step = '0.1';
        dotSizeInput.value = String(settings.scaleDotSizeMul);
        // Fills col2's width minus its own 15px left indent, minus 3px of
        // separation — same "fill the column" convention as col1's sliders.
        dotSizeInput.style.cssText = 'width:calc(100% - 18px);margin-left:15px;';
        dotSizeInput.addEventListener('input', () => {
            dotSizeValSpan.textContent = parseFloat(dotSizeInput.value).toFixed(2);
            window.dnlSetScaleDotSizeMul(dotSizeInput.value);
        });
        appearanceCol2.appendChild(dotSizeInput);

        const dotOpacityLabel = document.createElement('div');
        dotOpacityLabel.style.cssText = 'color:#d1d5db;margin:8px 0 4px;padding-left:15px;';
        const dotOpacityValSpan = document.createElement('span');
        dotOpacityValSpan.textContent = String(settings.scaleDotOpacity);
        dotOpacityLabel.textContent = 'Scale opacity — ';
        dotOpacityLabel.appendChild(dotOpacityValSpan);
        appearanceCol2.appendChild(dotOpacityLabel);

        const dotOpacityInput = document.createElement('input');
        dotOpacityInput.type = 'range';
        dotOpacityInput.min = '0'; dotOpacityInput.max = '100'; dotOpacityInput.step = '5';
        dotOpacityInput.value = String(settings.scaleDotOpacity);
        dotOpacityInput.style.cssText = 'width:calc(100% - 18px);margin-left:15px;';
        dotOpacityInput.addEventListener('input', () => {
            dotOpacityValSpan.textContent = dotOpacityInput.value;
            window.dnlSetScaleDotOpacity(dotOpacityInput.value);
        });
        appearanceCol2.appendChild(dotOpacityInput);

        // Virtuoso doesn't expose the Panes sidebar itself — this pane has
        // to be opened BEFORE switching into Virtuoso or there's no way to
        // reach it otherwise. Auto-open removes that gotcha; checkbox lets
        // anyone who finds the auto-pop-up intrusive turn it back off.
        const cbAutoOpenVirtuoso = mkCheckRow(
            'Auto-open this pane when Virtuoso is selected',
            settings.autoOpenPaneInVirtuoso,
            window.dnlSetAutoOpenPaneInVirtuoso,
            appearanceCol2,
        );

        // Ring color + thickness — only meaningful while the highlight
        // toggle is on, same enable/disable convention as the background
        // color/opacity sub-rows above.
        const ringColorRow = document.createElement('div');
        ringColorRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px;padding-left:15px;';
        const ringColorSpan = document.createElement('span');
        ringColorSpan.style.color = '#d1d5db';
        ringColorSpan.textContent = 'Root highlight ring color';
        const ringColorInput = document.createElement('input');
        ringColorInput.type = 'color';
        ringColorInput.value = settings.ringColor;
        ringColorInput.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:6px;height:28px;width:44px;padding:0;';
        ringColorInput.addEventListener('input', () => window.dnlSetRingColor(ringColorInput.value));
        ringColorRow.appendChild(ringColorSpan);
        ringColorRow.appendChild(ringColorInput);
        appearanceCol2.appendChild(ringColorRow);

        const ringThickLabel = document.createElement('div');
        ringThickLabel.style.cssText = 'color:#d1d5db;margin:8px 0 4px;padding-left:15px;';
        const ringThickValSpan = document.createElement('span');
        ringThickValSpan.textContent = settings.ringThickness.toFixed(2);
        ringThickLabel.textContent = 'Root highlight ring thickness — ';
        ringThickLabel.appendChild(ringThickValSpan);
        appearanceCol2.appendChild(ringThickLabel);

        const ringThickInput = document.createElement('input');
        ringThickInput.type = 'range';
        ringThickInput.min = '0.02'; ringThickInput.max = '0.3'; ringThickInput.step = '0.01';
        ringThickInput.value = String(settings.ringThickness);
        ringThickInput.style.cssText = 'width:calc(100% - 18px);margin-left:15px;';
        ringThickInput.addEventListener('input', () => {
            ringThickValSpan.textContent = parseFloat(ringThickInput.value).toFixed(2);
            window.dnlSetRingThickness(ringThickInput.value);
        });
        appearanceCol2.appendChild(ringThickInput);

        const updateKeyStatus = () => {
            const hw = window.highway;

            // Virtuoso: same escape-hatch pattern as the scale picker below
            // now (changed 2026-09-06 — was a full lockout before, per
            // Leah's call that a disabled picker was the wrong move here).
            // Blank = trust Virtuoso's own report; 'Off' forces root-
            // highlighting off; a real tonic forces that pitch class
            // regardless of what Virtuoso reports. See
            // window.dnlSetVirtuosoKeyOverride / effectiveKeyTonic's
            // Virtuoso branch.
            if (isVirtuosoActive()) {
                const info = getVirtuosoBundleInfo();
                const tonic = virtuosoKeyTonic(hw, info);
                keyStatusRow.textContent = tonic === null
                    ? 'Key (from Virtuoso): none set'
                    : 'Key (from Virtuoso): ' + NOTE_NAMES_SHARP[tonic];
                const kov = settings.virtuosoKeyOverride;
                blankOpt.textContent = '— auto (trust Virtuoso) —';
                // Blank ("auto") unless an actual manual override is set —
                // same reasoning as the scale picker: never snap to reflect
                // Virtuoso's own live-changing report.
                keySelect.value = kov === null || kov === undefined ? '' : String(kov);
                keySelect.disabled = false;
                keyStatusRow.style.opacity = '1';
                const scale = virtuosoScale(info);
                if (scale) {
                    scaleStatusRow.textContent = 'Scale (from Virtuoso): ' + prettyScaleName(scale);
                    scaleStatusRow.style.display = '';
                } else {
                    scaleStatusRow.style.display = 'none';
                }
                // Scale picker STAYS enabled while Virtuoso is active (unlike
                // the key picker above) — Virtuoso's own reported scale is
                // confirmed unreliable in places (stale Workout-mode data,
                // see [[virtuoso-requests-for-maintainer]]), so this is the
                // escape hatch: pick 'None' to force the overlay off, 'All
                // Notes' for a key-independent reference, or a specific scale
                // to override Virtuoso's report outright. Blank means "trust
                // Virtuoso's own report" (the old read-only behavior).
                const ov = settings.virtuosoScaleOverride;
                scaleBlankOpt.textContent = '— auto (trust Virtuoso) —';
                // Blank ("auto") unless an actual manual override is set —
                // same fix as the key dropdown above. Previously snapped to
                // show Virtuoso's own resolved scale as if it were a manual
                // pick.
                scaleSelect.value = ov || '';
                scaleSelect.disabled = false;
                scaleStatusRow.style.opacity = '1';
                return;
            }
            const filename = currentSongFilename();

            // No song loaded, OR the user has backed out to the
            // library/home screen without currentSong getting cleared (see
            // isPlayerScreenActive() above) — nothing to report or edit.
            // Without this, hw.getKeys() can still return stale data left
            // over from whatever song was playing last, showing a misleading
            // key (and letting the dropdown save an override) for a song
            // that isn't even open anymore.
            if (!filename || !isPlayerScreenActive()) {
                keyStatusRow.textContent = 'Key: none (no song loaded)';
                keySelect.value = '';
                keySelect.disabled = true;
                keyStatusRow.style.opacity = '0.5';
                scaleStatusRow.style.display = 'none';
                scaleSelect.value = '';
                scaleSelect.disabled = true;
                scaleStatusRow.style.opacity = '0.5';
                return;
            }
            keySelect.disabled = false;
            keyStatusRow.style.opacity = '1';
            blankOpt.textContent = '— auto (song data) —';
            scaleSelect.disabled = false;
            scaleStatusRow.style.opacity = '1';
            scaleBlankOpt.textContent = '— auto (song data) —';

            const keys = (hw && typeof hw.getKeys === 'function') ? hw.getKeys() : [];
            const hasKeys = Array.isArray(keys) && keys.length > 0;

            // Live playback position, not just the first event's time — a
            // song that modulates mid-way through should have this readout
            // track the change as it plays, matching what the ring highlight
            // is doing on the highway itself. Falls back to the first
            // event's time before playback has a position yet (song just
            // loaded, getTime() reads 0/unavailable).
            const t = hasKeys ? (hw.getTime ? hw.getTime() : keys[0].t) : 0;
            const auto = (hasKeys && hw.getKeyTonicAt) ? hw.getKeyTonicAt(t) : null;

            // Scale is separate data from the tonic override above — it's
            // whatever this song's keys.json actually says at the current
            // time, regardless of whether the user has a manual tonic
            // override set. Hidden entirely when absent.
            const activeEvent = hasKeys ? activeKeyEvent(hw, t) : null;
            const scaleStr = activeEvent && typeof activeEvent.scale === 'string' && activeEvent.scale
                ? activeEvent.scale : null;
            const hasScaleOverride = filename && Object.prototype.hasOwnProperty.call(scaleOverrides, filename);
            // "Manual" whenever an override is set (mirrors the key status
            // row above), else the scale's own name directly — no "Yes (...)"
            // wrapper, the name alone already says there's data. Changed
            // 2026-09-06 per explicit ask, same reasoning as the key row.
            if (hasScaleOverride) {
                scaleStatusRow.textContent = 'Does song have Scale Data: Manual';
                scaleStatusRow.style.display = '';
            } else if (scaleStr) {
                scaleStatusRow.textContent = 'Does song have Scale Data: ' + prettyScaleName(scaleStr);
                scaleStatusRow.style.display = '';
            } else {
                scaleStatusRow.style.display = 'none';
            }

            const hasOverride = filename && Object.prototype.hasOwnProperty.call(keyOverrides, filename);
            const overrideVal = hasOverride ? keyOverrides[filename] : undefined;
            const hasAutoTonic = auto !== null && auto !== undefined;

            // Status text: "Manual" whenever an override is set (a real
            // tonic OR the explicit 'none' — both are a deliberate user
            // choice, not the song's own data), else the actual detected
            // key letter when the song has resolvable data, else "No".
            // Previously always said "Yes"/"No" regardless of an override —
            // changed 2026-09-06 per explicit ask: show the real key, not
            // just whether one exists.
            keyStatusRow.textContent = 'Does song have key data: ' + (hasOverride ? 'Manual'
                : hasAutoTonic ? NOTE_NAMES_SHARP[auto]
                : (hasKeys ? 'Yes (unresolved)' : 'No'));

            // Dropdown only reflects an EXPLICIT override now — on auto, it
            // always shows blank ("— auto (song data) —") regardless of
            // what the song's own data resolves to, rather than snapping to
            // the detected note the instant one exists. Changed 2026-09-06:
            // previously auto-detected songs made the dropdown jump to show
            // that note, which read as "already manually set" when it
            // wasn't — only an actual pick should ever change what the
            // dropdown displays.
            keySelect.value = hasOverride ? (overrideVal === 'none' ? 'none' : String(overrideVal)) : '';

            // Effective tonic for the scale-picker's own "needs a tonic"
            // greying logic below — kept independent of keySelect.value
            // now that the dropdown no longer reflects the auto-detected
            // note, so a real auto tonic still counts as "resolved" even
            // though the dropdown itself just shows blank.
            const effectiveTonic = hasOverride ? (overrideVal === 'none' ? null : overrideVal) : auto;

            if (hasScaleOverride) {
                scaleSelect.value = scaleOverrides[filename];
            } else {
                scaleSelect.value = '';
            }

            // The scale overlay draws pitches RELATIVE TO the tonic — with no
            // key resolved (no song key data, no manual key override), a
            // real scale pick can't actually draw anything. Grey the control
            // out rather than let it silently do nothing, per Leah's call.
            // EXCEPT: 'none' (turns the overlay off, needs no tonic) and
            // ALL_NOTES_ID (key-independent by design) always stay pickable
            // regardless of tonic state. Never actually DISABLE the control
            // here (that would trap a no-tonic song on a real scale pick
            // with no way to switch back to 'none'/All Notes) — just dim the
            // label as a hint that the current pick won't draw anything
            // without a tonic. Uses effectiveTonic (computed above), NOT
            // keySelect.value — the dropdown no longer reflects an
            // auto-detected tonic, but that tonic is still real/resolved for
            // this purpose.
            const hasTonic = effectiveTonic !== null && effectiveTonic !== undefined;
            const currentPick = scaleSelect.value;
            const pickNeedsNoTonic = currentPick === '' || currentPick === 'none' || currentPick === ALL_NOTES_ID || currentPick === ALL_NOTES_INLAY_ID;
            scaleSelect.disabled = false;
            scaleStatusRow.style.opacity = (hasTonic || pickNeedsNoTonic) ? '1' : '0.5';
        };
        updateKeyStatus();
        if (window.feedBack && typeof window.feedBack.on === 'function') {
            window.feedBack.on('song:loaded', updateKeyStatus);
        }
        // No event fires for either "playback advanced past a key-change
        // event" or "a Virtuoso jam session (re)started with a new key", so
        // poll while this pane is open — cheap (a getter call + a small
        // binary search / string compare) and this same function already
        // runs every frame for the ring highlight elsewhere in this file, so
        // this is nowhere near the hot path. There's no teardown hook from the pane host to
        // hang a stop-polling call on (buildPanel() is a plain element
        // factory, not given a destroy callback), so the poll checks its own
        // continued presence each tick and stops itself once the panel's
        // been closed/detached, rather than leaking forever or stacking a
        // new interval on every reopen. Uses panel.isConnected rather than
        // document.body.contains(panel) — the pane host physically relocates
        // this node into its own separate OS window/document once opened
        // (see the resizeTo comment above), so checking against THIS
        // closure's document would falsely read "detached" the moment that
        // move happens, killing the poll immediately even while legitimately
        // open. isConnected reflects attachment to any document.
        const virtuosoKeyPollId = setInterval(() => {
            if (!panel.isConnected) { clearInterval(virtuosoKeyPollId); return; }
            updateKeyStatus();
        }, 1000);

        // Background color/opacity rows are only meaningful while the
        // background toggle itself is on — enable/disable them together
        // rather than leaving live controls for an inactive feature.
        const setBgSubRowsEnabled = (on) => {
            bgColorInput.disabled = !on;
            bgOpInput.disabled = !on;
            bgColorRow.style.opacity = bgOpSlider.wrap.style.opacity = on ? '1' : '0.4';
        };
        setBgSubRowsEnabled(settings.bgEnabled);
        bgCb.addEventListener('change', () => {
            window.dnlSetBgEnabled(bgCb.checked);
            setBgSubRowsEnabled(bgCb.checked);
        });

        // Function declaration (not a const arrow function) so it's hoisted —
        // resetAllBtn's click handler above references it before this line
        // runs, which is fine because hoisting makes the name available
        // throughout buildPanel's scope regardless of source order.
        function resetAllToDefaults() {
            window.dnlSetShowOpen(DEFAULT_SETTINGS.showOpen);
            cbShowOpen.checked = DEFAULT_SETTINGS.showOpen;
            window.dnlSetShowFretted(DEFAULT_SETTINGS.showFretted);
            cbShowFretted.checked = DEFAULT_SETTINGS.showFretted;
            window.dnlSetHideFretMarkers(DEFAULT_SETTINGS.hideFretMarkers);
            cbHideFretMarkers.checked = DEFAULT_SETTINGS.hideFretMarkers;
            window.dnlSetHideOpenMarkers(DEFAULT_SETTINGS.hideOpenMarkers);
            cbHideOpenMarkers.checked = DEFAULT_SETTINGS.hideOpenMarkers;
            window.dnlSetHideChordGems(DEFAULT_SETTINGS.hideChordGems);
            cbHideChordGems.checked = DEFAULT_SETTINGS.hideChordGems;
            window.dnlSetHideChordOpenGems(DEFAULT_SETTINGS.hideChordOpenGems);
            cbHideChordOpenGems.checked = DEFAULT_SETTINGS.hideChordOpenGems;
            window.dnlSetHidePalmMuteMarkers(DEFAULT_SETTINGS.hidePalmMuteMarkers);
            cbHidePalmMute.checked = DEFAULT_SETTINGS.hidePalmMuteMarkers;
            window.dnlSetHideFretHandMuteMarkers(DEFAULT_SETTINGS.hideFretHandMuteMarkers);
            cbHideFretHandMute.checked = DEFAULT_SETTINGS.hideFretHandMuteMarkers;
            window.dnlSetHideFretWires(DEFAULT_SETTINGS.hideFretWires);
            cbHideFretWires.checked = DEFAULT_SETTINGS.hideFretWires;
            window.dnlSetHideStringLines(DEFAULT_SETTINGS.hideStringLines);
            cbHideStringLines.checked = DEFAULT_SETTINGS.hideStringLines;
            window.dnlSetHideFingeringNumbers(DEFAULT_SETTINGS.hideFingeringNumbers);
            cbHideFingeringNumbers.checked = DEFAULT_SETTINGS.hideFingeringNumbers;
            window.dnlSetAutoOpenPaneInVirtuoso(DEFAULT_SETTINGS.autoOpenPaneInVirtuoso);
            cbAutoOpenVirtuoso.checked = DEFAULT_SETTINGS.autoOpenPaneInVirtuoso;
            // Not gated behind isVirtuosoActive() the way dnlSetVirtuosoScaleOverride
            // normally is — Reset to Defaults should clear it regardless of
            // which screen is active when the button is pressed, so write
            // directly instead of going through the setter.
            settings.virtuosoScaleOverride = DEFAULT_SETTINGS.virtuosoScaleOverride;
            try { localStorage.removeItem(LS_PREFIX + 'virtuosoScaleOverride'); } catch (_) {}
            settings.virtuosoKeyOverride = DEFAULT_SETTINGS.virtuosoKeyOverride;
            try { localStorage.removeItem(LS_PREFIX + 'virtuosoKeyOverride'); } catch (_) {}
            // scaleDotSizeMul/scaleDotOpacity were added after this function
            // was first written and never got wired in — found while
            // reviewing settings defaults 2026-09-05.
            window.dnlSetScaleDotSizeMul(DEFAULT_SETTINGS.scaleDotSizeMul);
            dotSizeInput.value = String(DEFAULT_SETTINGS.scaleDotSizeMul);
            dotSizeValSpan.textContent = DEFAULT_SETTINGS.scaleDotSizeMul.toFixed(2);
            window.dnlSetScaleDotOpacity(DEFAULT_SETTINGS.scaleDotOpacity);
            dotOpacityInput.value = String(DEFAULT_SETTINGS.scaleDotOpacity);
            dotOpacityValSpan.textContent = String(DEFAULT_SETTINGS.scaleDotOpacity);
            window.dnlSetScaleDisplayMode(DEFAULT_SETTINGS.scaleDisplayMode);
            scaleModeSelect.value = DEFAULT_SETTINGS.scaleDisplayMode;
            window.dnlSetScaleUseFretColor(DEFAULT_SETTINGS.scaleUseFretColor);
            cbScaleUseFretColor.checked = DEFAULT_SETTINGS.scaleUseFretColor;
            window.dnlSetScaleOpenStringOffsetK(DEFAULT_SETTINGS.scaleOpenStringOffsetK);

            // These four are highway_3d's own core settings (not this
            // plugin's), so they're not in DEFAULT_SETTINGS — but the game's
            // own out-of-the-box default is all four ON, so reset forces them
            // back to that rather than leaving whatever was last toggled.
            window.h3dBgSetFlyingFretLabelVisible?.(true);
            window.highway?.setFretNumberVisible?.(true);
            cbFlyingFret.checked = true;
            window.h3dBgSetFretColumnMarkerCadence?.(1);
            cbFretColCadence.checked = true;
            window.h3dBgSetChordBaseFretLabelsVisible?.(true);
            cbChordBaseFret.checked = true;
            window.h3dBgSetDynamicFretRowVisible?.(true);
            window.highway?.setFretLinePreviewVisible?.(true);
            window.highway?.setFretRulerVisible?.(true);
            cbDynamicRow.checked = true;

            window.dnlSetChordMode(DEFAULT_SETTINGS.chordMode);
            chordSelect.value = DEFAULT_SETTINGS.chordMode;
            chordPad.setEnabled(DEFAULT_SETTINGS.chordMode === 'name');
            chordSizeSlider.setEnabled(DEFAULT_SETTINGS.chordMode === 'name');
            window.dnlSetFadeChordName(DEFAULT_SETTINGS.fadeChordName);
            cbFadeChordName.checked = DEFAULT_SETTINGS.fadeChordName;

            window.dnlSetHighlightRootNotes(DEFAULT_SETTINGS.highlightRootNotes);
            cbHighlightRootNotes.checked = DEFAULT_SETTINGS.highlightRootNotes;
            window.dnlSetRingColor(DEFAULT_SETTINGS.ringColor);
            ringColorInput.value = DEFAULT_SETTINGS.ringColor;
            window.dnlSetRingThickness(DEFAULT_SETTINGS.ringThickness);
            ringThickInput.value = String(DEFAULT_SETTINGS.ringThickness);
            ringThickValSpan.textContent = DEFAULT_SETTINGS.ringThickness.toFixed(2);

            window.dnlSetSizeK(DEFAULT_SETTINGS.sizeK);
            sizeInput.value = String(DEFAULT_SETTINGS.sizeK);
            sizeValSpan.textContent = String(DEFAULT_SETTINGS.sizeK);

            window.dnlSetChordSizeK(DEFAULT_SETTINGS.chordSizeK);
            chordSizeSlider.input.value = String(DEFAULT_SETTINGS.chordSizeK);
            chordSizeSlider.valSpan.textContent = String(DEFAULT_SETTINGS.chordSizeK);

            window.dnlSetOffset(DEFAULT_SETTINGS.offsetX, DEFAULT_SETTINGS.offsetY);
            letterPad.setDotFromOffset(DEFAULT_SETTINGS.offsetX, DEFAULT_SETTINGS.offsetY);
            // Matches the chord pad's own Reset button target (CHORD_PAD_RESET_X/Y
            // above), not DEFAULT_SETTINGS.chordOffsetX/Y (0,0) — see that
            // constant's comment for why (0,0) reads as bottom-right of the box.
            window.dnlSetChordOffset(CHORD_PAD_RESET_X, CHORD_PAD_RESET_Y);
            chordPad.setDotFromOffset(CHORD_PAD_RESET_X, CHORD_PAD_RESET_Y);
            window.dnlSetChordStruckRange(DEFAULT_SETTINGS.chordStruckRange);

            window.dnlSetColor(DEFAULT_SETTINGS.color);
            colorInput.value = DEFAULT_SETTINGS.color;

            window.dnlSetMatchGemColor(DEFAULT_SETTINGS.matchGemColor);
            cbMatchGemColor.checked = DEFAULT_SETTINGS.matchGemColor;
            colorRow.style.opacity = DEFAULT_SETTINGS.matchGemColor ? '0.4' : '1';
            colorInput.disabled = DEFAULT_SETTINGS.matchGemColor;

            window.dnlSetBgEnabled(DEFAULT_SETTINGS.bgEnabled);
            bgCb.checked = DEFAULT_SETTINGS.bgEnabled;
            window.dnlSetBgColor(DEFAULT_SETTINGS.bgColor);
            bgColorInput.value = DEFAULT_SETTINGS.bgColor;
            window.dnlSetBgOpacity(DEFAULT_SETTINGS.bgOpacity);
            bgOpInput.value = String(DEFAULT_SETTINGS.bgOpacity);
            bgOpValSpan.textContent = DEFAULT_SETTINGS.bgOpacity + '%';
            setBgSubRowsEnabled(DEFAULT_SETTINGS.bgEnabled);
        }

        return panel;
    }

    function registerPane() {
        const panes = window.feedBack && window.feedBack.panes;
        if (!panes || typeof panes.register !== 'function') return;
        try {
            panes.register({
                id: 'highway_notation',
                title: 'Highway Notation Settings',
                icon: '🎵',
                element: buildPanel,
                // Starting guess for the window's initial open (avoids a visible
                // flash-then-resize on first paint) — real sizing happens in
                // onHost below, so this number doesn't need hand-tuning again
                // when more settings get added later.
                width: 500,
                height: 640,
                // Panes hands us the ACTUAL moved element once it lands in its
                // own OS window (see pane-manager.js's docstring — the node
                // itself relocates, not a copy), so this can measure the
                // panel's real content height and resize the window to fit
                // exactly, with no scrollbar, however tall buildPanel() ends up
                // being. hostId !== 'window' (e.g. docked) has no separate
                // window to resize, so this is a no-op there.
                //
                // Desktop app only: skip this entirely. Confirmed live
                // (2026-09-02, CDP) that on the desktop build this resizeTo
                // call was hitting the MAIN app window's height, not the pane
                // popup's — Electron already gives the pane window its own
                // remembered bounds (pane-window-host.js / pane-desktop.js),
                // and this manual resize was fighting that. Only auto-resize
                // in a plain-browser popup, where the window really is the
                // one we just measured.
                onHost: (hostId, el) => {
                    if (hostId !== 'window') return;
                    const paneWin = el.ownerDocument && el.ownerDocument.defaultView;
                    // Chromium's BarProp — window.menubar (also toolbar/location/
                    // personalbar/statusbar) — is a real DOM feature, not an
                    // Electron-only API, so this is plain plugin-side JS with no
                    // main-process/core involvement. Setting .visible = false hides
                    // the native File/Edit/View/Window/Help bar on this pane's own
                    // popped-out window. Try unconditionally (desktop and plain
                    // browser both) — a browser that ignores the write is a no-op,
                    // not an error.
                    try { if (paneWin && paneWin.menubar) paneWin.menubar.visible = false; } catch (e) { /* non-fatal */ }
                    if (window.feedBackDesktop && window.feedBackDesktop.panes) return;
                    if (!paneWin) return;
                    // Let layout settle (the element just landed) before measuring.
                    requestAnimationFrame(() => {
                        try {
                            const chrome = Math.max(0, paneWin.outerHeight - paneWin.innerHeight);
                            const desired = el.scrollHeight + chrome + 4; // small buffer against rounding
                            paneWin.resizeTo(paneWin.outerWidth, desired);
                        } catch (e) { /* non-fatal — some browsers block resizeTo outside a user gesture */ }
                    });
                },
            });
        } catch (e) { console.warn('[highway_notation] panes.register failed', e); }
    }
    registerPane();
})();
