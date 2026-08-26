/**
 * ornaments.mjs
 *
 * Hand-built geometric line ornaments in the Islamic geometric tradition.
 * Deliberately sparse: a chapter-opening mark, a section divider, and a
 * small terminal mark. Nothing here is a full-page pattern, because the book
 * is long-form reading and busy pages tire the eye.
 */

const EMERALD = "#0B3D2E"
const GOLD = "#B8860B"

/**
 * Eight-point star (khatim / Rub el Hizb) drawn as two overlaid squares.
 * Returns the path data for a star inscribed in a unit box of `size`.
 */
function starPoints(cx, cy, outer, inner, points = 8, rotation = -Math.PI / 2) {
  const coords = []
  const step = Math.PI / points
  for (let i = 0; i < points * 2; i += 1) {
    const radius = i % 2 === 0 ? outer : inner
    const angle = rotation + i * step
    coords.push(`${(cx + radius * Math.cos(angle)).toFixed(2)},${(cy + radius * Math.sin(angle)).toFixed(2)}`)
  }
  return coords.join(" ")
}

function square(cx, cy, half, rotationDeg) {
  return `<rect x="${cx - half}" y="${cy - half}" width="${half * 2}" height="${half * 2}"
    fill="none" stroke="currentColor" stroke-width="1"
    transform="rotate(${rotationDeg} ${cx} ${cy})" />`
}

/** Chapter-opening mark: interlaced squares inside a ring, with a star core. */
export function chapterMark(size = 54) {
  const c = size / 2
  const half = size * 0.3
  return `<svg class="ornament ornament-chapter" width="${size}" height="${size}"
  viewBox="0 0 ${size} ${size}" role="presentation" aria-hidden="true">
  <g color="${GOLD}" opacity="0.95">
    ${square(c, c, half, 0)}
    ${square(c, c, half, 45)}
    <circle cx="${c}" cy="${c}" r="${size * 0.42}" fill="none" stroke="currentColor" stroke-width="0.6" opacity="0.55" />
  </g>
  <polygon points="${starPoints(c, c, size * 0.17, size * 0.075)}" fill="${EMERALD}" opacity="0.9" />
</svg>`
}

/** Section divider: a centre star flanked by tapering rules and small lozenges. */
export function sectionDivider(width = 300) {
  const h = 22
  const c = width / 2
  const mid = h / 2
  const gap = 26
  const lozenge = (x) =>
    `<polygon points="${x},${mid - 3} ${x + 3},${mid} ${x},${mid + 3} ${x - 3},${mid}" fill="${GOLD}" opacity="0.8" />`

  return `<svg class="ornament ornament-divider" width="${width}" height="${h}"
  viewBox="0 0 ${width} ${h}" role="presentation" aria-hidden="true">
  <defs>
    <linearGradient id="ruleL" x1="0" x2="1">
      <stop offset="0" stop-color="${EMERALD}" stop-opacity="0" />
      <stop offset="1" stop-color="${EMERALD}" stop-opacity="0.55" />
    </linearGradient>
    <linearGradient id="ruleR" x1="0" x2="1">
      <stop offset="0" stop-color="${EMERALD}" stop-opacity="0.55" />
      <stop offset="1" stop-color="${EMERALD}" stop-opacity="0" />
    </linearGradient>
  </defs>
  <line x1="${c - width * 0.42}" y1="${mid}" x2="${c - gap}" y2="${mid}" stroke="url(#ruleL)" stroke-width="0.8" />
  <line x1="${c + gap}" y1="${mid}" x2="${c + width * 0.42}" y2="${mid}" stroke="url(#ruleR)" stroke-width="0.8" />
  ${lozenge(c - gap + 8)}
  ${lozenge(c + gap - 8)}
  <polygon points="${starPoints(c, mid, 9, 4)}" fill="none" stroke="${EMERALD}" stroke-width="0.9" opacity="0.85" />
  <polygon points="${starPoints(c, mid, 4.2, 1.9)}" fill="${GOLD}" opacity="0.9" />
</svg>`
}

/** Small terminal mark used at the end of the book and on the title page. */
export function terminalMark(size = 26) {
  const c = size / 2
  return `<svg class="ornament ornament-terminal" width="${size}" height="${size}"
  viewBox="0 0 ${size} ${size}" role="presentation" aria-hidden="true">
  <polygon points="${starPoints(c, c, c * 0.9, c * 0.4)}" fill="none" stroke="${GOLD}" stroke-width="0.9" />
  <circle cx="${c}" cy="${c}" r="${c * 0.16}" fill="${EMERALD}" />
</svg>`
}

/** A single hairline rule with a gold lozenge at its centre, for callout tops. */
export function calloutRule(width = 300) {
  const c = width / 2
  return `<svg class="ornament ornament-rule" width="${width}" height="7"
  viewBox="0 0 ${width} 7" role="presentation" aria-hidden="true">
  <line x1="0" y1="3.5" x2="${c - 7}" y2="3.5" stroke="${GOLD}" stroke-width="0.7" opacity="0.7" />
  <line x1="${c + 7}" y1="3.5" x2="${width}" y2="3.5" stroke="${GOLD}" stroke-width="0.7" opacity="0.7" />
  <polygon points="${c},1 ${c + 3},3.5 ${c},6 ${c - 3},3.5" fill="${GOLD}" />
</svg>`
}

/** Title-page frame corner flourish, drawn four times by the template. */
export function cornerFlourish(size = 34) {
  return `<svg class="ornament ornament-corner" width="${size}" height="${size}"
  viewBox="0 0 ${size} ${size}" role="presentation" aria-hidden="true">
  <path d="M0.75 ${size} L0.75 12 Q0.75 0.75 12 0.75 L${size} 0.75"
    fill="none" stroke="${GOLD}" stroke-width="0.9" opacity="0.85" />
  <polygon points="${starPoints(12, 12, 4.6, 2.1)}" fill="${EMERALD}" opacity="0.75" />
</svg>`
}
