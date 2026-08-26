/**
 * charts.mjs
 *
 * Hand-built inline SVG charts. This is a static print artefact rather than a
 * running app, so the charts are generated as plain SVG that inherits the
 * book's typography and colour palette and stays crisp at print resolution.
 *
 * Every chart is captioned "As of February 2026" to match the book's data
 * caveats, and every value traces back to the Appendix Z snapshot.
 */

const INK = "#2A2118"
const MUTED = "#6F6355"
const EMERALD = "#0B3D2E"
const GOLD = "#B8860B"
const HAIRLINE = "#D9CDB4"

/** Emerald-to-gold ramp. Ordered so the largest slice reads darkest. */
export const SERIES = ["#0B3D2E", "#255C46", "#4B8A6C", "#B8860B", "#D4AE5C", "#8C8172"]

const FIGURE_WIDTH = 440

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function formatMoney(value) {
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `£${millions % 1 === 0 ? millions : millions.toFixed(1)}m`
  }
  if (value >= 1_000) return `£${Math.round(value / 1_000)}k`
  return `£${value}`
}

function polarToCartesian(cx, cy, radius, angleRad) {
  return [cx + radius * Math.cos(angleRad), cy + radius * Math.sin(angleRad)]
}

function donutSlicePath(cx, cy, outer, inner, startAngle, endAngle) {
  const [x1, y1] = polarToCartesian(cx, cy, outer, startAngle)
  const [x2, y2] = polarToCartesian(cx, cy, outer, endAngle)
  const [x3, y3] = polarToCartesian(cx, cy, inner, endAngle)
  const [x4, y4] = polarToCartesian(cx, cy, inner, startAngle)
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0
  return [
    `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
    `A ${outer} ${outer} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
    `L ${x3.toFixed(2)} ${y3.toFixed(2)}`,
    `A ${inner} ${inner} 0 ${largeArc} 0 ${x4.toFixed(2)} ${y4.toFixed(2)}`,
    "Z",
  ].join(" ")
}

/**
 * Wraps a figure in the shared caption furniture used throughout the book.
 */
function figureShell({ id, number, title, note, svg, caption = "As of February 2026", pageBreak }) {
  const classes = ["figure", pageBreak ? "figure-standalone" : ""].filter(Boolean).join(" ")
  return `<figure class="${classes}"${id ? ` id="${id}"` : ""}>
  <figcaption class="figure-head">
    <span class="figure-number">Figure ${number}</span>
    <span class="figure-title">${escapeHtml(title)}</span>
  </figcaption>
  ${svg}
  <figcaption class="figure-foot">
    ${note ? `<span class="figure-note">${escapeHtml(note)}</span>` : ""}
    <span class="figure-caption">${escapeHtml(caption)}</span>
  </figcaption>
</figure>`
}

/* ------------------------------------------------------------------ */
/* donut                                                               */
/* ------------------------------------------------------------------ */

export function donutChart({ id, number, title, note, data, centreLabel, centreValue, caption }) {
  const total = data.reduce((sum, entry) => sum + entry.value, 0)
  const size = 190
  const cx = size / 2
  const cy = size / 2
  const outer = 84
  const inner = 50

  let angle = -Math.PI / 2
  const slices = data
    .map((entry, index) => {
      const sweep = (entry.value / total) * Math.PI * 2
      const path = donutSlicePath(cx, cy, outer, inner, angle, angle + sweep - 0.012)
      angle += sweep
      return `<path d="${path}" fill="${SERIES[index % SERIES.length]}" />`
    })
    .join("\n    ")

  const legendRows = data
    .map((entry, index) => {
      const pct = Math.round((entry.value / total) * 100)
      return `<li>
      <span class="swatch" style="background:${SERIES[index % SERIES.length]}"></span>
      <span class="legend-label">${escapeHtml(entry.label)}</span>
      <span class="legend-value">${entry.value} <span class="legend-pct">(${pct}%)</span></span>
      ${entry.detail ? `<span class="legend-detail">${escapeHtml(entry.detail)}</span>` : ""}
    </li>`
    })
    .join("\n    ")

  const svg = `<div class="chart chart-donut">
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img"
    aria-label="${escapeHtml(title)}">
    ${slices}
    <circle cx="${cx}" cy="${cy}" r="${inner - 1}" fill="none" stroke="${HAIRLINE}" stroke-width="0.6" />
    <text x="${cx}" y="${cy - 3}" class="donut-value" text-anchor="middle">${escapeHtml(centreValue ?? String(total))}</text>
    <text x="${cx}" y="${cy + 13}" class="donut-label" text-anchor="middle">${escapeHtml(centreLabel ?? "products")}</text>
  </svg>
  <ul class="chart-legend">
    ${legendRows}
  </ul>
</div>`

  return figureShell({ id, number, title, note, svg, caption })
}

