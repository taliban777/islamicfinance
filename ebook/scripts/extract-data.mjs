/**
 * extract-data.mjs
 *
 * Pulls the Appendix Z JSON block out of ebook/islamicfinance-guide.md and
 * derives the aggregate statistics used by the book's charts.
 *
 * No numbers are invented here. Every figure is computed from the embedded
 * February 2026 snapshot.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, "..")
const SOURCE_MD = path.join(ROOT, "islamicfinance-guide.md")
const OUT_DIR = path.join(ROOT, "build")
const OUT_FILE = path.join(OUT_DIR, "stats.json")

/* ------------------------------------------------------------------ */
/* Appendix extraction                                                 */
/* ------------------------------------------------------------------ */

export async function readMarkdown() {
  return readFile(SOURCE_MD, "utf8")
}

/**
 * Splits the markdown into the narrative body (chapters) and the raw
 * Appendix Z JSON payload.
 */
export function splitSource(markdown) {
  const appendixHeadingIndex = markdown.indexOf("## APPENDIX Z")
  if (appendixHeadingIndex === -1) {
    throw new Error("Could not locate the Appendix Z heading in the source markdown.")
  }

  const body = markdown.slice(0, appendixHeadingIndex)
  const appendix = markdown.slice(appendixHeadingIndex)

  const fenceStart = appendix.indexOf("```json")
  const fenceEnd = appendix.lastIndexOf("```")
  if (fenceStart === -1 || fenceEnd <= fenceStart) {
    throw new Error("Could not locate the Appendix Z JSON fence.")
  }

  const json = appendix.slice(fenceStart + "```json".length, fenceEnd).trim()
  const appendixPreamble = appendix.slice(0, fenceStart)

  return { body, appendixPreamble, dataset: JSON.parse(json) }
}

/* ------------------------------------------------------------------ */
/* Field parsers                                                       */
/* ------------------------------------------------------------------ */

/** "80% (20% Dep)" / "95% (5% Dep)*" -> { ltv: 80, deposit: 20, caveat: false } */
export function parseDeposit(raw) {
  if (typeof raw !== "string") return null
  const depositMatch = raw.match(/(\d+(?:\.\d+)?)\s*%\s*Dep/i)
  const ltvMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/)
  if (!depositMatch) return null
  return {
    deposit: Number.parseFloat(depositMatch[1]),
    ltv: ltvMatch ? Number.parseFloat(ltvMatch[1]) : null,
    caveat: raw.includes("*"),
  }
}

/** "£50k / £2m" -> { min: 50000, max: 2000000 } */
export function parseMoney(token) {
  if (typeof token !== "string") return null
  const match = token.replace(/,/g, "").match(/£\s*(\d+(?:\.\d+)?)\s*([km])?/i)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  const unit = (match[2] || "").toLowerCase()
  if (unit === "k") return value * 1_000
  if (unit === "m") return value * 1_000_000
  return value
}

export function parseFinanceRange(raw) {
  if (typeof raw !== "string") return { min: null, max: null }
  const [minToken, maxToken] = raw.split("/")
  return { min: parseMoney(minToken), max: parseMoney(maxToken) }
}

/* ------------------------------------------------------------------ */
/* Aggregations                                                        */
/* ------------------------------------------------------------------ */

/** Tidies spacing quirks in the source spreadsheet, e.g. "Ahli United(Kuwait bank)". */
function tidy(value) {
  return (value ?? "")
    .toString()
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s+/g, " ")
    .trim()
}

