import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const outDir = '/tmp/agent-browser';
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1000, height: 1400 });

const problems = [];
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

const url = 'file://' + ROOT + '/build/book.html';
await page.goto(url, { waitUntil: 'networkidle0', timeout: 180000 });
await page.waitForFunction('window.__PAGED_DONE__ === true', { timeout: 300000 });
await page.evaluate(() => document.fonts.ready);

const pageCount = await page.evaluate(() => document.querySelectorAll('.pagedjs_page').length);
console.log('Paged pages:', pageCount);
console.log('Problems:', JSON.stringify(problems, null, 2));

// Screenshot specific pages by index: cover, toc, a chapter page, a page with a chart
const pages = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.pagedjs_page')).map((p, i) => {
    const hasSvgChart = p.querySelectorAll('svg').length > 0 && p.querySelector('.chart, [class*="chart"]') != null;
    const hasAnySvg = p.querySelectorAll('svg').length;
    const text = p.innerText.slice(0, 60).replace(/\n/g, ' ');
    return { i, hasAnySvg, hasSvgChart, text };
  }),
);
fs.writeFileSync(path.join(outDir, 'pages-index.json'), JSON.stringify(pages, null, 2));

async function screenshotPage(index, name) {
  const el = (await page.$$('.pagedjs_page'))[index];
  if (!el) return console.log('missing page', index);
  await el.screenshot({ path: path.join(outDir, name) });
}

await screenshotPage(0, 'page-00-cover.png');
await screenshotPage(1, 'page-01-colophon.png');
await screenshotPage(2, 'page-02-toc.png');

// find first page with a real chart (multiple svgs beyond ornaments, likely bar/line chart classes)
console.log('candidate chart pages:', pages.filter((p) => p.hasAnySvg > 0).map((p) => p.i).slice(0, 20));

const realChartPages = await page.evaluate(() =>
  Array.from(document.querySelectorAll('.pagedjs_page'))
    .map((p, i) => ({ i, hasChart: p.querySelector('.chart-bar, .chart-donut') != null }))
    .filter((p) => p.hasChart)
    .map((p) => p.i),
);
console.log('real chart pages:', realChartPages);
for (const idx of realChartPages) {
  await screenshotPage(idx, `real-chart-${String(idx).padStart(2, '0')}.png`);
}

await browser.close();