/* ------------------------------------------------------------------ */
/* horizontal bars                                                     */
/* ------------------------------------------------------------------ */

/**
 * Horizontal bar chart. Rows may carry a `sublabel` for a second, quieter
 * line, which is how the per-product deposit chart keeps long
 * "provider + product" names readable at book trim size.
 */
export function barChart({
  id,
  number,
  title,
  note,
  data,
  labelWidth = 150,
  rowHeight = 20,
  valueFormat = (value) => String(value),
  axisTicks = 4,
  axisLabel,
  colorFor,
  caption,
  pageBreak = false,
  highlight = () => false,
}) {
  const width = FIGURE_WIDTH
  const valueGutter = 42
  const plotLeft = labelWidth + 10
  const plotWidth = width - plotLeft - valueGutter
  const top = 16
  const max = Math.max(...data.map((entry) => entry.value))
  const height = top + data.length * rowHeight + 26

  const scale = (value) => (value / max) * plotWidth

  const ticks = Array.from({ length: axisTicks + 1 }, (_, i) => (max / axisTicks) * i)
  const gridlines = ticks
    .map((tick) => {
      const x = plotLeft + scale(tick)
      return `<line x1="${x.toFixed(1)}" y1="${top - 6}" x2="${x.toFixed(1)}" y2="${top + data.length * rowHeight}"
      stroke="${HAIRLINE}" stroke-width="0.5" ${tick === 0 ? 'opacity="1"' : 'opacity="0.7"'} />`
    })
    .join("\n    ")

  const tickLabels = ticks
    .map((tick) => {
      const x = plotLeft + scale(tick)
      return `<text x="${x.toFixed(1)}" y="${top + data.length * rowHeight + 13}" class="axis-tick"
      text-anchor="${tick === 0 ? "start" : "middle"}">${escapeHtml(valueFormat(tick))}</text>`
    })
    .join("\n    ")

  const rows = data
    .map((entry, index) => {
      const y = top + index * rowHeight
      const barH = entry.sublabel ? rowHeight - 8 : rowHeight - 7
      const barY = y + (rowHeight - barH) / 2
      const barW = Math.max(scale(entry.value), 1.2)
      const fill = colorFor ? colorFor(entry, index) : highlight(entry, index) ? GOLD : EMERALD
      const labelY = entry.sublabel ? y + rowHeight / 2 - 1 : y + rowHeight / 2 + 3

      const primary = `<text x="${labelWidth}" y="${labelY.toFixed(1)}" class="bar-label" text-anchor="end">${escapeHtml(entry.label)}</text>`
      const secondary = entry.sublabel
        ? `<text x="${labelWidth}" y="${(y + rowHeight / 2 + 8).toFixed(1)}" class="bar-sublabel" text-anchor="end">${escapeHtml(entry.sublabel)}</text>`
        : ""

      return `<g>
      ${primary}
      ${secondary}
      <rect x="${plotLeft}" y="${barY.toFixed(1)}" width="${barW.toFixed(1)}" height="${barH}" fill="${fill}" />
      <text x="${(plotLeft + barW + 5).toFixed(1)}" y="${(barY + barH / 2 + 3).toFixed(1)}" class="bar-value">${escapeHtml(
        valueFormat(entry.value),
      )}${entry.flag ? `<tspan class="bar-flag">${escapeHtml(entry.flag)}</tspan>` : ""}</text>
    </g>`
    })
    .join("\n    ")

  const svg = `<div class="chart chart-bar">
  <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
    aria-label="${escapeHtml(title)}">
    ${gridlines}
    ${rows}
    ${tickLabels}
    ${
      axisLabel
        ? `<text x="${plotLeft}" y="${height - 2}" class="axis-name">${escapeHtml(axisLabel)}</text>`
        : ""
    }
  </svg>
</div>`

  return figureShell({ id, number, title, note, svg, caption, pageBreak })
}

export const palette = { INK, MUTED, EMERALD, GOLD, HAIRLINE }
