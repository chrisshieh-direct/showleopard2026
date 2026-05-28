const fs = require('node:fs/promises');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const outputPath = path.join(rootDir, 'public', 'index.html');

loadEnvFile(path.join(rootDir, '.env'));
loadEnvFile(path.join(rootDir, '.env.local'));

const config = {
  datalinkUrl: process.env.RED61_DATALINK_URL,
  user: process.env.RED61_USER,
  password: process.env.RED61_PASSWORD,
  showCapacity: Number.parseInt(process.env.SHOW_CAPACITY || '87', 10),
};

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  validateConfig(config);

  const response = await fetch(config.datalinkUrl, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.user}:${config.password}`).toString('base64')}`,
      'User-Agent': 'showleopard-red61-report/0.1',
    },
  });

  if (!response.ok) {
    throw new Error(`Red61 request failed: ${response.status} ${response.statusText}`);
  }

  const sourceHtml = await response.text();
  const table = parseFirstHtmlTable(sourceHtml);
  const report = buildReport(table, config);
  const html = renderPage(report);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, html, 'utf8');

  console.log(`Wrote ${path.relative(rootDir, outputPath)}`);
  console.log(`Rows: ${report.rawRows.length}`);
  if (report.hasPerformanceData) {
    console.log(`Performances: ${report.performances.length}`);
    console.log(`Total sold: ${report.totalSold}`);
  }
}

function validateConfig(settings) {
  const missing = [];
  if (!settings.datalinkUrl) missing.push('RED61_DATALINK_URL');
  if (!settings.user) missing.push('RED61_USER');
  if (!settings.password) missing.push('RED61_PASSWORD');
  if (missing.length) {
    throw new Error(`Missing required environment values: ${missing.join(', ')}`);
  }
}

function loadEnvFile(filePath) {
  let contents;
  try {
    contents = require('node:fs').readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue.trim());
  }
}

function unquoteEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFirstHtmlTable(html) {
  const tableHtml = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] || html;
  const rowMatches = tableHtml.match(/<tr\b[\s\S]*?<\/tr>/gi) || [];
  const rows = rowMatches
    .map((rowHtml) => {
      const cellMatches = rowHtml.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || [];
      return cellMatches.map(cleanCellHtml);
    })
    .filter((row) => row.some(Boolean));

  if (!rows.length) {
    throw new Error('No table rows found in Red61 response.');
  }

  const headers = rows[0].map((header, index) => header || `Column ${index + 1}`);
  const rawRows = rows.slice(1);

  return { headers, rawRows };
}

function cleanCellHtml(cellHtml) {
  return decodeHtmlEntities(
    cellHtml
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function decodeHtmlEntities(value) {
  const named = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  };

  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, body) => {
    const lower = body.toLowerCase();
    if (named[lower]) return named[lower];
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
    return entity;
  });
}

function buildReport(table, settings) {
  const headers = table.headers;
  const normalizedHeaders = headers.map(normalizeHeader);
  const dateIndex = findColumn(normalizedHeaders, [
    'perf_date',
    'performance_date',
    'performance date',
    'perf date',
    'event_date',
    'show_date',
    'date',
  ], 6);
  const soldIndex = findColumn(normalizedHeaders, [
    'sold_count_incl_ca',
    'sold count incl ca',
    'sold_count',
    'sold count',
    'tickets_sold',
    'tickets sold',
    'sold',
  ], 14);
  const performanceIndex = findColumn(normalizedHeaders, [
    'performance',
    'performance_id',
    'perf_id',
    'show_id',
  ], -1);
  const eventTitleIndex = findColumn(normalizedHeaders, [
    'event_title',
    'event title',
    'show_title',
    'title',
  ], -1);

  const grouped = new Map();

  table.rawRows.forEach((row, index) => {
    const dateRaw = row[dateIndex] || '';
    const soldRaw = row[soldIndex] || '';
    const performanceId = performanceIndex >= 0 ? row[performanceIndex] : '';
    const date = parseReportDate(dateRaw);
    const sold = parseNumber(soldRaw);
    const key = performanceId || dateRaw || `row-${index}`;

    if (!grouped.has(key)) {
      grouped.set(key, {
        index,
        key,
        performanceId,
        eventTitle: eventTitleIndex >= 0 ? row[eventTitleIndex] : '',
        date,
        dateRaw,
        timeRaw: extractReportTime(dateRaw),
        sold: 0,
        soldRaw: '',
        remaining: null,
        priceRows: 0,
        rows: [],
      });
    }

    const performance = grouped.get(key);
    performance.priceRows += 1;
    performance.rows.push(row);
    if (Number.isFinite(sold)) {
      performance.sold += sold;
    }
    performance.soldRaw = String(performance.sold);
  });

  const capacity = Number.isFinite(settings.showCapacity) ? settings.showCapacity : null;
  const performances = Array.from(grouped.values())
    .map((performance) => {
      return {
        ...performance,
        remaining: capacity === null ? null : capacity - performance.sold,
      };
    })
    .filter((performance) => performance.date || Number.isFinite(performance.sold))
    .sort((a, b) => {
      if (a.date && b.date) return a.date.getTime() - b.date.getTime();
      if (a.date) return -1;
      if (b.date) return 1;
      return a.index - b.index;
    });

  const hasPerformanceData = performances.length > 0 && dateIndex >= 0 && soldIndex >= 0;
  const totalSold = performances.reduce((total, performance) => {
    return total + (Number.isFinite(performance.sold) ? performance.sold : 0);
  }, 0);
  const totalCapacity = hasPerformanceData && Number.isFinite(settings.showCapacity)
    ? performances.length * settings.showCapacity
    : null;

  return {
    generatedAt: new Date(),
    headers,
    rawRows: table.rawRows,
    dateColumnName: headers[dateIndex] || null,
    soldColumnName: headers[soldIndex] || null,
    performanceColumnName: headers[performanceIndex] || null,
    hasPerformanceData,
    performances,
    totalSold,
    totalCapacity,
    showCapacity: settings.showCapacity,
  };
}

