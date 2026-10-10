# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability that could expose Canvas sessions, calendar credentials, or private student data. Use GitHub's private vulnerability reporting feature for this repository instead.

Include the affected version, a minimal reproduction, and the impact. Do not include real access tokens, OAuth credentials, browser-profile files, course data, or screenshots containing student information.

## Security boundaries

- The web bridge listens on `127.0.0.1` only. Keep it private with Tailscale Serve; never expose it with Tailscale Funnel or router port forwarding.
- `.env`, `.organizer`, Canvas browser profiles, and Google refresh tokens must never be committed.
- Canvas access is intentionally read-only. Google Calendar writes require interactive confirmation, except for the narrowly scoped daily-brief event.
- Pi extensions execute with the user's operating-system permissions. Review local changes before trusting or running them.