function tally(rows, key) {
  const counts = new Map()
  for (const row of rows) {
    const value = (row[key] ?? "Not stated").toString().trim() || "Not stated"
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
}

function orderedTally(rows, key, order) {
  const counts = tally(rows, key)
  const index = new Map(order.map((label, i) => [label, i]))
  return counts.sort((a, b) => {
    const ai = index.has(a.label) ? index.get(a.label) : order.length
    const bi = index.has(b.label) ? index.get(b.label) : order.length
    return ai - bi || a.label.localeCompare(b.label)
  })
}

export function buildStats(dataset) {
  const home = dataset.homeFinanceProviders ?? []
  const savings = dataset.savingsProviders ?? []

  const isHomeUse = (row) => {
    const usage = (row.Usage ?? "").toLowerCase()
    return !usage.includes("buy-to-let") && !usage.includes("commercial")
  }

  /* --- Chart 1: contract model distribution across all home products --- */
  const contractModels = tally(home, "Contract Model")

  /* --- Chart 2: minimum deposit by product, sorted ascending --- */
  const depositByProduct = home
    .map((row) => {
      const parsed = parseDeposit(row["Max LTV (Min Deposit)"])
      if (!parsed) return null
      return {
        label: `${tidy(row.Provider)}, ${tidy(row["Product Package"])}`,
        provider: tidy(row.Provider),
        product: tidy(row["Product Package"]),
        value: parsed.deposit,
        ltv: parsed.ltv,
        caveat: parsed.caveat,
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value || a.label.localeCompare(b.label))

  /* --- Chart 3: lowest minimum finance size per provider --- */
  const minFinanceMap = new Map()
  for (const row of home) {
    const { min } = parseFinanceRange(row["Min/Max Finance"])
    if (min == null) continue
    const provider = tidy(row.Provider)
    const current = minFinanceMap.get(provider)
    if (current == null || min < current) minFinanceMap.set(provider, min)
  }
  const minFinanceByProvider = [...minFinanceMap.entries()]
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => a.value - b.value || a.label.localeCompare(b.label))

  /* --- Chart 4: transparency category counts (home finance) --- */
  const transparencyHome = orderedTally(home, "Transparency Category", ["High", "Medium", "Low"])

  /* --- Chart 5: savings products by liquidity category --- */
  const savingsByLiquidity = tally(savings, "Liquidity Category")

  /* --- Chart 6: FSCS protection, grouped into covered vs not covered --- */
  const fscsRaw = tally(savings, "FSCS Protected")
  const covered = fscsRaw.filter((entry) => /^yes/i.test(entry.label))
  const notCovered = fscsRaw.filter((entry) => !/^yes/i.test(entry.label))
  const sumOf = (entries) => entries.reduce((total, entry) => total + entry.value, 0)
  const detailOf = (entries) =>
    entries
      .map((entry) => entry.label.replace(/^(yes|no)\s*/i, "").replace(/[()]/g, "") || "unqualified")
      .filter((label) => label !== "unqualified")
      .join(", ")

  const fscs = [
    { label: "FSCS protected", value: sumOf(covered), detail: detailOf(covered) },
    { label: "Not FSCS protected", value: sumOf(notCovered), detail: detailOf(notCovered) },
  ].filter((entry) => entry.value > 0)

  /* --- supporting figures quoted in the text --- */
  const providerCount = new Set(home.map((row) => row.Provider)).size
  const savingsProviderCount = new Set(savings.map((row) => row.Provider)).size
  const deposits = depositByProduct.map((d) => d.value)
  const residentialDeposits = home
    .filter(isHomeUse)
    .map((row) => parseDeposit(row["Max LTV (Min Deposit)"]))
    .filter(Boolean)
    .map((d) => d.deposit)

  const summary = {
    homeProductCount: home.length,
    homeProviderCount: providerCount,
    savingsProductCount: savings.length,
    savingsProviderCount,
    depositStatedCount: deposits.length,
    lowestDeposit: deposits.length ? Math.min(...deposits) : null,
    highestDeposit: deposits.length ? Math.max(...deposits) : null,
    medianDeposit: deposits.length ? median(deposits) : null,
    medianResidentialDeposit: residentialDeposits.length ? median(residentialDeposits) : null,
    lowestMinFinance: minFinanceByProvider.length ? minFinanceByProvider[0].value : null,
    diminishingMusharakaShare: share(contractModels, "Diminishing Musharaka", home.length),
    highTransparencyShare: share(transparencyHome, "High", home.length),
  }

  return {
    extractionDate: dataset.extractionDate,
    sourceFile: dataset.sourceFile,
    caption: "As of February 2026",
    summary,
    charts: {
      contractModels,
      depositByProduct,
      minFinanceByProvider,
      transparencyHome,
      savingsByLiquidity,
      fscs,
    },
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function share(entries, label, total) {
  const found = entries.find((entry) => entry.label === label)
  if (!found || !total) return null
  return Math.round((found.value / total) * 100)
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

async function main() {
  const markdown = await readMarkdown()
  const { dataset } = splitSource(markdown)
  const stats = buildStats(dataset)

  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT_FILE, `${JSON.stringify(stats, null, 2)}\n`, "utf8")

  console.log(`[ebook] stats written to ${path.relative(ROOT, OUT_FILE)}`)
  console.log(
    `[ebook] ${stats.summary.homeProductCount} home finance products / ${stats.summary.homeProviderCount} providers, ` +
      `${stats.summary.savingsProductCount} savings products`,
  )
  for (const [name, series] of Object.entries(stats.charts)) {
    console.log(`[ebook]   ${name}: ${series.length} series points`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("[ebook] extract-data failed:", error)
    process.exit(1)
  })
}
