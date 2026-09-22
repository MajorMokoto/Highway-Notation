# Highway Notation

Draws the note letter (A–G♯) on every fret, on both the 3D Highway and the classic 2D Highway. Also highlights the song's key/root note (auto set if in the song's data, or manually set in the pane settings), shows a full-fretboard scale overlay (3D), and allows manually positioning chord names over the chord/fretboard.

**[Download the zip](https://github.com/MajorMokoto/Highway-Notation/releases/latest/download/Highway-Notation.zip)**

## Installation

This isn't a single drop-in plugin — the download has three folders, and they don't all go to the same place. Please place each folder in the locations listed below. Overwrite existing files.

1. **Highway Notation Plugin**
   `highway_notation` folder install location: `feedback\current\resources\slopsmith\plugins\`

2. **Updated 3D Highway** (Required for notes to display on 3D Highway)
   `highway_3d` folder install location: `feedback\current\resources\slopsmith\plugins\`

3. **Updated 2D Highway** (Required for notes to display on 2D Highway)
   `static` folder install location: `feedback\current\resources\slopsmith\` 

Paths above are for Windows. On other platforms, the `resources\slopsmith\` folder lives in a different place:

- **Windows**: `C:\Program Files\feedback\current\resources\slopsmith\plugins\`
- **macOS**: `/Applications/FeedBack.app/Contents/Resources/slopsmith/`
- **Linux**: varies by install method — an AppImage needs to be extracted (`--appimage-extract`) to get a real folder to drop files into; a `.deb` install is likely under `/home/user/.config/feedback-desktop/plugins/`

## 3D Highway

<table><tr>
<td width="50%"><img src="Screenshots/3D Highway Defaults.PNG" width="100%"><br><sub>Default</sub></td>
<td width="50%"><img src="Screenshots/3D Highway Hardmode.PNG" width="100%"><br><sub>Hardmode — fret numbers hidden</sub></td>
</tr></table>

## Scale Overlay (3D)

Shows the current key's scale across the whole fretboard, not just the notes in the chart — either as dots or as the actual note letters.

<table><tr>
<td width="50%"><img src="Screenshots/3D Highway Scales Dots.PNG" width="100%"><br><sub>Dots</sub></td>
<td width="50%"><img src="Screenshots/3D Highway Scales Notes.PNG" width="100%"><br><sub>Note letters</sub></td>
</tr></table>

The song's key is auto-detected when the song has key data. When it doesn't — or the auto-detected key isn't the one you want — you can set the key and scale manually per song from the settings pane, and separately for Virtuoso, since it doesn't share the same song data. The root note also gets a ring around its letter wherever it appears, so the key's home note stands out at a glance.

## Chord Names (3D)

The chord name is centered over the actual strum shape as it approaches and strikes, instead of anchoring to a single string.

![Chord name centered over the strum shape](Screenshots/3D%20Highway%20Chord%20Names.PNG)

## 2D Highway

<table><tr>
<td width="50%"><img src="Screenshots/2D Highway Defaults.PNG" width="100%"><br><sub>Default</sub></td>
<td width="50%"><img src="Screenshots/2D Highway Hardmode.PNG" width="100%"><br><sub>Hardmode — fret numbers hidden</sub></td>
</tr></table>

![Letter position can be dragged off the fret number](Screenshots/2D%20Highway%20Note%20Letter%20Offset.PNG)
<sub>Letter position can be dragged off the fret number</sub>

## Virtuoso

> The settings pane needs to be opened before switching to Virtuoso — Virtuoso doesn't currently expose the Panes sidebar itself. This will be fixed in a future Virtuoso update to let the notation settings be opened directly from within it.

![Note letters in Virtuoso practice mode](Screenshots/Virtuoso.PNG)

## Settings

Opens as a floating pane from the sidebar's Panes popup.

<table><tr>
<td width="50%"><img src="Screenshots/How to access settings pane.PNG" width="100%"></td>
<td width="50%"><img src="Screenshots/Notation Settings Menu.PNG" width="100%"></td>
</tr></table>
