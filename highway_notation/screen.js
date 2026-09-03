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
    // chordMode: 'all' (every note in a chord gets a letter), 'root' (only the
    // chord's lowest-pitched note), 'none' (skip chord notes — standalone notes
    // still show per showOpen/showFretted). Standalone (non-chord) notes are
    // never affected by chordMode.
    const DEFAULT_SETTINGS = {
        showOpen: true, showFretted: true, chordMode: 'all', sizeK: 5.0, color: '#ffffff',
        bgEnabled: false, bgColor: '#000000', bgOpacity: 70,
        matchGemColor: false, hideFretMarkers: false, hideOpenMarkers: false,
        hidePalmMuteMarkers: false, hideFretHandMuteMarkers: false,
        hideChordNames: false,
        // Letter position relative to the gem's own center, each -1..1 (drag-pad
        // control in the panel). Multiplied by the gem's own fontPx at render
        // time (see OFFSET_RANGE in renderNoteLetters) so the offset distance
        // scales with perspective the same way the letter size already does.
        offsetX: 0, offsetY: 0,
    };
    let settings = Object.assign({}, DEFAULT_SETTINGS);

    function loadSettings() {
        try {
            const so = localStorage.getItem(LS_PREFIX + 'showOpen');
            const sf = localStorage.getItem(LS_PREFIX + 'showFretted');
            const cm = localStorage.getItem(LS_PREFIX + 'chordMode');
            const s = localStorage.getItem(LS_PREFIX + 'sizeK');
            const c = localStorage.getItem(LS_PREFIX + 'color');
            const be = localStorage.getItem(LS_PREFIX + 'bgEnabled');
            const bc = localStorage.getItem(LS_PREFIX + 'bgColor');
            const bo = localStorage.getItem(LS_PREFIX + 'bgOpacity');
            const mgc = localStorage.getItem(LS_PREFIX + 'matchGemColor');
            const hfm = localStorage.getItem(LS_PREFIX + 'hideFretMarkers');
            const hom = localStorage.getItem(LS_PREFIX + 'hideOpenMarkers');
            const hpm = localStorage.getItem(LS_PREFIX + 'hidePalmMuteMarkers');
            const hfhm = localStorage.getItem(LS_PREFIX + 'hideFretHandMuteMarkers');
            const hcn = localStorage.getItem(LS_PREFIX + 'hideChordNames');
            const ox = localStorage.getItem(LS_PREFIX + 'offsetX');
            const oy = localStorage.getItem(LS_PREFIX + 'offsetY');
            settings = {
                showOpen: so === null ? DEFAULT_SETTINGS.showOpen : so === '1',
                showFretted: sf === null ? DEFAULT_SETTINGS.showFretted : sf === '1',
                chordMode: (cm === 'all' || cm === 'root' || cm === 'none' || cm === 'name') ? cm : DEFAULT_SETTINGS.chordMode,
                sizeK: s === null ? DEFAULT_SETTINGS.sizeK : (Number.isFinite(parseFloat(s)) ? parseFloat(s) : DEFAULT_SETTINGS.sizeK),
                color: c || DEFAULT_SETTINGS.color,
                bgEnabled: be === null ? DEFAULT_SETTINGS.bgEnabled : be === '1',
                bgColor: bc || DEFAULT_SETTINGS.bgColor,
                bgOpacity: bo === null ? DEFAULT_SETTINGS.bgOpacity : (Number.isFinite(parseFloat(bo)) ? Math.max(0, Math.min(100, parseFloat(bo))) : DEFAULT_SETTINGS.bgOpacity),
                matchGemColor: mgc === null ? DEFAULT_SETTINGS.matchGemColor : mgc === '1',
                hideFretMarkers: hfm === null ? DEFAULT_SETTINGS.hideFretMarkers : hfm === '1',
                hideOpenMarkers: hom === null ? DEFAULT_SETTINGS.hideOpenMarkers : hom === '1',
                hidePalmMuteMarkers: hpm === null ? DEFAULT_SETTINGS.hidePalmMuteMarkers : hpm === '1',
                hideFretHandMuteMarkers: hfhm === null ? DEFAULT_SETTINGS.hideFretHandMuteMarkers : hfhm === '1',
                hideChordNames: hcn === null ? DEFAULT_SETTINGS.hideChordNames : hcn === '1',
                offsetX: ox === null ? DEFAULT_SETTINGS.offsetX : (Number.isFinite(parseFloat(ox)) ? Math.max(-1, Math.min(1, parseFloat(ox))) : DEFAULT_SETTINGS.offsetX),
                offsetY: oy === null ? DEFAULT_SETTINGS.offsetY : (Number.isFinite(parseFloat(oy)) ? Math.max(-1, Math.min(1, parseFloat(oy))) : DEFAULT_SETTINGS.offsetY),
            };
        } catch (_) { settings = Object.assign({}, DEFAULT_SETTINGS); }
    }
    loadSettings();
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
    if (window.h3dBgSetPalmMuteMarkerVisible) window.h3dBgSetPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
    if (window.h3dBgSetFretHandMuteMarkerVisible) window.h3dBgSetFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
    if (window.highway && window.highway.setGemVisible) window.highway.setGemVisible(!settings.hideFretMarkers);
    if (window.highway && window.highway.setOpenBarVisible) window.highway.setOpenBarVisible(!settings.hideOpenMarkers);
    if (window.highway && window.highway.setPalmMuteMarkerVisible) window.highway.setPalmMuteMarkerVisible(!settings.hidePalmMuteMarkers);
    if (window.highway && window.highway.setFretHandMuteMarkerVisible) window.highway.setFretHandMuteMarkerVisible(!settings.hideFretHandMuteMarkers);
    if (window.h3dBgSetChordNameVisible) window.h3dBgSetChordNameVisible(!settings.hideChordNames);
    if (window.highway && window.highway.setChordNameVisible) window.highway.setChordNameVisible(!settings.hideChordNames);

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
    window.dnlSetChordMode = (v) => {
        if (v !== 'all' && v !== 'root' && v !== 'none' && v !== 'name') return;
        settings.chordMode = v;
        try { localStorage.setItem(LS_PREFIX + 'chordMode', v); } catch (_) {}
    };
    window.dnlSetSizeK = (v) => {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n <= 0) return;
        settings.sizeK = n;
        try { localStorage.setItem(LS_PREFIX + 'sizeK', String(n)); } catch (_) {}
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
    window.dnlSetHideChordNames = (v) => {
        settings.hideChordNames = !!v;
        try { localStorage.setItem(LS_PREFIX + 'hideChordNames', settings.hideChordNames ? '1' : '0'); } catch (_) {}
        if (window.h3dBgSetChordNameVisible) window.h3dBgSetChordNameVisible(!settings.hideChordNames);
        if (window.highway && window.highway.setChordNameVisible) window.highway.setChordNameVisible(!settings.hideChordNames);
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
    function renderNoteLetters(ctx, entries, tuning, capo, arrangement, hw) {
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
        let chordRootOf = null;
        let chordDisplayNameByTime = null;
        if (settings.chordMode === 'root' || settings.chordMode === 'name') {
            // Chart chord instances -> their template's root letter + display
            // name, keyed the same way as timeGroups so both line up by onset.
            const chordNameRootByTime = new Map();
            chordDisplayNameByTime = new Map();
            const chordInstances = hw && hw.getChords ? hw.getChords() : null;
            const chordTemplates = hw && hw.getChordTemplates ? hw.getChordTemplates() : null;
            if (Array.isArray(chordInstances) && Array.isArray(chordTemplates)) {
                for (const c of chordInstances) {
                    const tmpl = chordTemplates[c.id];
                    if (!tmpl) continue;
                    const key = Math.round(c.t * 1000);
                    const root = rootLetterFromChordName(tmpl.name);
                    if (root) chordNameRootByTime.set(key, root);
                    const display = tmpl.displayName || tmpl.name;
                    if (display) chordDisplayNameByTime.set(key, display);
                }
            }

            chordRootOf = new Map();
            for (const [key, arr] of timeGroups) {
                if (arr.length < 2) continue;
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

        for (const g of entries) {
            const isOpen = g.f === 0;
            if (isOpen ? !settings.showOpen : !settings.showFretted) continue;
            const key = Math.round(g.t * 1000);
            const isChordGem = (timeGroups.get(key) || []).length > 1;
            let overrideText = null; // set for chordMode 'name' — draws the chord name, not a note letter
            if (isChordGem) {
                if (settings.chordMode === 'none') continue;
                if (settings.chordMode === 'root' || settings.chordMode === 'name') {
                    const root = chordRootOf.get(key);
                    if (!root || root.gem !== g) continue;
                    if (settings.chordMode === 'name') {
                        // Falls back to the plain root letter (computed below,
                        // same as chordMode 'root') when this onset has no
                        // chart chord name — e.g. a coincidental simultaneous
                        // grouping rather than a real chart-authored chord.
                        overrideText = chordDisplayNameByTime.get(key) || null;
                    }
                }
            }
            const letter = overrideText || noteLetter(tuning, capo, arrangement, g.s, g.f);
            if (!letter || !Number.isFinite(g.fontPx)) continue;
            const fontPx = g.fontPx;
            // Drag-pad offset (settings.offsetX/Y, each -1..1) scaled by this
            // gem's own fontPx so the letter moves a consistent distance
            // relative to its own size regardless of perspective/zoom —
            // OFFSET_RANGE tunes the pad's full-drag distance to roughly one
            // letter-height-and-a-half, enough to clear the gem/fret number
            // underneath at max drag without needing a separate distance control.
            const OFFSET_RANGE = 1.5;
            const px = g.px + settings.offsetX * fontPx * OFFSET_RANGE;
            const py = g.py + settings.offsetY * fontPx * OFFSET_RANGE;
            ctx.font = Math.round(fontPx) + 'px sans-serif';
            ctx.lineWidth = Math.max(1, fontPx * 0.12);
            const letterColor = settings.matchGemColor ? gemColorForString(g.s) : settings.color;
            ctx.fillStyle = letterColor;
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
                ctx.fillStyle = hexToRgba(settings.bgColor, settings.bgOpacity);
                ctx.fillRect(px - boxW / 2, py - ascent, boxW, boxH);
                ctx.fillStyle = letterColor;
            }
            ctx.strokeText(letter, px, py);
            ctx.fillText(letter, px, py);
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

    function findMounts() {
        wrap = document.querySelector('.h3d-wrap');
        return !!wrap;
    }

    function ensureOverlay() {
        if (overlay && overlay.isConnected) return true;
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
        const r = wrap.getBoundingClientRect();
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

    function draw() {
        rafId = requestAnimationFrame(draw);

        // One-time 2D draw-hook registration, done here purely because this
        // RAF loop always runs regardless of which renderer is mounted, so
        // it's a convenient place to notice window.highway becoming ready —
        // NOT because draw2D is otherwise related to this 3D path.
        if (!hw2dHookRegistered && window.highway && typeof window.highway.addDrawHook === 'function') {
            window.highway.addDrawHook(draw2D);
            hw2dHookRegistered = true;
        }

        const gems = window.__h3dGemPositions;
        if (!Array.isArray(gems) || !gems.length) {
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

        // Letter height in highway K-units (the same world-space scale unit
        // highway_3d sizes gems/labels against), user-adjustable via the
        // settings panel. highway_3d's own fret-number labels use a sprite
        // scale of ~7.0*K, so that's the default here too (1*K alone projects
        // to only a few px — confirmed live, invisible). Derived per-gem below
        // from sxK, the bridge's second projected point one K-unit away, so
        // text tracks the gem's real perspective scale at that distance
        // rather than a fixed pixel size.
        const LETTER_SIZE_K = settings.sizeK;

        const entries = [];
        for (const g of gems) {
            if (!Number.isFinite(g.sxK)) continue;
            // NDC (-1..1, +y up) -> canvas pixels (+y down).
            const px = ((g.sx + 1) / 2) * overlay.width;
            const py = ((1 - g.sy) / 2) * overlay.height;
            const pxPerK = Math.abs(g.sxK - g.sx) / 2 * overlay.width;
            const fontPx = Math.max(1, pxPerK * LETTER_SIZE_K);
            entries.push({ s: g.s, f: g.f, t: g.t, px, py, fontPx });
        }
        renderNoteLetters(ctx, entries, tuning, capo, arrangement, hw);
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
            const fontPx = Math.max(1, fretPx * 0.5 * (settings.sizeK / 5.0));
            entries.push({ s: n.s, f: n.f, t: n.t, px, py, fontPx });
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
            const fontPx = Math.max(1, fretPx * 0.5 * (settings.sizeK / 5.0));
            for (let j = 0; j < sorted.length; j++) {
                const cn = sorted[j];
                const templateFret = getTemplateFret(cn);
                const py = p.y * H - actualTotalH / 2 + j * actualSpread;
                const px = (templateFret === 0 && hasMultipleNotes)
                    ? (hw.fretX(baseFret, scale, W) + hw.fretX(baseFret + CHORD_FRAME_FRETS, scale, W)) / 2
                    : hw.fretX(cn.f, scale, W);
                entries.push({ s: cn.s, f: cn.f, t: ch.t, px, py, fontPx });
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
        resetRow.style.cssText = 'display:flex;justify-content:flex-end;margin-bottom:10px;';
        const resetAllBtn = document.createElement('button');
        resetAllBtn.type = 'button';
        resetAllBtn.textContent = 'Reset to Defaults';
        resetAllBtn.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:999px;color:#d1d5db;padding:6px 14px;cursor:pointer;font:12px sans-serif;';
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

        // ── Chord Notation — lives in col1, just below Highway Notations ──
        const chordLabel = document.createElement('div');
        chordLabel.textContent = 'Chord Notation';
        chordLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin:14px 0 8px;border-top:1px solid #1f2937;padding-top:12px;';
        col1.appendChild(chordLabel);

        const chordSelect = document.createElement('select');
        chordSelect.style.cssText = 'width:100%;background:#1f2937;border:1px solid #374151;border-radius:6px;color:#d1d5db;padding:4px 6px;margin-bottom:10px;';
        [['all', 'Show all chord notes'], ['root', 'Show only root note'], ['name', 'Show chord name'], ['none', 'No letters on chords']]
            .forEach(([value, label]) => {
                const opt = document.createElement('option');
                opt.value = value; opt.textContent = label;
                if (value === settings.chordMode) opt.selected = true;
                chordSelect.appendChild(opt);
            });
        chordSelect.addEventListener('change', () => window.dnlSetChordMode(chordSelect.value));
        col1.appendChild(chordSelect);

        // Core's own chord-name label (e.g. "F#5", drawn above/beside the
        // chord shape on both renderers) was previously unconditional on
        // both — this checkbox is for hiding it, e.g. to avoid a duplicate
        // next to chordMode 'name' showing the same name as a letter.
        // Default off (core's label stays visible) so existing behavior is
        // unchanged until a user opts in.
        const cbHideChordNames = mkCheckRow('Hide Default Note Highway Chord Names', settings.hideChordNames, window.dnlSetHideChordNames, col1);

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
        const cbHideFretMarkers = mkCheckRow('Hide fret markers', settings.hideFretMarkers, window.dnlSetHideFretMarkers, col2);
        const cbHideOpenMarkers = mkCheckRow('Hide open-note markers', settings.hideOpenMarkers, window.dnlSetHideOpenMarkers, col2);

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

        const appearanceLabel = document.createElement('div');
        appearanceLabel.textContent = 'Appearance';
        appearanceLabel.style.cssText = 'font-size:13px;font-weight:600;color:#9ca3af;margin:14px 0 8px;border-top:1px solid #1f2937;padding-top:12px;';
        panel.appendChild(appearanceLabel);

        const sizeLabel = document.createElement('div');
        sizeLabel.style.cssText = 'color:#6b7280;margin-bottom:4px;';
        const sizeValSpan = document.createElement('span');
        sizeValSpan.textContent = String(settings.sizeK);
        sizeLabel.textContent = 'Letter size — ';
        sizeLabel.appendChild(sizeValSpan);
        panel.appendChild(sizeLabel);

        const sizeInput = document.createElement('input');
        sizeInput.type = 'range';
        sizeInput.min = '2'; sizeInput.max = '16'; sizeInput.step = '0.5';
        sizeInput.value = String(settings.sizeK);
        // calc(50% - Npx), not a fixed px width: the panel actually stretches
        // to fill whatever width the host pane window is (confirmed live —
        // col1/col2 are real flex:1 columns that grow with it), so a fixed
        // px value drifted way short of the midline on a wider window. This
        // tracks col1's real width and leaves a little padding before the
        // panel's true center line.
        sizeInput.style.cssText = 'width:calc(50% - 12px);margin-bottom:10px;';
        sizeInput.addEventListener('input', () => {
            sizeValSpan.textContent = sizeInput.value;
            window.dnlSetSizeK(parseFloat(sizeInput.value));
        });
        panel.appendChild(sizeInput);

        // Drag-pad: click/drag a dot anywhere inside a small square to push the
        // letter off the gem's own center in whatever direction/distance the
        // player wants — built instead of a single-axis slider because the
        // fret-number-overlap problem this solves isn't always "move it up,"
        // it depends on gem shape, chord stacking, etc. Dot position (-1..1 on
        // each axis, center = 0,0/no offset) maps directly to settings.offsetX/Y
        // via window.dnlSetOffset — see renderNoteLetters' OFFSET_RANGE for how
        // that maps to actual on-screen pixels.
        const offsetLabel = document.createElement('div');
        offsetLabel.style.cssText = 'color:#6b7280;margin-bottom:4px;';
        offsetLabel.textContent = 'Letter position (drag)';
        panel.appendChild(offsetLabel);

        const padSize = 90;
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

        const setDotFromOffset = (x, y) => {
            dot.style.left = ((x + 1) / 2 * padSize) + 'px';
            dot.style.top = ((y + 1) / 2 * padSize) + 'px';
        };
        setDotFromOffset(settings.offsetX, settings.offsetY);

        const applyFromEvent = (e) => {
            const r = pad.getBoundingClientRect();
            const x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
            const y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
            setDotFromOffset(x, y);
            window.dnlSetOffset(x, y);
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
            setDotFromOffset(0, 0);
            window.dnlSetOffset(0, 0);
        });

        padRow.appendChild(pad);
        padRow.appendChild(resetBtn);
        panel.appendChild(padRow);

        // <div>, not <label> — a <label> wrapping both the text and the color
        // swatch makes the whole row's width open the color picker, same
        // issue as the checkbox rows above. The <input type=color> already
        // opens its own picker on click without a <label>, so nothing is lost.
        const colorRow = document.createElement('div');
        colorRow.style.cssText = 'display:flex;align-items:center;gap:8px;';
        const colorSpan = document.createElement('span');
        colorSpan.style.color = '#6b7280';
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
        panel.appendChild(colorRow);

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
        panel.appendChild(matchGemRow);
        colorRow.style.opacity = settings.matchGemColor ? '0.4' : '1';
        colorInput.disabled = settings.matchGemColor;

        const bgRow = document.createElement('div');
        bgRow.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:8px;';
        const bgCbWrap = mkCb(settings.bgEnabled, () => {});
        const bgCb = bgCbWrap.querySelector('input');
        bgRow.appendChild(bgCbWrap);
        bgRow.appendChild(document.createTextNode('Background color'));
        panel.appendChild(bgRow);

        const bgColorRow = document.createElement('div');
        bgColorRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;padding-left:18px;';
        const bgColorSpan = document.createElement('span');
        bgColorSpan.style.color = '#6b7280';
        bgColorSpan.textContent = 'Background color';
        const bgColorInput = document.createElement('input');
        bgColorInput.type = 'color';
        bgColorInput.value = settings.bgColor;
        bgColorInput.style.cssText = 'background:#1f2937;border:1px solid #374151;border-radius:6px;height:28px;width:44px;padding:0;';
        bgColorInput.addEventListener('input', () => window.dnlSetBgColor(bgColorInput.value));
        bgColorRow.appendChild(bgColorSpan);
        bgColorRow.appendChild(bgColorInput);
        panel.appendChild(bgColorRow);

        const bgOpLabel = document.createElement('div');
        bgOpLabel.style.cssText = 'color:#6b7280;margin-bottom:4px;padding-left:18px;';
        const bgOpValSpan = document.createElement('span');
        bgOpValSpan.textContent = settings.bgOpacity + '%';
        bgOpLabel.textContent = 'Background opacity — ';
        bgOpLabel.appendChild(bgOpValSpan);
        panel.appendChild(bgOpLabel);

        const bgOpInput = document.createElement('input');
        bgOpInput.type = 'range';
        bgOpInput.min = '0'; bgOpInput.max = '100'; bgOpInput.step = '1';
        bgOpInput.value = String(settings.bgOpacity);
        // Same calc(50% - Npx) approach as sizeInput above, minus the 18px
        // left indent this row also carries so its right edge lines up with
        // the size slider's right edge.
        bgOpInput.style.cssText = 'width:calc(50% - 30px);margin-left:18px;';
        bgOpInput.addEventListener('input', () => {
            bgOpValSpan.textContent = bgOpInput.value + '%';
            window.dnlSetBgOpacity(parseFloat(bgOpInput.value));
        });
        panel.appendChild(bgOpInput);

        // Background color/opacity rows are only meaningful while the
        // background toggle itself is on — enable/disable them together
        // rather than leaving live controls for an inactive feature.
        const setBgSubRowsEnabled = (on) => {
            bgColorInput.disabled = !on;
            bgOpInput.disabled = !on;
            bgColorRow.style.opacity = bgOpLabel.style.opacity = bgOpInput.style.opacity = on ? '1' : '0.4';
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
            window.dnlSetHidePalmMuteMarkers(DEFAULT_SETTINGS.hidePalmMuteMarkers);
            cbHidePalmMute.checked = DEFAULT_SETTINGS.hidePalmMuteMarkers;
            window.dnlSetHideFretHandMuteMarkers(DEFAULT_SETTINGS.hideFretHandMuteMarkers);
            cbHideFretHandMute.checked = DEFAULT_SETTINGS.hideFretHandMuteMarkers;

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
            window.dnlSetHideChordNames(DEFAULT_SETTINGS.hideChordNames);
            cbHideChordNames.checked = DEFAULT_SETTINGS.hideChordNames;

            window.dnlSetSizeK(DEFAULT_SETTINGS.sizeK);
            sizeInput.value = String(DEFAULT_SETTINGS.sizeK);
            sizeValSpan.textContent = String(DEFAULT_SETTINGS.sizeK);

            window.dnlSetOffset(DEFAULT_SETTINGS.offsetX, DEFAULT_SETTINGS.offsetY);
            setDotFromOffset(DEFAULT_SETTINGS.offsetX, DEFAULT_SETTINGS.offsetY);

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
