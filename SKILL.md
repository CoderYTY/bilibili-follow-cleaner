---
name: bilibili-follow-cleaner
description: Safely audit and clean stale Bilibili following lists by comparing followed accounts with recent watch history. Use when a user asks to scan Bilibili follows, find creators they have not watched for a long time, generate a candidate list, batch unfollow stale accounts, resume after Bilibili rate limits, or export cleanup reports. Requires the user to log in manually and requires explicit confirmation before unfollowing.
---

# Bilibili Follow Cleaner

Use this skill to help a user clean a Bilibili following list without handling their password. The bundled script connects to a browser session that the user has opened and logged into, scans followings plus recent watch history, produces candidate reports, then can batch-unfollow confirmed targets with pauses and resume support.

## Safety Rules

- Never ask for, type, store, or transmit the user's Bilibili password, OTP, QR login token, or cookies.
- Let the user complete login manually in the browser.
- Treat scan outputs as private account data. Do not upload `bilibili-*.json`, `bilibili-*.csv`, or `bilibili-*.md` unless the user explicitly asks.
- Before any `unfollow` or `retry-failed` run, show the candidate count and ask for explicit confirmation because it changes the user's account relationships.
- If Bilibili returns repeated `-352` responses or request errors, stop and report progress rather than repeatedly retrying.

## Setup

Use `scripts/bilibili_follow_cleaner.mjs`.

The script requires Playwright and a Chromium browser exposed through CDP. Prefer the user's existing Codex workspace Node runtime when available:

```powershell
$env:NODE_PATH="<path-to-node_modules-containing-playwright>"
$env:BILI_CDP_PORT="9227"
$env:BILI_DATA_DIR="<private-output-directory>"
node scripts/bilibili_follow_cleaner.mjs scan 180
```

If no controlled browser is already available, ask before launching a visible browser window. Use a temporary profile so the user's normal browser profile is not modified:

```powershell
$profile="<private-output-directory>\bili-chrome-profile"
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Start-Process -FilePath "C:\Program Files\Google\Chrome\Application\chrome.exe" -ArgumentList @("--remote-debugging-port=9227", "--user-data-dir=$profile", "--no-first-run", "--new-window", "https://www.bilibili.com/")
```

After the window opens, ask the user to log in manually and tell you when finished.

## Workflow

1. Scan stale follow candidates:

```powershell
node scripts/bilibili_follow_cleaner.mjs scan 180
node scripts/bilibili_follow_cleaner.mjs report
```

The scan rule is: candidate accounts are followed accounts with no ordinary archive-video watch history within the chosen day window. The default is 180 days.

2. Present the generated report files and summarize totals:

- `bilibili-following-scan.json`
- `bilibili-following-candidates.md`
- `bilibili-following-candidates.csv`

3. Ask for explicit confirmation before unfollowing. Use precise wording such as: "Confirm unfollowing these N candidates from your Bilibili account?"

4. Batch unfollow after confirmation:

```powershell
node scripts/bilibili_follow_cleaner.mjs unfollow
```

5. If rate-limited, retry later using only failed targets. Use pauses between batches:

```powershell
node scripts/bilibili_follow_cleaner.mjs retry-failed 50 60000
node scripts/bilibili_follow_cleaner.mjs remaining-report
```

If the user manually unfollowed one or more failed accounts, pass their UIDs as a comma-separated skip list:

```powershell
node scripts/bilibili_follow_cleaner.mjs retry-failed 50 60000 123456,987654
node scripts/bilibili_follow_cleaner.mjs remaining-report 123456,987654
```

## Outputs

Generated data files are intended to stay local:

- `bilibili-following-scan.json`: full scan result with account, follows, candidates, and kept accounts.
- `bilibili-following-candidates.md` and `.csv`: user-readable candidate lists.
- `bilibili-unfollow-result.json`: first unfollow run.
- `bilibili-unfollow-retry-result.json`: cumulative retry results.
- `bilibili-unfollow-remaining.md` and `.csv`: remaining failed targets after retries.

## Notes

- Bilibili may allow roughly a limited number of unfollow operations before returning `-352`. Stop after repeated `-352` and resume later.
- The script uses the Bilibili web APIs from the logged-in browser context. It does not store credentials.
- Keep generated outputs out of public repositories.
