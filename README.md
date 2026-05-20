# Roadmap

Native macOS-app för interaktiva produkt-roadmaps. Byggd med Tauri 2 (Rust + webview), porterar funktionaliteten från den webbaserade artefakten.

## Status

v0.1.0 - session 1 av 3. Projektet kompilerar och startar ett tomt fönster med fungerande menyrad. Frontend porteras i session 2.

## Förkrav

På din Mac behöver du:

1. Rust toolchain
```
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

2. Node.js (16+)
```
brew install node
```

3. Xcode Command Line Tools (för macOS-bundling)
```
xcode-select --install
```

## Setup första gången

```
cd roadmap-app
npm install
```

Detta installerar Tauri CLI och frontend-beroenden. Tar några minuter första gången.

## Dev-läge

```
npm run tauri dev
```

Startar appen i dev-läge med hot-reload på frontend-ändringar. Första körningen kompilerar Rust-koden vilket tar 2-5 minuter. Sedan startar appen på sekunder.

Du borde se ett fönster med Roadmap-logon och placeholder-text. Filmenyn är aktiv:
- Cmd+N öppnar nytt fönster
- Cmd+O öppnar fildialog
- Cmd+S, Cmd+Shift+S, Cmd+Shift+E loggar till console (riktig implementation i session 2)

## Bygga release-version

```
npm run tauri build
```

Producerar en signerbar .app i `src-tauri/target/release/bundle/macos/Roadmap.app` och en DMG-fil i `src-tauri/target/release/bundle/dmg/`. Tar 3-10 minuter.

För osignerad .app: bara dra till Applications. Användaren behöver höger-klicka → Open första gången för att kringgå Gatekeeper.

## Distribution och signering

För att slippa Gatekeeper-varningar behöver appen signeras med ett Apple Developer-cert ($99/år).

### Engångssetup
1. Skaffa Apple Developer-konto: https://developer.apple.com/programs/
2. Generera Developer ID Application-cert i Apple Developer-portalen
3. Installera cert i Keychain
4. Hitta team identifier (i Apple Developer-portalen)

### Konfigurera signering i tauri.conf.json
```json
"macOS": {
  "signingIdentity": "Developer ID Application: Ditt Namn (TEAMID)",
  "providerShortName": null,
  "entitlements": null
}
```

### Notarization (krävs för distribution utanför App Store)
Sätt environment variables och kör build:
```
export APPLE_ID="din@email.com"
export APPLE_PASSWORD="app-specifikt-lösenord"
export APPLE_TEAM_ID="TEAMID"
npm run tauri build
```

Tauri notariserar automatiskt under build om dessa vars är satta.

## Auto-updater

Auto-updatern är konfigurerad men kräver setup innan första release.

### Generera signature key (engång)
```
npm run tauri signer generate -- -w ~/.tauri/roadmap.key
```

Detta skapar ett key pair. Public key sparas, private key används vid release-build.

### Konfigurera tauri.conf.json
Sätt public key i `plugins.updater.pubkey`:
```json
"updater": {
  "pubkey": "PUBLIC_KEY_FROM_ABOVE",
  "endpoints": ["https://github.com/DITT-USERNAME/roadmap-app/releases/latest/download/latest.json"]
}
```

### Build med signering
```
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/roadmap.key
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="lösenord-om-du-satte-ett"
npm run tauri build
```

### Publicera release
1. Skapa en GitHub release med tag `v0.1.0` (eller motsvarande)
2. Ladda upp DMG-filen
3. Ladda upp en `latest.json` med struktur:
```json
{
  "version": "0.1.0",
  "notes": "Beskrivning av ändringar",
  "pub_date": "2026-05-20T12:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "INNEHÅLL_AV_DMG.sig",
      "url": "https://github.com/.../Roadmap_0.1.0_aarch64.dmg"
    },
    "darwin-x86_64": {
      "signature": "INNEHÅLL_AV_DMG.sig",
      "url": "https://github.com/.../Roadmap_0.1.0_x86_64.dmg"
    }
  }
}
```

När användarens app startar kollar den endpoint-URLen, jämför versioner, och visar update-dialog om ny version finns.

## Projektstruktur

```
roadmap-app/
├── index.html              Frontend entry point
├── src/
│   ├── main.js             Tauri API calls + menu event handlers
│   └── styles.css          Frontend styling
├── src-tauri/
│   ├── src/
│   │   ├── main.rs         Entry point (calls lib::run)
│   │   ├── lib.rs          Tauri builder, plugin setup
│   │   ├── commands.rs     File IO, dialogs, recent files
│   │   └── menu.rs         Native macOS menyrad
│   ├── icons/              App-ikoner (PNG, ICNS, ICO)
│   ├── capabilities/       Permissions per fönster
│   ├── Cargo.toml          Rust-beroenden
│   ├── build.rs            Build script
│   └── tauri.conf.json     App-config (namn, bundle id, ikoner, updater)
├── package.json
├── vite.config.js
└── README.md
```

## Vanliga problem

### "Failed to compile" första körningen
Sannolikt saknad Xcode Command Line Tools. Kör `xcode-select --install`.

### Appen startar inte i dev-läge
Verifiera att port 1420 är ledig: `lsof -i:1420`. Om upptagen, ändra i vite.config.js och tauri.conf.json.

### Build misslyckas med ikon-error
Om `icon.icns` är skadad, kör `npm run tauri icon ./src-tauri/icons/icon.png` för att regenerera hela ikon-setet.

## Vad som kommer i session 2

- Portering av nuvarande HTML/JS/CSS från artefakten in i frontend
- Koppla File-menyn till verkliga spara/öppna-flöden
- Auto-save till .roadmap-fil
- Multi-window för flera samtidigt öppna roadmaps
- Window-titel speglar filnamn
- Recent files-listan visas i menyn

## Vad som kommer i session 3

- Export as HTML implementation
- Auto-updater publishing setup
- Polish: about-dialog, keyboard shortcuts, file format dokumentation
- Smoke-test av distribuerbar build
