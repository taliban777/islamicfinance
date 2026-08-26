/**
 * build-ebook.mjs
 *
 * Typesets ebook/islamicfinance-guide.md into a print-ready PDF.
 *
 *   markdown  ->  semantic HTML (marked)
 *             ->  styled book templates + inline SVG charts
 *             ->  paginated pages (Paged.js, running heads, real TOC)
 *             ->  PDF at 152mm x 229mm trim (Puppeteer)
 *
 * The chapter prose is never rewritten. This script is presentation only.
 *
 * Flags:
 *   --html-only   stop after writing build/book.html (fast styling loop)
 */

import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { marked } from "marked"
import puppeteer from "puppeteer"

import { splitSource, buildStats, parseDeposit, parseFinanceRange } from "./extract-data.mjs"
import { chapterMark, sectionDivider, terminalMark, calloutRule } from "./ornaments.mjs"
import { donutChart, barChart, escapeHtml, formatMoney } from "./charts.mjs"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const BUILD_DIR = path.join(ROOT, "build")
const OUT_DIR = path.join(ROOT, "output")
const PDF_PATH = path.join(OUT_DIR, "islamic-home-finance-guide.pdf")
const HTML_PATH = path.join(BUILD_DIR, "book.html")

const TRIM = { width: "152mm", height: "229mm" }

marked.setOptions({ gfm: true, breaks: false, mangle: false, headerIds: false })

/* ================================================================== */
/* Fonts                                                              */
/* ================================================================== */

const FONT_FILES = [
  ["Fraunces", 500, "normal", "@fontsource/fraunces/files/fraunces-latin-500-normal.woff2"],
  ["Fraunces", 600, "normal", "@fontsource/fraunces/files/fraunces-latin-600-normal.woff2"],
  ["Source Serif 4", 400, "normal", "@fontsource/source-serif-4/files/source-serif-4-latin-400-normal.woff2"],
  ["Source Serif 4", 400, "italic", "@fontsource/source-serif-4/files/source-serif-4-latin-400-italic.woff2"],
  ["Source Serif 4", 600, "normal", "@fontsource/source-serif-4/files/source-serif-4-latin-600-normal.woff2"],
  ["Source Serif 4", 600, "italic", "@fontsource/source-serif-4/files/source-serif-4-latin-600-italic.woff2"],
]

/**
 * Fonts are embedded as data URIs so PDF rendering never depends on
 * network access or on a font being installed in the container.
 */
async function buildFontFaces() {
  const modulesDir = path.resolve(ROOT, "node_modules")
  const faces = []
  for (const [family, weight, style, relative] of FONT_FILES) {
    const buffer = await readFile(path.join(modulesDir, relative))
    faces.push(`@font-face {
  font-family: "${family}";
  font-style: ${style};
  font-weight: ${weight};
  font-display: block;
  src: url(data:font/woff2;base64,${buffer.toString("base64")}) format("woff2");
}`)
  }
  return faces.join("\n")
}

/* ================================================================== */
/* Markdown helpers                                                   */
/* ================================================================== */

const FRONT_SECTION_SKIP = /^Key writing rules/i

/**
 * The prose was drafted against an earlier cut of the dataset and quotes a
 * savings-product count that the appendix no longer matches. The appendix is
 * authoritative, so the count is realigned here rather than leaving the book
 * contradicting its own data. Prose is otherwise never rewritten.
 */
function reconcileCounts(body, stats) {
  const { savingsProductCount } = stats.summary
  return body.replace(/(\b)(\d+)(\s+related savings products\b)/g, (match, before, quoted, after) =>
    Number(quoted) === savingsProductCount ? match : `${before}${savingsProductCount}${after}`,
  )
}

/** Splits the narrative body into chapters keyed by their number. */
function parseChapters(body) {
  const pattern = /^## Chapter (\d+):\s*(.+)$/gm
  const chapters = []
  const matches = [...body.matchAll(pattern)]

  matches.forEach((match, index) => {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : body.length
    chapters.push({
      number: Number.parseInt(match[1], 10),
      title: match[2].trim(),
      raw: body.slice(start, end),
    })
  })

  return chapters
}

