# Canvas Organizer for Pi

[![CI](https://github.com/hrishiman-dev/canvas-organizer-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/hrishiman-dev/canvas-organizer-pi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A project-local Pi extension that turns Canvas and Google Calendar into agent tools. When personal Canvas tokens are blocked, it reuses a dedicated browser login to read Canvas's structured data (not fragile dashboard HTML), shows incomplete work and announcements, checks calendar conflicts, and adds, edits, or removes events after a confirmation.

> [!IMPORTANT]
> This is an independent community project. It is not affiliated with, endorsed by, or supported by Instructure, Google, Tailscale, Ollama, or the Pi project. Follow your school's acceptable-use and data-handling policies.

The project is local-first: the bridge binds only to loopback, credentials stay outside the repository, and remote access is designed for a private Tailscale network. The computer running Pi and the model must remain online.

## Requirements

- Windows 10 or 11
- Node.js 22.6 or newer
- [Pi](https://github.com/earendil-works/pi) 0.85.1 or newer
- Chrome or Edge for saved-session Canvas access
- A model provider; [Ollama](https://ollama.com/) is optional for local inference
- Optional: [Tailscale](https://tailscale.com/) for private access from other devices

## Install

```powershell
git clone https://github.com/hrishiman-dev/canvas-organizer-pi.git
cd canvas-organizer-pi
Copy-Item .env.example .env
```

Edit `.env`, then start `pi` from the repository root. Pi discovers the project extension and `AGENTS.md` automatically. This project has no npm runtime dependencies.

## What works

- “What do I need to do today?”
- “What is due in the next two weeks?”
- “What is on my calendar tomorrow?”
- “Add a study block Friday from 6–8 PM.”
- “Move my Friday study block to 7 PM.”
- “Delete tomorrow's dentist appointment.”
- “Summarize new Canvas announcements from the last week.”
- “Show every assignment and module in my chemistry course.”
- Active courses, visible grades, recent announcements, assignments, and modules
- `/today`, `/organizer-check`, `/organizer-canvas-login`, and `/organizer-google-login`

The organizer does not submit assignments or send Canvas messages. An optional Windows task can refresh a daily briefing in the background at no cost.

Calendar creation, edits, and deletion are live. The agent first resolves the exact event and then shows an interactive confirmation before making the change.

## 1. Configure Canvas

### Recommended when personal tokens are disabled: saved browser login

Set your school's normal Canvas address in `.env`:

```dotenv
CANVAS_BASE_URL=https://your-school.instructure.com
CANVAS_BROWSER=chrome
```

Then start Pi and run:

```text
/organizer-canvas-login
```

A separate Chrome profile opens. Complete your school password and Duo yourself. Pi never reads or stores either one. Chrome stores the resulting signed-in session in `%LOCALAPPDATA%\CanvasOrganizer\canvas-browser-profile`, and it can also save the username and password in its built-in password manager if you accept Chrome's **Save password** prompt yourself. Chrome protects saved passwords with your Windows account rather than leaving them as readable text in the project.

Future Canvas reads reuse that session, including in a headless browser when the login window is closed. If the school expires only the Canvas session, rerun `/organizer-canvas-login`; Chrome should autofill the saved username and password, though you may still need to click **Sign in** and complete Duo if the school requests it. Never put the password in Notepad, `.env`, source code, or a message to the agent.

Once connected, the agent can read incomplete planner items with submission state, recent announcements, active courses and visible current grades. It can also inspect one course's assignments and modules. Canvas remains read-only: it cannot submit work, send messages, or change course data.

If `CANVAS_ICAL_URL` is already configured, `/organizer-canvas-login` can infer the school's Canvas hostname from it, so adding `CANVAS_BASE_URL` is optional.

### Limited fallback: Calendar Feed

In Canvas, open **Calendar → Calendar Feed**, copy the private feed URL, and put it in `.env`:

```dotenv
CANVAS_ICAL_URL=https://your-school.instructure.com/feeds/calendars/your_private_feed.ics
```

Treat that URL like a password. It provides assignments and calendar events without a custom access token. It does **not** contain submission/completion status, announcements, modules, grades, or full dashboard activity, so the agent will label its answers accordingly.

You can also subscribe to this same URL directly from Google Calendar using **Other calendars → From URL**. That gives you a read-only Canvas calendar on both PC and iPhone, although Google's refresh timing is not immediate.

### Optional personal-token API mode

If your school allows it, open **Account → Settings → Approved Integrations → New Access Token**. Give it a short expiry while testing. If your school hides that button, full API access requires a school-approved OAuth developer key.

Copy `.env.example` to `.env`, then set:

```dotenv
CANVAS_BASE_URL=https://your-school.instructure.com
CANVAS_ACCESS_TOKEN=your_token
```

Use the real hostname from your Canvas address. Do not add `/api/v1`. `.env` is ignored by Git.

## 2. Configure Google Calendar

Google Calendar is the best fit here: it works well from Windows and syncs to either the Google Calendar iPhone app or Apple's built-in Calendar app.

The Google Calendar API is free for this personal use. Google Cloud Console is used to create the app identity and OAuth credentials; you do not need to start a free trial, add a payment card, or attach a billing account. Leave billing disabled. The organizer makes only a handful of requests, far below Google's free standard-use quota.

1. Create a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable **Google Calendar API**.
3. Configure the OAuth consent screen. For a personal Gmail account, choose **External** and add your own Google address as a test user while setting it up.
4. Create an OAuth client with application type **Desktop app**.
5. Put the client ID and secret in `.env`:

```dotenv
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
```

Start Pi from the repository root, then authorize the Google account whose calendar you want to manage:

```text
/organizer-google-login
```

Complete the browser consent screen. The organizer saves the resulting refresh token outside the repository; do not copy it into `.env` or commit it.

The project requests only the `calendar.events` scope. The Google refresh token is stored outside this repo under your Windows AppData directory.

Google normally expires refresh tokens after seven days while an External app remains in **Testing**. For persistent personal use, review Google's current OAuth publishing requirements before changing the app to **In production**. Google may show an “unverified app” warning or require verification depending on the scopes and audience; do not add users you do not trust.

On your iPhone, either install Google Calendar and sign into the same account, or go to **Settings → Apps → Calendar → Calendar Accounts → Add Account → Google** and enable Calendars.

## 3. Optional: run Pi with a free local model

For an RTX 4060 with 16 GB of system RAM, start with Qwen 3.5 9B. The Ollama download is about 6.6 GB and supports tool calling. Larger 20B/27B models will spill heavily into system RAM or fail to fit comfortably.

1. Install [Ollama](https://ollama.com/download/windows).
2. Download the model:

```powershell
ollama pull qwen3.5:9b
```

3. Copy `pi-models.ollama.example.json` to `$env:USERPROFILE\.pi\agent\models.json`. If that destination already exists, merge the `ollama` provider into it instead of replacing it.
4. Start Pi, run `/model`, and select **Qwen 3.5 9B (local)**.

The example deliberately advertises a 32K context and 4K maximum response. Although the model supports more, larger contexts consume substantial VRAM/RAM. Local inference has no per-token fee, but it is limited by hardware speed, electricity, storage, and model quality.

## 4. Start Pi

After Pi finishes installing, open PowerShell in this folder and run:

```powershell
pi
```

Approve the project-local extension if Pi asks. Then run:

```text
/organizer-check
/organizer-canvas-login
/organizer-google-login
/today
```

Pi automatically loads `.pi/extensions/organizer.ts` and the instructions in `AGENTS.md` when started from this directory.

## Security model

- Canvas is read-only.
- Calendar writes require an interactive confirmation.
- Announcement text is converted to bounded plain text and labeled untrusted; assignment descriptions are not passed to the model.
- Passwords and Duo responses are entered only by you in the school login page. The agent stores a dedicated browser session, not the credentials.
- Secrets stay in ignored `.env` and AppData files.
- Pi itself runs with your Windows account permissions, so only install extensions you trust.
- The remote bridge has no standalone password screen. Its security boundary is loopback plus your Tailscale identity and access rules.
- The remote interface uses one shared Pi session. Treat every device allowed into the tailnet as able to view and control that conversation.

## Optional automatic daily briefing

Inside Pi, enable a daily 7:30 AM background refresh with:

```text
/organizer-enable-daily
```

Or choose another time using 24-hour notation:

```text
/organizer-enable-daily 06:45
```

Windows Task Scheduler runs the project-local launcher while you are logged in. It creates or refreshes one **📚 Canvas daily brief** event at 8:00 AM with a 10-minute notification and the next seven days of Canvas items. It is deterministic and does not let the model edit arbitrary events unattended.

Test it immediately with `/daily-brief`. Disable it with `/organizer-disable-daily`. Logs are written to `.organizer/daily-brief.log`.

## Private access from another computer or phone

The organizer includes a small mobile-friendly web interface that talks to Pi through its official RPC mode. It listens only on `127.0.0.1`; use Tailscale Serve to make it available privately to your own devices. Do not forward port 8787 on your router and do not use Tailscale Funnel, which would make it public.

### One-time setup

1. Install [Tailscale](https://tailscale.com/download/windows) on the organizer computer and sign in with a personal account. Install Tailscale on each other computer or iPhone and sign into the same tailnet.
2. In the PowerShell window where `pi` works, locate it:

   ```powershell
   Get-Command pi | Select-Object CommandType,Source,Path,Definition
   ```

3. Put the executable or `.cmd` path in `.env` as `PI_COMMAND`. If Pi is a normal executable already on the system PATH, `PI_COMMAND=pi` is enough.
4. Start the local bridge:

   ```text
   scripts\run-remote.cmd
   ```

5. In another PowerShell window, expose it only to the tailnet:

   ```text
   scripts\expose-remote.cmd
   ```

   Tailscale prints the private HTTPS address. Open that address from any signed-in device. On iPhone, use Safari's **Add to Home Screen** for an app-like shortcut.

The web interface supports streaming replies, queued follow-up prompts, automatic history resynchronization, conversation reset/stop, and durable Pi extension confirmations across brief reconnects. Calendar changes still require an explicit confirmation from the remote interface.

To launch the bridge without a visible terminal, run `scripts\start-remote-hidden.vbs` from its location in the repository. If you want it at sign-in, create a shortcut to that file in `shell:startup`; do not copy the VBS file out of the repository because it resolves the launcher relative to its own location.

### Availability

The computer running Ollama, Pi, the Canvas browser profile, and the Calendar credentials must be powered on and online. A powered-off laptop cannot answer requests. For 24/7 access without leaving this laptop on, install the organizer, Ollama model, Canvas login, Google authorization, and Tailscale on an always-on Windows desktop or mini PC. There is no dependable free hosted GPU equivalent; a cloud VPS plus a hosted model would generally be paid and would move private school data off your computer.

## Tests

No package install is needed:

```powershell
npm test
npm run check
```

The test suite covers Canvas normalization and sanitization, calendar time guards, iCalendar parsing, and the local remote bridge's security headers and input validation. CI runs the same checks on Windows with Node.js 22.

## Contributing and security

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Please report sensitive problems privately as described in [SECURITY.md](SECURITY.md). The project is available under the [MIT License](LICENSE).
