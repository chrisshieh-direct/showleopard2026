# Show Leopard Red61 Report

This project fetches a Red61 datalink report and writes a static HTML dashboard to `public/index.html`.

## Setup

Create a local `.env` file from `.env.example` and fill in the Red61 datalink URL, username, and password.

```sh
cp .env.example .env
npm run refresh
npm run serve
```

Then open `http://localhost:8000`.

Only the generated HTML needs to be uploaded to a static webhost. To update it, run `npm run refresh` again and upload the new `public/index.html`.

## Cached Server

For a VPS such as Hetzner, run the tiny built-in Node server:

```sh
npm start
```

It serves `public/index.html`, checks whether that cached file is older than `RED61_CACHE_TTL_HOURS`, and refreshes it from Red61 only when needed. The default is once every 24 hours.

## GitHub Scheduled Publish

The workflow in `.github/workflows/publish.yml` can refresh the report once a day and upload the static `index.html` to DreamHost over SSH/SCP.

Add these repository secrets in GitHub:

- `RED61_DATALINK_URL`
- `RED61_USER`
- `RED61_PASSWORD`
- `DREAMHOST_HOST`
- `DREAMHOST_USER`
- `DREAMHOST_SSH_KEY`
- `DREAMHOST_TARGET_DIR`

Optional repository variable:

- `SHOW_CAPACITY`, defaults to `87`

The schedule currently runs daily at 08:15 UTC. You can also run it manually from the Actions tab with "Run workflow".
# showleopard2026
