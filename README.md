# Chris Grace Red61 Report

This project fetches a Red61 datalink report and writes a static HTML dashboard to `public/index.html`.

## Best Setup: GitHub to DreamHost

For DreamHost static hosting, do not use `.env`. Put the credentials in GitHub Actions secrets instead.

The workflow in `.github/workflows/publish.yml` refreshes the report and uploads the static `index.html` to DreamHost over SSH/SCP.

In the GitHub repo, go to:

`Settings` -> `Secrets and variables` -> `Actions` -> `Secrets` -> `New repository secret`

Add these repository secrets:

- `RED61_DATALINK_URL`
- `RED61_USER`
- `RED61_PASSWORD`
- `DREAMHOST_HOST`
- `DREAMHOST_USER`
- `DREAMHOST_SSH_KEY`
- `DREAMHOST_TARGET_DIR`

Optional repository variable:

- `SHOW_CAPACITY`, defaults to `87`

Run it manually from the Actions tab with "Run workflow", or trigger it from DreamHost cron using GitHub's `workflow_dispatch` API.

## Local Preview

Use `.env` only when running the report from this computer.

```sh
cp .env.example .env
npm run refresh
npm run serve
```

Then open `http://localhost:8000`.

If you want to upload manually, upload only `public/index.html` to DreamHost.

## Cached Server

For a VPS such as Hetzner, run the tiny built-in Node server:

```sh
npm start
```

It serves `public/index.html`, checks whether that cached file is older than `RED61_CACHE_TTL_HOURS`, and refreshes it from Red61 only when needed. The default is once every 24 hours.
