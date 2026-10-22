# Getting Started with Design Change Log (v2)

This tool watches your Figma files for changes and automatically posts structured changelogs to Jira, Slack, and/or Microsoft Teams — with direct deep-links to every changed node.

---

## Before you begin

You'll need the following credentials ready:

| Credential | Where to get it |
|---|---|
| **Figma Personal Access Token** | Figma → Account Settings → Personal access tokens → Generate new token |
| **Jira API Token** | [id.atlassian.com → Security → API tokens](https://id.atlassian.com/manage-profile/security/api-tokens) |
| **Jira base URL** | Your org's Atlassian URL, e.g. `https://your-org.atlassian.net` |
| **Slack webhook URL** *(optional)* | Slack → Apps → Incoming Webhooks |
| **Teams webhook URL** *(optional)* | Teams channel → Connectors → Incoming Webhook |

You also need **Node.js 22 or later** — the installer script below handles this for you automatically.

---

## Step 1 — Run the installer

The installer checks your Node.js version, upgrades it if needed, and installs all dependencies. Run the single command for your operating system — you won't need to do anything else.

### macOS

Open **Terminal**, navigate to the project folder, and run:

```bash
bash scripts/install.sh
```

### Linux

Open your terminal, navigate to the project folder, and run:

```bash
bash scripts/install.sh
```

### Windows

Open **PowerShell**, navigate to the project folder, and run:

```powershell
.\scripts\install.ps1
```

> **If you see an "execution policy" error**, run this once first, then retry:
> ```powershell
> Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
> ```

When the installer finishes you'll see:

```
✔  All done! Start the tool with:
   npm start

   Then open:  http://localhost:3000
```

---

## Step 2 — Start the server

```bash
npm start
```

This bundles the GUI and starts the local server. Open your browser and go to:

```
http://localhost:3000
```

---

## Step 3 — Configure your credentials

1. Click **Settings** in the top navigation bar.
2. Fill in your credentials:
   - Figma Personal Access Token
   - Jira base URL, email address, and API token
   - (Optional) Slack or Teams webhook URL
   - (Optional) A shared workspace folder path (e.g. a Box Drive or OneDrive folder your team shares)
3. Click **Save**.

> Your tokens are stored locally at `~/.figma-jira-notifier/secrets.json` and are never written to the shared workspace folder or committed to source control.

---

## Step 4 — Add your first project

1. Click **+ Add project**.
2. Paste your **Figma file URL** — the file key and name are extracted automatically.
   - Example: `https://www.figma.com/design/AbC123XyZ/Product-Design`
3. Paste your **Jira ticket key or URL** — e.g. `PROJ-123`.
4. (Optional) Search for team members to @mention in notifications.
5. (Optional) Configure noise filtering to exclude pages or frames:
   - Pages: `Archive`, `WIP*`
   - Frames: `_annotations`, `DO NOT SHIP*`
6. (Optional) Set a custom cron schedule for this project to override the global one.
7. Click **Save**.

---

## Step 5 — Run your first diff

**On-demand:** Click **Run now** on any project card.

**Automated:** Leave the server running — it will run diffs automatically on the configured cron schedule (default: `0 8 * * *`, i.e. 8 AM daily).

> **First run note:** The first run creates a baseline snapshot of your Figma file. No notifications are sent. The *second* run onwards will detect and report changes.

---

## What happens when a change is detected

- A structured, human-readable comment is posted to the linked **Jira ticket** (if enabled).
- A notification is sent to **Slack** and/or **Teams** (if webhooks are configured).
- A confirmation comment is posted back on the changed **Figma screens** (if `postFigmaComment` is enabled).
- Standalone **Markdown** and/or **HTML** changelog files are exported (if `exportFormat` is configured).

Change types are surfaced with clear emoji indicators:

| Emoji | Change type |
|---|---|
| ✏️ | Copy / text |
| 🎨 | Colour or token |
| ➕ | Node added |
| ➖ | Node removed |
| 🔄 | Renamed |
| 👁️ | Visibility toggled |

---

## Optional: Build a standalone binary

If you want to run the tool without Node.js installed on another machine:

```bash
npm run build
```

Compiled executables for macOS, Windows, and Linux will be output to the `dist/` folder.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `npm start` fails immediately | Re-run the installer script — it will check and fix your Node version automatically |
| Browser shows "cannot connect" | The server may still be bundling — wait a few seconds and refresh |
| Port 3000 already in use | Kill the process on that port, or update the port in `src/server.js` |
| Figma API returns 403 | Your token doesn't have read access to that file — regenerate with correct scope |
| Jira returns 401 | Use an **API token** (not your Atlassian password), paired with your account email |
| No changes reported after editing Figma | The first run sets the baseline — edits made *after* that run will be detected on the next run |
| Shared workspace conflicts | Each project's files are isolated (`projects/`, `runs/`, `snapshots/`) — conflicts only occur if two users run simultaneously |