function normalizeHeader(header) {
  return header
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9_ ]/g, '')
    .trim();
}

function findColumn(headers, candidates, fallbackIndex) {
  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeader(candidate);
    const exactIndex = headers.indexOf(normalizedCandidate);
    if (exactIndex !== -1) return exactIndex;
  }

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeHeader(candidate).replace(/_/g, ' ');
    const fuzzyIndex = headers.findIndex((header) => {
      const spaced = header.replace(/_/g, ' ');
      return spaced === normalizedCandidate || spaced.includes(normalizedCandidate);
    });
    if (fuzzyIndex !== -1) return fuzzyIndex;
  }

  return fallbackIndex;
}

function parseReportDate(value) {
  if (!value) return null;
  const trimmed = value.trim();
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    return new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  }

  const uk = trimmed.match(/^(\d{1,2})[/. -](\d{1,2})[/. -](\d{2,4})/);
  if (uk) {
    const year = Number(uk[3].length === 2 ? `20${uk[3]}` : uk[3]);
    return new Date(year, Number(uk[2]) - 1, Number(uk[1]));
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function extractReportTime(value) {
  const match = String(value || '').match(/\b(\d{1,2}):(\d{2})/);
  if (!match) return '';
  return `${match[1].padStart(2, '0')}:${match[2]}`;
}

function parseNumber(value) {
  const cleaned = String(value || '').replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!cleaned) return Number.NaN;
  return Number(cleaned[0]);
}

