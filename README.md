# Roadmap

A native macOS app for interactive product roadmaps. Built with Tauri 2 (Rust + WebView).

## Features

- Multi-window: each .roadmap file opens in its own window
- File association: double-clicking a .roadmap file in Finder opens the app
- Auto-save with debounce to disk
- Interactive Gantt grid: drag bars to move, drag edges to resize, drag the row number to reorder
- Inline rename for initiatives (double-click the name)
- Edit modal: category, dev weeks, JIRA link with open-in-browser, dependencies, description
- Month-level timeline with year/quarter/month bands, add or remove years dynamically
- Editable legend with colour picker
- Welcome view with recent files, auto-opens the most recent file on startup
- SVG export for presentations (vector, scales infinitely)
- Native macOS menu with Recent submenu
- Light and dark mode (follows system setting)

## Prerequisites

On your Mac:

```bash
# Rust toolchain
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js (16+)
brew install node

# Xcode Command Line Tools
xcode-select --install
```

## First-time setup

```bash
cd roadmap-app
npm install
```

Installs the Tauri CLI and frontend dependencies. Takes a few minutes the first time.

## Dev mode

```bash
npm run tauri dev
```

Starts the app with hot reload for frontend changes. The first run compiles the Rust code in 2-5 minutes, after that the app starts in seconds.

## Release build

```bash
npm run tauri build
```

Output:

- `src-tauri/target/release/bundle/macos/Roadmap.app`
- `src-tauri/target/release/bundle/dmg/Roadmap_0.1.0_aarch64.dmg`

Takes 3-10 minutes depending on incremental cache.

Universal binary (Intel + Apple Silicon):

```bash
rustup target add x86_64-apple-darwin
npm run tauri build -- --target universal-apple-darwin
```

## Menu shortcuts

| Shortcut | Action |
|---|---|
| Cmd+N | New window |
| Cmd+O | Open file |
| Cmd+W | Close window |
| Cmd+S | Save |
| Cmd+Shift+S | Save As |
| Cmd+Shift+E | Export as HTML |
| Cmd+Shift+P | Export as SVG |

## Distribution and signing

An unsigned .dmg works for internal sharing. The recipient right-clicks the .app and chooses Open the first time to bypass Gatekeeper.

For public distribution you need an Apple Developer account (around USD 99 per year) plus a Developer ID certificate.

### One-time setup

1. Sign up for an Apple Developer account at `https://developer.apple.com/programs/`
2. Generate a Developer ID Application certificate in the portal
3. Install the certificate in Keychain
4. Note your Team ID

### Configure signing in tauri.conf.json

```json
"macOS": {
  "signingIdentity": "Developer ID Application: Your Name (TEAMID)",
  "providerShortName": null,
  "entitlements": null
}
```

### Notarisation

```bash
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"
export APPLE_TEAM_ID="TEAMID"
npm run tauri build
```

Tauri notarises automatically when these env vars are set.

## Auto-updater

The plumbing is in place but requires setup before the first release.

### Generate signature key (once)

```bash
npm run tauri signer generate -- -w ~/.tauri/roadmap.key
```

### Configure tauri.conf.json

Set the public key in `plugins.updater.pubkey`:

```json
"updater": {
  "pubkey": "PUBLIC_KEY_FROM_ABOVE",
  "endpoints": ["https://github.com/sievertz/roadmap-app/releases/latest/download/latest.json"]
}
```

### Build with signing

```bash
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/roadmap.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="password-if-you-set-one"
npm run tauri build
```

### Publish a release

1. Create a GitHub release with tag `v0.1.0`
2. Upload the DMG file
3. Upload a `latest.json` with this format:

```json
{
  "version": "0.1.0",
  "notes": "Description of changes",
  "pub_date": "2026-05-20T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "CONTENTS_OF_DMG.sig",
      "url": "https://github.com/sievertz/roadmap-app/releases/download/v0.1.0/Roadmap_0.1.0_aarch64.dmg"
    }
  }
}
```

When a user's app starts it checks the endpoint URL, compares versions and shows an update dialog if a new version is available.

## Project structure

```
roadmap-app/
├── index.html              Frontend entry
├── src/
│   ├── main.js             Frontend logic, drag-and-drop, SVG export, Tauri API
│   └── styles.css          UI styling, light/dark mode variables
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         Entry point (calls lib::run)
│   │   ├── lib.rs          Tauri builder, plugin setup, command registration
│   │   ├── commands.rs     File IO, dialogs, recent files, open_external
│   │   └── menu.rs         Native macOS menu and event dispatch
│   ├── icons/              App icons (PNG, ICNS, ICO)
│   ├── capabilities/       Per-window permissions
│   ├── Cargo.toml          Rust dependencies
│   ├── build.rs            Build script
│   └── tauri.conf.json     App config (name, bundle id, icons, updater)
├── package.json
├── vite.config.js
└── README.md
```

## File format

.roadmap files are JSON with this structure:

```json
{
  "v": 5,
  "config": {
    "startYear": 2026,
    "startMonth": 1,
    "endYear": 2027,
    "endMonth": 12,
    "labelColumnWidth": 200
  },
  "initiatives": [
    {
      "id": "...",
      "label": "Initiative name",
      "position": { "s": 0, "e": 5 },
      "type": "committed",
      "weeks": 4,
      "jira": "https://...",
      "dependencies": "team Andromeda",
      "description": "...",
      "adjustable": true,
      "dashed": false
    }
  ],
  "legend": [
    { "id": "committed", "label": "Committed", "color": "#378ADD" }
  ],
  "savedAt": "2026-05-20T12:00:00.000Z"
}
```

The schema version (`v` field) is used for migration when reading older files.

## Common problems

### "Failed to compile" on first run
Most likely missing Xcode Command Line Tools. Run `xcode-select --install`.

### App does not start in dev mode
Port 1420 is occupied. Run `lsof -i:1420` and stop the process, or change the port in vite.config.js and tauri.conf.json.

### Build fails with icon error
Regenerate the icon set: `npm run tauri icon ./src-tauri/icons/icon.png`

### Permission denied when pushing to GitHub over SSH
The SSH key is missing locally or has not been uploaded to `https://github.com/settings/keys`.
