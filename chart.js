/* Shared, pure geometry for daily, weekly and fortnightly charts. */
import { daysBetween } from './core.js';

export function chartLayout(series, start, end, viewportWidth, height = 320, zoom = 1) {
  const days = daysBetween(start, end) + 1;
  const width = Math.max(160, viewportWidth) * Math.min(128, Math.max(1, Number(zoom) || 1));
  const top = 26, bottom = Math.max(90, height - 54), left = 32, right = width - 32;
  const unit = (right - left) / days;
  const edge = date => left + daysBetween(start, date) * unit;
  const positions = series.map(p => edge(p.start || p.date) + (daysBetween(p.start || p.date, p.displayEnd || p.date) + 1) * unit / 2);
  const minGap = positions.length < 2 ? width : Math.min(...positions.slice(1).map((x, i) => x - positions[i]));
  const labelEvery = Math.max(1, Math.ceil(64 / Math.max(1, minGap)));
  return { width, height, top, bottom, left, right, unit, positions, labelEvery, showValues: minGap >= 58,
    edge, y: value => top + (400 - Math.min(400, Math.max(350, value))) / 50 * (bottom - top),
    band: (from, to) => ({ x: edge(from), width: (daysBetween(from, to) + 1) * unit }) };
}
