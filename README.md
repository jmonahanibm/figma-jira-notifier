# Design Change Log (v2)

Monitors Figma design files for changes and automatically posts structured, human-readable changelogs to linked Jira tickets, Slack channels, and Microsoft Teams webhooks — @mentioning your frontend development team with direct deep-links to changed nodes.

---

## Key Features

- **Human-Readable Change Notifications:** Plain-English change summaries with clear emoji indicators (✏️ copy, 🎨 colour/tokens, ➕ added, ➖ removed, 🔄 renamed, 👁️ visibility) and single-sentence executive summaries.
- **Node-Level Deep Links:** Direct links to changed elements in Figma (desktop app `figma://` or browser `https://`).
- **Multi-Channel Delivery:** Post notifications to Jira (ADF comments), Slack incoming webhooks, and Microsoft Teams incoming webhooks.
- **Shared Team Workspace (Multi-User Cloud Sync):** Point the tool to a shared folder (SharePoint, OneDrive, Box Drive) to share project definitions, baseline snapshots, run histories, and exports across your team.
- **Local Secrets Storage:** Personal API tokens (Figma token, Jira token, webhooks) are saved locally on each user's machine (`~/.figma-jira-notifier/secrets.json`) and never committed to shared drives.
- **Per-Project File Isolation:** Project definitions (`projects/<id>.json`), run logs (`runs/<id>.runs.json`), and snapshots (`snapshots/<key>.json`) are isolated to eliminate concurrent sync conflicts.
- **Snapshot History & Rollback:** Rolling archive of past baselines with instant one-click rollback in the GUI.
- **Noise Filtering (Diff Exclusions):** Glob-pattern filtering for pages (e.g. `Archive`, `WIP*`) and frames (e.g. `_annotations`).
- **Standalone Changelog Exports:** Generates self-contained Markdown (`.md`) and HTML (`.html`) changelog documents for documentation or offline distribution.
- **Per-Project Custom Schedules:** Override global cron cadences per project (e.g. daily for active designs, weekly for design systems).
- **Figma Comment Post-Back:** Posts a consolidated confirmation comment back onto changed Figma screens with a direct link to the Jira ticket.
- **Unified GUI:** Run locally via `npm start` (or native binary) or as a static preview tool.

---

## Quick Start

### 1. Run Locally

```bash
# Install dependencies
npm install

# Start the server and launch GUI at http://localhost:3000
npm start
```

### 2. Configure Global Settings

Click **Settings** in the top navigation bar to configure:
- **Shared Workspace Folder:** (Optional) Set a local or cloud-synced directory (e.g. `C:\Users\username\Box\DesignChangelog`).
- **Figma Personal Access Token:** Your Figma token with read access.
- **Jira Credentials:** Base URL (e.g. `https://your-org.atlassian.net`), email, and Jira API token.
- **Notification Channels:** Enable Jira comments, Slack incoming webhook URL, and/or Teams incoming webhook URL.

### 3. Add a Monitored Project

Click **+ Add project**:
- Paste your **Figma File URL** (the file key and name are auto-extracted).
- Paste your **Jira ticket URL or key** (e.g. `PROJ-123`).
- (Optional) Fetch watchers from Jira or search team members by name to @mention.
- (Optional) Set custom noise filtering (page/frame exclusions) or a custom cron schedule.

### 4. Run Diffs

- **Automated:** Runs in the background on the configured cron schedule.
- **On-Demand:** Click **Run now** to diff all projects immediately, or run an individual project card.

---

## Configuration Schema

Example `config.json` (shared configuration):

```json
{
  "schedule": "0 8 * * *",
  "maxNodesInNotification": 50,
  "deepLinkTarget": "both",
  "snapshotRetention": 7,
  "channels": {
    "jira": true,
    "slackWebhookUrl": "",
    "teamsWebhookUrl": ""
  },
  "projects": [
    {
      "id": "project-uuid",
      "figmaFileKey": "AbC123XyZ",
      "figmaUrl": "https://www.figma.com/design/AbC123XyZ/Product-Design",
      "figmaFileName": "Product Design",
      "jiraIssueKey": "PROJ-123",
      "schedule": "0 9 * * 1",
      "syncComments": true,
      "postFigmaComment": true,
      "exportFormat": "both",
      "exclusions": {
        "pages": ["Archive", "WIP*"],
        "frames": ["_annotations"]
      },
      "mentionedUsers": [
        {
          "displayName": "Alice Dev",
          "jiraAccountId": "5b10ac8d82e05b22cc7d4ef5",
          "email": "alice@example.com"
        }
      ]
    }
  ]
}
```

---

## Building Native Binaries

Build self-contained executables for macOS, Windows, and Linux:

```bash
npm run build
```

Compiled binaries will be output to the `dist/` directory.

---

## Running Tests

Run the comprehensive Jest test suite:

```bash
npm test
```