/** Splits a chapter body into an optional preamble plus `###` sections. */
function parseSections(raw) {
  const cleaned = raw.replace(/^\s*---\s*$/gm, "\n@@DIVIDER@@\n")
  const pattern = /^### (.+)$/gm
  const matches = [...cleaned.matchAll(pattern)]

  const preamble = (matches.length ? cleaned.slice(0, matches[0].index) : cleaned).trim()
  const sections = matches.map((match, index) => {
    const start = match.index + match[0].length
    const end = index + 1 < matches.length ? matches[index + 1].index : cleaned.length
    return { heading: match[1].trim(), body: cleaned.slice(start, end).trim() }
  })

  return { preamble, sections }
}

/**
 * Upgrades straight typewriter punctuation to real book punctuation.
 * Only runs on text between tags, so attribute values and entities are
 * left untouched.
 */
function typographic(html) {
  return html.replace(/>([^<]+)</g, (match, text) => {
    if (!/["'-]/.test(text)) return match

    const fixed = text
      // Em dash from "--", en dash for numeric ranges spelled with a hyphen.
      .replace(/--/g, "\u2014")
      .replace(/(\d)\s?-\s?(\d)/g, "$1\u2013$2")
      // Apostrophes: contractions, possessives, and decades such as '90s.
      .replace(/(\w)'(\w)/g, "$1\u2019$2")
      .replace(/(\w)'(?=\s|$|[.,;:!?)])/g, "$1\u2019")
      .replace(/'(?=\d\d\b)/g, "\u2019")
      // Double quotes: opening if preceded by start/space/opening punctuation.
      .replace(/(^|[\s([{\u2014\u2013])"/g, "$1\u201c")
      .replace(/"/g, "\u201d")
      // Any remaining single quote opens a quotation.
      .replace(/(^|[\s([{])'/g, "$1\u2018")

    return `>${fixed}<`
  })
}

/** Renders markdown and applies the book's HTML furniture. */
function renderProse(markdown, { firstParagraphIsOpener = false, dividers = true } = {}) {
  if (!markdown) return ""
  let html = marked.parse(markdown)

  html = html
    .replace(
      /<p>\s*@@DIVIDER@@\s*<\/p>/g,
      dividers ? `<div class="divider">${sectionDivider(300)}</div>` : "",
    )
    .replace(/@@DIVIDER@@/g, "")

  html = typographic(html)

  // Bare provider URLs get their own class so they can break mid-string
  // without stretching the measure.
  html = html.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, (match, href, text) =>
    /^https?:/.test(text) ? `<span class="url">${escapeHtml(text)}</span>` : match,
  )

  html = wrapTables(html)
  html = boxDisclaimers(html)

  if (firstParagraphIsOpener) {
    html = html.replace("<p>", '<p class="opening-para">')
  }

  return html
}

/** Wraps every table so it can be kept together and captioned. */
function wrapTables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (match, inner) => {
    const columnCount = (inner.match(/<th>/g) || []).length
    const wide = columnCount >= 7
    return `<div class="table-wrap${wide ? " table-wide" : ""}">
  <table${wide ? ' class="table-dense"' : ""}>${inner}</table>
  <div class="table-caption">As of February 2026</div>
</div>`
  })
}

const DISCLAIMER_TEST =
  /(not regulated financial advice|not financial advice|educational content, not|is educational\. It is not)/i

/** Promotes standalone advice caveats into a bordered callout. */
function boxDisclaimers(html) {
  return html.replace(/<p>([\s\S]*?)<\/p>/g, (match, inner) => {
    if (!DISCLAIMER_TEST.test(inner)) return match
    if (inner.length > 900) return match
    return callout({ variant: "disclaimer", label: "Please note", body: `<p>${inner}</p>` })
  })
}

function callout({ variant, label, body }) {
  return `<aside class="callout ${variant}">
  <div class="callout-head"><span class="mark">${terminalMark(11)}</span>${escapeHtml(label)}</div>
  ${body}
</aside>`
}

/* ================================================================== */
/* Chapter assembly                                                   */
/* ================================================================== */

const TAKEAWAY_HEADING = /^key takeaways$/i

function renderChapter(chapter, figuresForChapter, nextFigureNumber) {
  const { preamble, sections } = parseSections(chapter.raw)
  const id = `ch-${chapter.number}`
  const subheadings = []
  const figures = []

  const parts = []
  parts.push(`<header class="chapter-opener">
  ${chapterMark(54)}
  <div class="chapter-number">Chapter ${chapter.number}</div>
  <h2>${escapeHtml(chapter.title)}</h2>
  <div class="chapter-rule">${calloutRule(190)}</div>
</header>`)

  let openerUsed = false
  if (preamble) {
    parts.push(renderProse(preamble, { firstParagraphIsOpener: true }))
    openerUsed = true
  }

  const isGlossary = /glossary/i.test(chapter.title)

  for (const section of sections) {
    if (TAKEAWAY_HEADING.test(section.heading)) {
      parts.push(
        callout({
          variant: "takeaways",
          label: "Key takeaways",
          body: renderProse(section.body, { dividers: false }),
        }),
      )
      continue
    }

    subheadings.push(section.heading)
    parts.push(`<h3 id="${id}-s${subheadings.length}">${escapeHtml(section.heading)}</h3>`)

    const bodyHtml = isGlossary
      ? renderGlossary(section.body)
      : renderProse(section.body, { firstParagraphIsOpener: !openerUsed })
    openerUsed = true
    parts.push(bodyHtml)

    const pending = figuresForChapter.filter((entry) => entry.after === section.heading)
    for (const entry of pending) {
      const number = nextFigureNumber()
      figures.push({ number, title: entry.title, id: `fig-${number}` })
      parts.push(entry.render(number, `fig-${number}`))
    }
  }

  // Glossary definitions live in the chapter preamble rather than a section.
  const html = isGlossary ? convertGlossaryParagraphs(parts.join("\n")) : parts.join("\n")

  return {
    id,
    number: chapter.number,
    title: chapter.title,
    subheadings,
    figures,
    html: `<section class="chapter" id="${id}">\n${html}\n</section>`,
  }
}

function renderGlossary(markdown) {
  return convertGlossaryParagraphs(renderProse(markdown))
}

/** Turns "**Term.** Definition" paragraphs into a styled definition list. */
function convertGlossaryParagraphs(html) {
  const entryPattern = /<p>\s*<strong>([^<]+?)<\/strong>\s*([\s\S]*?)<\/p>/g
  const items = []
  const withPlaceholders = html.replace(entryPattern, (match, term, rest) => {
    if (!/\.$/.test(term.trim())) return match
    items.push(
      `<li><span class="glossary-term">${escapeHtml(term.trim().replace(/\.$/, ""))}</span>. ${rest.trim()}</li>`,
    )
    return "@@GLOSSARY_ITEM@@"
  })

  if (!items.length) return html

  let index = 0
  let listOpen = false
  const output = []
  for (const chunk of withPlaceholders.split("\n")) {
    if (chunk.trim() === "@@GLOSSARY_ITEM@@") {
      if (!listOpen) {
        output.push('<ul class="glossary-list">')
        listOpen = true
      }
      output.push(items[index])
      index += 1
      continue
    }
    if (listOpen) {
      output.push("</ul>")
      listOpen = false
    }
    output.push(chunk)
  }
  if (listOpen) output.push("</ul>")

  return output.join("\n")
}

/* ================================================================== */
/* Figures                                                            */
/* ================================================================== */

/**
 * Charts are placed contextually, immediately after the section whose
 * argument they support.
 */
function figureSpecs(stats) {
  const c = stats.charts

  return [
    {
      chapter: 5,
      after: "Side by side",
      title: `Contract models across the ${stats.summary.homeProductCount} UK home finance products`,
      render: (number, id) =>
        donutChart({
          id,
          number,
          title: `Contract models across the ${stats.summary.homeProductCount} UK home finance products`,
          note: `Diminishing Musharaka accounts for ${stats.summary.diminishingMusharakaShare} percent of products in the snapshot.`,
          data: c.contractModels,
          centreValue: String(stats.summary.homeProductCount),
          centreLabel: "products",
        }),
    },
    {
      chapter: 7,
      after: "Specialist and higher-value categories",
      title: "Lowest minimum finance size, by provider",
      render: (number, id) =>
        barChart({
          id,
          number,
          title: "Lowest minimum finance size, by provider",
          note: "The smallest amount each provider will finance across any of its products. Often the fastest practical filter.",
          data: c.minFinanceByProvider.map((entry) => ({ label: entry.label, value: entry.value })),
          labelWidth: 128,
          rowHeight: 21,
          valueFormat: formatMoney,
          axisLabel: "Minimum finance",
          highlight: (entry) => entry.value >= 500_000,
        }),
    },
    {
      chapter: 8,
      after: "Start by filtering, not comparing",
      title: "Minimum deposit required, by product",
      render: (number, id) =>
        barChart({
          id,
          number,
          title: "Minimum deposit required, by product",
          note: `${stats.summary.depositStatedCount} of ${stats.summary.homeProductCount} products state a minimum deposit. A dagger marks a figure carrying conditions in the source data. Median for owner-occupier products is ${stats.summary.medianResidentialDeposit} percent.`,
          data: c.depositByProduct.map((entry) => ({
            label: entry.provider,
            sublabel: entry.product,
            value: entry.value,
            flag: entry.caveat ? " †" : "",
          })),
          labelWidth: 132,
          rowHeight: 21,
          valueFormat: (value) => `${Math.round(value)}%`,
          axisLabel: "Minimum deposit as a share of property price",
          pageBreak: true,
          highlight: (entry) => entry.value <= 10,
        }),
    },
    {
      chapter: 9,
      after: "Transparency category, explained",
      title: "Transparency category across home finance products",
      render: (number, id) =>
        barChart({
          id,
          number,
          title: "Transparency category across home finance products",
          note: `Transparency reflects how much a provider publishes about governance and pricing, not religious legitimacy. ${stats.summary.highTransparencyShare} percent of products sit at High.`,
          data: c.transparencyHome,
          labelWidth: 82,
          rowHeight: 24,
          axisTicks: 4,
          valueFormat: (value) => String(Math.round(value)),
          axisLabel: "Number of products",
          colorFor: (entry) =>
            entry.label === "High" ? "#0B3D2E" : entry.label === "Medium" ? "#4B8A6C" : "#B8860B",
        }),
    },
    {
      chapter: 10,
      after: "Notice accounts and limited access: a middle ground",
      title: "Halal savings products by liquidity category",
      render: (number, id) =>
        barChart({
          id,
          number,
          title: "Halal savings products by liquidity category",
          note: `All ${stats.summary.savingsProductCount} savings products in the snapshot, grouped by how quickly you can reach the money.`,
          data: c.savingsByLiquidity,
          labelWidth: 96,
          rowHeight: 23,
          axisTicks: 5,
          valueFormat: (value) => String(Math.round(value)),
          axisLabel: "Number of products",
        }),
    },
    {
      chapter: 10,
      after: "A word on FSCS protection",
      title: `FSCS protection across the ${stats.summary.savingsProductCount} savings products`,
      render: (number, id) =>
        donutChart({
          id,
          number,
          title: `FSCS protection across the ${stats.summary.savingsProductCount} savings products`,
          note: "Deposit-based bank products are generally covered. Investment, gold, property, and IF-ISA style products generally are not.",
          data: c.fscs,
          centreValue: String(stats.summary.savingsProductCount),
          centreLabel: "products",
        }),
    },
  ]
}

/* ================================================================== */
/* Front matter                                                       */
/* ================================================================== */

function colophonPage(stats) {
  return `<section class="colophon">
  <h2>About this edition</h2>
  <p>
    Typeset from a single source manuscript. Every provider, product, deposit requirement,
    finance range, term, and transparency rating in this book is drawn from a dated snapshot of
    <em>${escapeHtml(stats.sourceFile)}</em>, extracted on ${escapeHtml(stats.extractionDate)}. No rates,
    products, or providers have been added beyond that dataset. Where the data is silent, the text
    says so directly rather than estimating.
  </p>
  <h2>Figures and charts</h2>
  <p>
    All six charts are computed directly from the same dataset and are captioned
    &ldquo;As of February 2026&rdquo; to match the book&rsquo;s data caveats. Islamic home finance
    products change often. Treat every figure here as a photograph of a moment, not a live quote.
  </p>
  <h2>Not financial advice</h2>
  <p>
    This book is educational. It is not regulated financial advice, Sharia advice, or a
    recommendation to buy any product from any provider. Nothing here is a substitute for speaking
    to an FCA-authorised adviser, and, if it matters to you, your own trusted Islamic scholar,
    before signing anything. The author receives no payment from any provider named in these pages.
  </p>
</section>`
}

function tocPage(chapters, allFigures) {
  const entries = chapters
    .map((chapter) => {
      const subs = chapter.subheadings
        .slice(0, 4)
        .map((heading) => `<li>${escapeHtml(heading)}</li>`)
        .join("")
      return `<li class="toc-entry">
    <a href="#${chapter.id}">
      <span class="toc-num">${chapter.number}</span>
      <span class="toc-title">${escapeHtml(chapter.title)}</span>
      <span class="toc-dots"></span>
    </a>
    ${subs ? `<ul class="toc-sub">${subs}</ul>` : ""}
  </li>`
    })
    .join("\n")

  const figureEntries = allFigures
    .map(
      (figure) => `<li class="toc-entry">
    <a href="#${figure.id}">
      <span class="toc-num">${figure.number}</span>
      <span class="toc-title">${escapeHtml(figure.title)}</span>
      <span class="toc-dots"></span>
    </a>
  </li>`,
    )
    .join("\n")

  return `<section class="toc">
  <h2>Contents</h2>
  <div class="toc-ornament">${calloutRule(130)}</div>
  <ol>
${entries}
    <li class="toc-entry">
      <a href="#appendix">
        <span class="toc-num">A</span>
        <span class="toc-title">Appendix: the February 2026 data snapshot</span>
        <span class="toc-dots"></span>
      </a>
    </li>
  </ol>
  <div class="toc-figures">
    <h3>Figures</h3>
    <ol>
${figureEntries}
    </ol>
  </div>
</section>`
}

/* ================================================================== */
/* Data appendix                                                      */
/* ================================================================== */

function tidy(value) {
  return (value ?? "")
    .toString()
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s+/g, " ")
    .trim()
}

function appendixSection(dataset) {
  const home = dataset.homeFinanceProviders ?? []
  const savings = dataset.savingsProviders ?? []

  const homeRows = home
    .map((row) => {
      const deposit = parseDeposit(row["Max LTV (Min Deposit)"])
      const range = parseFinanceRange(row["Min/Max Finance"])
      return `<tr>
      <td>${escapeHtml(tidy(row.Provider))}</td>
      <td>${escapeHtml(tidy(row["Product Package"]))}</td>
      <td>${escapeHtml(tidy(row.Usage))}</td>
      <td>${escapeHtml(tidy(row["Contract Model"]))}</td>
      <td>${deposit ? `${deposit.deposit}%${deposit.caveat ? " †" : ""}` : "Not stated"}</td>
      <td>${range.min != null ? formatMoney(range.min) : "n/s"}&ndash;${range.max != null ? formatMoney(range.max) : "n/s"}</td>
      <td>${escapeHtml(tidy(row["Term (Yrs)"]))}</td>
      <td>${escapeHtml(tidy(row["Transparency Category"]))}</td>
    </tr>`
    })
    .join("\n")

  const savingsRows = savings
    .map(
      (row) => `<tr>
      <td>${escapeHtml(tidy(row.Provider))}</td>
      <td>${escapeHtml(tidy(row["Product Name"]))}</td>
      <td>${escapeHtml(tidy(row["Liquidity Category"]))}</td>
      <td>${typeof row["Min Deposit"] === "number" ? formatMoney(row["Min Deposit"]) : escapeHtml(tidy(row["Min Deposit"]))}</td>
      <td>${escapeHtml(tidy(row["Profit Payment"]))}</td>
      <td>${escapeHtml(tidy(row["FSCS Protected"]))}</td>
      <td>${escapeHtml(tidy(row.Transparency))}</td>
    </tr>`,
    )
    .join("\n")

  return `<section class="chapter appendix" id="appendix">
  <header class="chapter-opener">
    ${chapterMark(54)}
    <div class="chapter-number">Appendix</div>
    <h2>The February 2026 data snapshot</h2>
    <div class="chapter-rule">${calloutRule(190)}</div>
  </header>
  <p class="opening-para">
    This appendix is a condensed view of the dataset behind every figure, table, and chart in this
    book, extracted from <em>${escapeHtml(dataset.sourceFile)}</em> on ${escapeHtml(dataset.extractionDate)}.
    Product URLs, fee notes, and the long-form Sharia governance descriptions are omitted here for
    space; they sit in the source dataset and in the relevant chapters. A dagger marks a figure that
    carries conditions in the source data.
  </p>
  <h3>Home finance products (${home.length})</h3>
  <div class="table-wrap table-wide">
    <table>
      <thead>
        <tr>
          <th>Provider</th><th>Product</th><th>Usage</th><th>Contract</th>
          <th>Min dep.</th><th>Finance range</th><th>Term (yrs)</th><th>Transp.</th>
        </tr>
      </thead>
      <tbody>
${homeRows}
      </tbody>
    </table>
    <div class="table-caption">As of February 2026</div>
  </div>
  <h3>Halal savings products (${savings.length})</h3>
  <div class="table-wrap table-wide">
    <table>
      <thead>
        <tr>
          <th>Provider</th><th>Product</th><th>Liquidity</th><th>Min deposit</th>
          <th>Profit paid</th><th>FSCS</th><th>Transp.</th>
        </tr>
      </thead>
      <tbody>
${savingsRows}
      </tbody>
    </table>
    <div class="table-caption">As of February 2026</div>
  </div>
  <div class="closing">
    ${terminalMark(24)}
  </div>
</section>`
}

/* ================================================================== */
/* Document assembly                                                  */
/* ================================================================== */

async function buildHtml() {
  const markdown = await readFile(path.join(__dirname, "islamicfinance-guide.md"), "utf8")
  const { body, dataset } = splitSource(markdown)
  const stats = buildStats(dataset)

  const rawChapters = parseChapters(reconcileCounts(body, stats)).filter(
    (chapter) => !FRONT_SECTION_SKIP.test(chapter.title),
  )
  const specs = figureSpecs(stats)

  let figureCounter = 0
  const nextFigureNumber = () => {
    figureCounter += 1
    return figureCounter
  }

  const chapters = rawChapters.map((chapter) =>
    renderChapter(
      chapter,
      specs.filter((spec) => spec.chapter === chapter.number),
      nextFigureNumber,
    ),
  )

  const allFigures = chapters.flatMap((chapter) => chapter.figures)

  const fontFaces = await buildFontFaces()
  const css = await readFile(path.join(__dirname, "book.css"), "utf8")

  const missingPlacements = specs.filter(
    (spec) => !allFigures.some((figure) => figure.title === spec.title),
  )
  if (missingPlacements.length) {
    console.warn(
      "[ebook] warning: figures could not be placed:",
      missingPlacements.map((spec) => spec.title).join("; "),
    )
  }

  const html = `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="utf-8" />
<title>Choosing the Right Islamic Home Finance</title>
<style>
${fontFaces}
</style>
<style>
${css}
</style>
</head>
<body>
<div class="frontmatter">
${colophonPage(stats)}
${tocPage(chapters, allFigures)}
</div>
${chapters.map((chapter) => chapter.html).join("\n\n")}
${appendixSection(dataset)}
<script>
  window.PagedConfig = {
    auto: true,
    after: () => {
      window.__PAGED_DONE__ = true
    },
  }
</script>
<script src="./paged.polyfill.js"></script>
</body>
</html>
`

  await mkdir(BUILD_DIR, { recursive: true })
  await writeFile(HTML_PATH, html, "utf8")
  await copyFile(
    path.resolve(ROOT, "node_modules", "pagedjs", "dist", "paged.polyfill.js"),
    path.join(BUILD_DIR, "paged.polyfill.js"),
  )

  return { stats, chapters, allFigures }
}

/* ================================================================== */
/* PDF                                                                */
/* ================================================================== */

async function renderPdf() {
  const browser = await puppeteer.launch({
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
  })

  try {
    const page = await browser.newPage()
    const problems = []

    page.on("console", (message) => {
      if (message.type() === "error") problems.push(`console: ${message.text()}`)
    })
    page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`))
    page.on("requestfailed", (request) =>
      problems.push(`requestfailed: ${request.url()} (${request.failure()?.errorText})`),
    )

    await page.goto(`file://${HTML_PATH}`, { waitUntil: "networkidle0", timeout: 180_000 })
    await page.waitForFunction("window.__PAGED_DONE__ === true", { timeout: 300_000 })
    await page.evaluate(() => document.fonts.ready)

    const pageCount = await page.evaluate(() => document.querySelectorAll(".pagedjs_page").length)

    await mkdir(OUT_DIR, { recursive: true })
    await page.pdf({
      path: PDF_PATH,
      width: TRIM.width,
      height: TRIM.height,
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      timeout: 300_000,
    })

    return { pageCount, problems }
  } finally {
    await browser.close()
  }
}

/* ================================================================== */
/* CLI                                                                */
/* ================================================================== */

async function main() {
  const htmlOnly = process.argv.includes("--html-only")

  const { chapters, allFigures } = await buildHtml()
  console.log(`[ebook] html written to ${path.relative(ROOT, HTML_PATH)}`)
  console.log(`[ebook] ${chapters.length} chapters, ${allFigures.length} figures`)

  if (htmlOnly) return

  const { pageCount, problems } = await renderPdf()
  console.log(`[ebook] pdf written to ${path.relative(ROOT, PDF_PATH)} (${pageCount} pages)`)

  if (problems.length) {
    console.warn("[ebook] render warnings:")
    for (const problem of [...new Set(problems)]) console.warn(`  - ${problem}`)
  } else {
    console.log("[ebook] no font or asset load errors")
  }
}

main().catch((error) => {
  console.error("[ebook] build failed:", error)
  process.exit(1)
})
