# Building standalone executables (macOS + Windows)

The app can be packaged into a **single self-contained binary per platform** — no
Node.js required on the recipient's machine. The UI assets are embedded; the reserve
(`staging/`), trash (`.trash/`) and `.config.json` are created **next to the executable**
at runtime.

## Build

From the `arbhar-library-editor/` folder:

```bash
npm run build
```

(or, without installing anything: `npx @yao-pkg/pkg . --out-path dist`)

This produces, in `dist/`:

| File | Platform |
|------|----------|
| `arbhar-library-editor-macos-arm64`  | macOS, Apple Silicon (M1/M2/M3…) |
| `arbhar-library-editor-macos-x64`    | macOS, Intel |
| `arbhar-library-editor-win-x64.exe`  | Windows 64-bit |

Targets are configured in `package.json` → `pkg.targets`. Add/remove as needed
(e.g. `node22-linux-x64`).

## How recipients run it

Double-click, or run from a terminal. It starts a local server and opens the app in the
default browser (`http://localhost:4173`). Closing the terminal/console window quits it.

Because the binaries are **unsigned**, the OS will warn on first launch:

- **macOS** — right-click the file → **Open** → **Open** (once). If still blocked
  (recent macOS), go to **System Settings → Privacy & Security** and click
  **Open Anyway**. Or, in a terminal: `xattr -d com.apple.quarantine arbhar-library-editor-macos-arm64`.
- **Windows** — SmartScreen shows *"Windows protected your PC"* → **More info** →
  **Run anyway**.

Nothing is installed system-wide; delete the file to remove it. The `staging/`, `.trash/`
and `.config.json` it creates live in the same folder as the binary.

## Notes for sharing with the Instruō team

- Zero runtime dependencies; each binary bundles its own Node runtime (~55–65 MB).
- It only reads/writes the sample folders the user explicitly opens, plus its own
  `staging/`/`.trash/` next to the executable. It makes no network connections
  (localhost only).
- This is an **unofficial** community tool — not affiliated with Instruō.
- For a smoother install later (signed `.app` / `.exe`, custom icon), the binary can be
  wrapped + code-signed; that needs an Apple Developer ID / Windows signing cert.
