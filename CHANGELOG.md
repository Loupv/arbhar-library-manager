# Changelog

All notable changes to this project are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [1.0.2] — 2026-07-21

### Fixed
- macOS binaries were killed on launch (`zsh: killed`) because cross-building on Linux
  left them unsigned — Apple Silicon refuses to run unsigned executables. Releases now
  build on a macOS runner, so pkg ad-hoc code-signs the mac binaries and they run
  (first launch: right-click → Open).

## [1.0.1] — 2026-07-21

### Added
- Create **several folders at once** in the reserve (comma-separated names in `+ folder`).

### Changed
- Drop hint names the OS file manager (**Finder** on macOS, **File Explorer** on Windows).
- Removed the `rows = bank · columns = layer` header legend for a cleaner header.

## [1.0.0] — 2026-07-21

First public release.

### Added
- **Library browser** — 6 libraries, each a 6×6 `bank × layer` grid mirroring the arbhar
  `#_#_sample` folder convention; a gold dot marks filled slots.
- **Scenes editor** — `Bank` + `Scene` selectors and a sub-grid of the scene's 6 layers;
  `preset.txt` is detected and preserved.
- **Folder picker** — mounted-volume shortcuts, auto-relocation when the wrong nesting
  level is chosen, remembers the last folder, optional scaffolding of the full structure,
  and a Close button to return to the current library.
- **Audition** — click any slot/tile to play; persistent bottom player with a seekable
  bar; keyboard navigation (`↑↓←→`, `Tab`, `space`); playback auto-stops when you leave
  the tab/bank/scene/screen or collapse the folder holding the playing sample.
- **Waveform editor** — trim (drag the edges), fade in/out, and peak **normalize** to a
  global dB target; non-destructive with an **Undo** toast (originals go to the trash).
  Output is written as 24-bit / 48 kHz.
- **Drag & drop** — from Finder onto a slot/layer (replace) or into the reserve (including
  whole folders); reserve → slot/layer; slot/layer → reserve (copy); a reserve folder onto
  a scene fills its 6 layers from the folder's first 6 audio files.
- **Reserve** — an accordion folder tree: create folders/subfolders, move items by drag,
  alphabetical sort; the whole panel is a drop target.
- **Delete with undo** — a discrete `✕` on tiles/rows clears without confirmation; every
  delete/edit is reversible via an Undo toast and the in-app `.trash`.
- **Instruō-style** dark/gold theme, English UI, custom sliders/checkbox/stepper.
- **Zero runtime dependencies**; standalone macOS/Windows binaries built via
  [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) and released through GitHub Actions.

[1.0.2]: https://github.com/Loupv/arbhar-library-manager/releases/tag/v1.0.2
[1.0.1]: https://github.com/Loupv/arbhar-library-manager/releases/tag/v1.0.1
[1.0.0]: https://github.com/Loupv/arbhar-library-manager/releases/tag/v1.0.0