function renderPage(report) {
  const refreshed = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(report.generatedAt);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Chris Grace Ticket Sales</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f4f7f8;
        --ink: #1d1d1f;
        --muted: #5f6670;
        --line: #d5dde3;
        --panel: #ffffff;
        --accent: #0f766e;
        --accent-soft: #dcefeb;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        line-height: 1.45;
      }

      main {
        width: min(1120px, calc(100% - 32px));
        margin: 0 auto;
        padding: 40px 0 56px;
      }

      header {
        display: flex;
        align-items: end;
        justify-content: space-between;
        gap: 24px;
        margin-bottom: 28px;
      }

      h1,
      h2 {
        margin: 0;
        line-height: 1;
      }

      h1 {
        font-size: clamp(2rem, 4vw, 3.25rem);
      }

      h2 {
        margin-top: 34px;
        font-size: 1.4rem;
      }

      p {
        margin: 0;
      }

      .muted {
        color: var(--muted);
      }

      .stats {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 30px;
      }

      .next-performances {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
        margin-bottom: 34px;
      }

      .stat {
        min-height: 112px;
        padding: 18px;
        border: 1px solid var(--line);
        background: var(--panel);
      }

      .stat strong {
        display: block;
        margin-top: 8px;
        font-size: clamp(2rem, 4vw, 3rem);
        line-height: 1;
      }

      .accent {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .next-card {
        min-height: 108px;
        padding: 18px;
        border: 1px solid var(--line);
        background: var(--panel);
      }

      .next-card strong {
        display: block;
        margin-top: 8px;
        font-size: 1.55rem;
        line-height: 1.15;
      }

      .table-wrap {
        overflow-x: auto;
        margin-top: 14px;
        border: 1px solid var(--line);
        background: var(--panel);
      }

      table {
        width: 100%;
        min-width: 680px;
        border-collapse: collapse;
      }

      th,
      td {
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
      }

      th {
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0;
        text-transform: uppercase;
      }

      tbody tr:last-child td {
        border-bottom: 0;
      }

      .number {
        text-align: right;
        font-variant-numeric: tabular-nums;
      }

      details {
        margin-top: 34px;
      }

      summary {
        cursor: pointer;
        font-size: 1.4rem;
        font-weight: 700;
        line-height: 1;
      }

      @media (max-width: 760px) {
        main {
          width: min(100% - 20px, 1120px);
          padding-top: 24px;
        }

        header {
          display: block;
        }

        header p {
          margin-top: 10px;
        }

        .stats {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }

        .next-performances {
          grid-template-columns: 1fr;
        }

        .performance-wrap {
          overflow-x: visible;
          border: 0;
          background: transparent;
        }

        .performance-table {
          min-width: 0;
        }

        .performance-table thead {
          display: none;
        }

        .performance-table,
        .performance-table tbody,
        .performance-table tr,
        .performance-table td {
          display: block;
          width: 100%;
        }

        .performance-table tr {
          margin-bottom: 10px;
          padding: 12px 14px;
          border: 1px solid var(--line);
          background: var(--panel);
        }

        .performance-table td {
          display: flex;
          justify-content: space-between;
          gap: 16px;
          padding: 6px 0;
          border-bottom: 0;
          text-align: right;
        }

        .performance-table td::before {
          content: attr(data-label);
          flex: 0 0 auto;
          color: var(--muted);
          font-size: 0.78rem;
          font-weight: 700;
          text-align: left;
          text-transform: uppercase;
        }
      }

      @media (max-width: 460px) {
        .stats {
          grid-template-columns: 1fr;
        }

        h1 {
          font-size: 2rem;
        }

        .stat {
          min-height: 96px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <header>
        <div>
          <h1>Chris Grace Ticket Sales</h1>
          <p class="muted">Red61 report refreshed ${escapeHtml(refreshed)}</p>
        </div>
      </header>
      ${report.hasPerformanceData ? renderStats(report) : renderFallbackNotice(report)}
      ${report.hasPerformanceData ? renderNextPerformances(report) : ''}
      ${report.hasPerformanceData ? renderPerformanceTable(report) : ''}
    </main>
  </body>
</html>
`;
}

function renderStats(report) {
  const remaining = report.totalCapacity === null ? null : report.totalCapacity - report.totalSold;
  const percentage = report.totalCapacity ? `${((report.totalSold / report.totalCapacity) * 100).toFixed(1)}%` : 'n/a';

  return `<section class="stats" aria-label="Ticket sales summary">
        <div class="stat accent">
          <p class="muted">Tickets sold</p>
          <strong>${formatNumber(report.totalSold)}</strong>
        </div>
        <div class="stat">
          <p class="muted">Remaining</p>
          <strong>${remaining === null ? 'n/a' : formatNumber(remaining)}</strong>
        </div>
        <div class="stat">
          <p class="muted">Capacity sold</p>
          <strong>${percentage}</strong>
        </div>
        <div class="stat">
          <p class="muted">Performances</p>
          <strong>${formatNumber(report.performances.length)}</strong>
        </div>
      </section>`;
}

function renderNextPerformances(report) {
  const today = londonStartOfToday();
  const nextPerformances = report.performances
    .filter((performance) => performance.date && performance.date >= today)
    .slice(0, 3);

  const cards = nextPerformances.map((performance) => {
    const sold = Number.isFinite(performance.sold) ? formatNumber(performance.sold) : performance.soldRaw;
    return `<div class="next-card">
          <p class="muted">${escapeHtml(formatDate(performance.date, performance.dateRaw))}</p>
          <strong>${escapeHtml(sold)} sold</strong>
        </div>`;
  }).join('\n');

  return `<section class="next-performances" aria-label="Next three performances">
        ${cards}
      </section>`;
}

function londonStartOfToday() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'numeric',
    timeZone: 'Europe/London',
    year: 'numeric',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, Number(part.value)]));
  return new Date(values.year, values.month - 1, values.day);
}

function renderFallbackNotice(report) {
  return `<section class="stat">
        <p class="muted">The report was fetched, but the generator could not confidently identify the performance date and tickets-sold columns. Showing the raw Red61 table below.</p>
        <p class="muted">Rows found: ${formatNumber(report.rawRows.length)}</p>
      </section>`;
}

function renderPerformanceTable(report) {
  const rows = report.performances.map((performance) => {
    return `<tr>
          <td data-label="Date">${escapeHtml(formatDate(performance.date, performance.dateRaw, performance.timeRaw))}</td>
          <td class="number" data-label="Tickets Sold">${formatMaybeNumber(performance.sold, performance.soldRaw)}</td>
          <td class="number" data-label="Remaining">${performance.remaining === null ? 'n/a' : formatNumber(performance.remaining)}</td>
        </tr>`;
  }).join('\n');

  return `<section>
        <h2>By Performance</h2>
        <div class="table-wrap performance-wrap">
          <table class="performance-table">
            <thead>
              <tr>
                <th>Date</th>
                <th class="number">Tickets Sold</th>
                <th class="number">Remaining</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </section>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-GB').format(value);
}

function formatMaybeNumber(value, fallback) {
  if (!Number.isFinite(value)) return escapeHtml(fallback || '');
  return formatNumber(value);
}

function formatDate(date, fallback) {
  if (!date) return fallback || '';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: 'Europe/London',
  }).format(date);
}
