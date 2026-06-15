# Setup

Shadow AI is **Windows-only**.

## For users (the installer)

1. **Run `ShadowAI-Setup.exe`.** It installs per-user (no admin needed) and bundles
   everything it needs — Python, Node, and the SearXNG search engine — so there's nothing
   else to install. (Docker is *not* required.)
2. **Launch Shadow AI** from the Start menu (or the desktop shortcut if you chose it). A
   console window stays open while it runs — keep it open; close it to shut Shadow down.
3. **Enter your Gemini API key** on first run. It's free — get one at
   [Google AI Studio](https://aistudio.google.com/apikey). Your key is stored locally on
   your machine and is never uploaded anywhere except to Google.
4. **Start talking.** That's it — voice, memory, and web search work out of the box.

### Optional: connect Google (Gmail / Calendar / Contacts)
Entirely optional. Open **Integrations → "First time connecting Google? Step-by-step
guide"** and follow the in-app wizard (it deep-links to the right Google Cloud pages and
gives you the exact values to paste). Because you use your own Google credentials, no
Google app-verification is involved.

### Notes
- For the best experience Shadow opens in a Chrome app window if Chrome is installed;
  otherwise it opens in your default browser. The microphone works either way (it runs on
  `127.0.0.1`).
- All your data (settings, memories, learned skills) lives in the install folder under
  your user profile and is removed if you uninstall.

## For developers (run from source)

Prerequisites: **Node.js**, **Python 3.11+**, and **git**.

```powershell
git clone https://github.com/shadowdoggie/shadow-ai.git
cd shadow-ai
npm install            # test/dev tooling (vitest, playwright)
```

Web search needs a SearXNG backend. Either:
- run a SearXNG yourself (e.g. Docker) on `http://127.0.0.1:8888`, or
- build the bundled one once: `pwsh -File tools/prepare-searxng.ps1`
  (creates `./searxng`, which `run.ps1` then launches automatically).

Then start the app:

```powershell
npm start              # or: run.bat
npm test               # run the vitest suite
```

## Building the installer

Requires **Inno Setup** ([download](https://jrsoftware.org/isdl.php) or
`winget install JRSoftware.InnoSetup`).

```powershell
pwsh -File tools/build-installer.ps1
```

This downloads relocatable Python + Node, prepares a Windows-patched SearXNG, stages the
app, and compiles `dist/ShadowAI-Setup.exe`. Pass `-SkipInstallerCompile` to assemble the
payload without compiling.
