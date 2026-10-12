# Canvas Organizer for Pi

[![CI](https://github.com/hrishiman-dev/canvas-organizer-pi/actions/workflows/ci.yml/badge.svg)](https://github.com/hrishiman-dev/canvas-organizer-pi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

A project-local Pi extension that turns Canvas, read-only Outlook mail, and Google Calendar into agent tools. When personal Canvas tokens are blocked, it reuses a dedicated browser login to read Canvas's structured data (not fragile dashboard HTML), shows incomplete work and announcements, finds future-event candidates in recent mail, checks calendar conflicts, and adds, edits, or removes events after a confirmation.

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
- “Scan my recent Outlook email for important future events.”
- “Show that Outlook message and copy its meeting to Google Calendar.”
- “Show every assignment and module in my chemistry course.”
- Active courses, visible grades, recent announcements, assignments, and modules
- `/today`, `/organizer-check`, `/organizer-canvas-login`, `/organizer-google-login`, and `/organizer-outlook-login`

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

## 3. Connect Outlook mail (optional)

Outlook access uses the official Microsoft Graph API with delegated, read-only `Mail.Read` permission. There is no Microsoft client secret and no paid cloud resource. The organizer stores only the resulting refresh token outside the repository.

1. Open the [Microsoft Entra admin center](https://entra.microsoft.com/) and create an **App registration**.
2. Choose the supported account type that matches your Outlook account. To support either personal Microsoft accounts or school accounts, select the multitenant-and-personal-accounts option.
3. Make sure you opened the registration under **Microsoft Entra ID → App registrations**, not the similarly named **Enterprise applications** area. Select the app, then open **Manage → Authentication → Advanced settings**. Set **Allow public client flows** to **Yes** and save. In some versions of the portal, the same switch is labeled **Enable the following mobile and desktop flows**.
   - If **Authentication** has no advanced-settings section, choose **Add a platform → Mobile and desktop applications**, select `https://login.microsoftonline.com/common/oauth2/nativeclient`, and save; then return to **Authentication** and enable the public-client switch.
   - If the portal still hides the switch, open **Manage → Manifest**, set `isFallbackPublicClient` to `true` in the Microsoft Graph manifest, and save. Older AAD Graph manifests call the same property `allowPublicClient`.
4. Under **API permissions**, add the Microsoft Graph delegated permission **Mail.Read**. Keep **User.Read**, which new registrations normally include. Do not add `Mail.ReadWrite`, `Mail.Send`, or application permissions.
5. Copy the app's **Application (client) ID** into `.env`. A client ID identifies the public app and is not a password:

   ```dotenv
   MICROSOFT_CLIENT_ID=00000000-0000-0000-0000-000000000000
   MICROSOFT_TENANT_ID=common
   ```

6. Restart Pi, then run:

   ```text
   /organizer-outlook-login
   ```

   Open the displayed Microsoft URL on any device, enter the short code, sign in, and then confirm in Organizer. The token is saved under your Windows AppData directory and is ignored by Git.

School Microsoft tenants can require administrator approval for `Mail.Read` or can block user-created app registrations. Organizer cannot bypass that policy. If consent is blocked, ask your school to approve this delegated read-only app; do not try to work around the tenant policy with a password, browser-cookie export, or broader permission.

The agent scans a bounded recent window—up to 365 days and 200 messages per request—instead of dumping an entire mailbox into the model. It first reads short previews, opens only selected messages for exact evidence, detects Microsoft meeting-message metadata when available, checks Google Calendar for duplicates, and then asks before creating each event. Ordinary email prose is never allowed to authorize a calendar write.

Microsoft documents desktop/public clients as unable to keep a client secret and supports delegated `Mail.Read` for both organizational and personal accounts. For implementation details, see [public client applications](https://learn.microsoft.com/en-us/entra/identity-platform/msal-client-applications), [delegated Graph authorization](https://learn.microsoft.com/en-us/graph/auth-v2-user), and [listing Outlook messages](https://learn.microsoft.com/en-us/graph/api/mailfolder-list-messages?view=graph-rest-1.0).

## 4. Optional: run Pi with a free local model

For an RTX 4060 with 16 GB of system RAM, start with Qwen 3.5 9B. The Ollama download is about 6.6 GB and supports tool calling. Larger 20B/27B models will spill heavily into system RAM or fail to fit comfortably.

1. Install [Ollama](https://ollama.com/download/windows).
2. Download the model:

```powershell
ollama pull qwen3.5:9b
```

3. Configure Ollama for a 16K context, which prevents longer Organizer conversations from ending with a thinking-only response:

```powershell
[Environment]::SetEnvironmentVariable('OLLAMA_CONTEXT_LENGTH', '16384', 'User')
```

   Fully quit and reopen Ollama after changing it. On lower-memory systems, use `8192` instead.
4. Copy `pi-models.ollama.example.json` to `$env:USERPROFILE\.pi\agent\models.json`. If that destination already exists, merge the `ollama` provider into it instead of replacing it. Keep its `contextWindow` equal to the Ollama setting.
5. Start Pi, run `/model`, and select **Qwen 3.5 9B (local)**.

The example uses a 16K context and 4K maximum response. Larger contexts consume substantial VRAM/RAM; if Ollama is left at its 4K default while Pi advertises a larger window, long chats can silently exhaust the real context before Pi compacts them. Local inference has no per-token fee, but it is limited by hardware speed, electricity, storage, and model quality.

## 5. Start Pi

After Pi finishes installing, open PowerShell in this folder and run:

```powershell
pi
```

Approve the project-local extension if Pi asks. Then run:

```text
/organizer-check
/organizer-canvas-login
/organizer-google-login
/organizer-outlook-login
/today
```

Pi automatically loads `.pi/extensions/organizer.ts` and the instructions in `AGENTS.md` when started from this directory.

## Security model

- Canvas is read-only.
- Calendar writes require an interactive confirmation.
- Outlook is read-only and requests delegated `Mail.Read`, never `Mail.Send` or `Mail.ReadWrite`.
- Email text is bounded, converted to plain text, and labeled untrusted; it cannot authorize tools or calendar writes.
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

The web interface supports streaming replies, queued follow-up prompts, automatic history resynchronization, conversation reset/stop, and durable Pi extension confirmations across reconnects. It actively reconnects after a phone or laptop wakes from sleep, preserves an unsent draft and in-flight message state, and tracks every message through accepted, running, completed, or failed. A thinking-only/context-limited response appears explicitly with a safe manual **Retry** option instead of disappearing. If a reply appears stuck, use **Sync** in the header; syncing never resends an accepted prompt, so it cannot duplicate a calendar request. Calendar changes still require an explicit confirmation from the remote interface.

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
