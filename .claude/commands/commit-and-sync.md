Automatically stage, commit with a generated description, and push all current changes.

## Step 1 — Gather context

Run these three commands in parallel:
- `git status` — see what files are modified, staged, or untracked
- `git diff HEAD` — see the full diff of all changes
- `git log --oneline -8` — see recent commit messages to match the project's style

## Step 2 — Stage changes

Stage all tracked modified files. Use specific file names from git status rather than `git add -A` or `git add .` to avoid accidentally including untracked files like `.env`, secrets, or large binaries.

If there are untracked files that look like intentional new source files (`.js`, `.html`, `.css`, `.ts`, `.md`, `.sql`), stage those too — but skip anything that looks like environment config, credentials, or generated output.

## Step 3 — Write the commit message

Analyze the diff and write a commit message that:
- Opens with a short imperative subject line (under 60 characters)
- Follows with a blank line, then a bullet-point body that describes **what changed and why** — not just file names
- Groups related changes into logical bullets (e.g., "Fix calendar not refreshing after PTO decisions" rather than "edit pto.js")
- Matches the tone and style of the recent commits from Step 1
- Ends with the Co-Authored-By trailer:
  `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

Use a HEREDOC to pass the message so newlines and special characters are preserved correctly.

## Step 4 — Commit

Run the commit. If a pre-commit hook fails, read the error, fix the underlying issue, re-stage, and retry — do NOT use `--no-verify`.

## Step 5 — Push

Run `git push` to sync to the remote. If the branch has no upstream yet, run `git push -u origin HEAD` to set it.

## Step 6 — Report

Output a short summary:
- The commit hash and subject line
- Which files were included
- Confirmation that the push succeeded (or any error that needs attention)
