export interface PathPoint {
  x: number;
  y: number;
}

/**
 * Monotone cubic (Fritsch-Carlson) SVG path through the given points.
 *
 * Plain polylines make dense intraday series look jagged and "broken", but a
 * naive spline overshoots - which on a price/OI chart would draw highs and lows
 * that never happened. Monotone interpolation is smooth AND stays within the
 * data, so no invented extremes.
 *
 * PRECONDITION: `pts` must be sorted by ascending x. Out-of-order x makes the
 * curve loop back on itself (a polyline would merely zigzag), so callers that
 * cannot guarantee ordering should sort first.
 */
export function smoothPath(pts: PathPoint[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M ${pts[0]!.x} ${pts[0]!.y}`;
  if (n === 2) {
    return `M ${pts[0]!.x} ${pts[0]!.y} L ${pts[1]!.x} ${pts[1]!.y}`;
  }

  // Secant slopes between consecutive points.
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const h = pts[i + 1]!.x - pts[i]!.x;
    dx.push(h);
    slope.push(h === 0 ? 0 : (pts[i + 1]!.y - pts[i]!.y) / h);
  }

  // Tangents: zero at local extrema so the curve cannot overshoot there.
  const tan: number[] = [slope[0]!];
  for (let i = 1; i < n - 1; i++) {
    const a = slope[i - 1]!;
    const b = slope[i]!;
    tan.push(a * b <= 0 ? 0 : (a + b) / 2);
  }
  tan.push(slope[n - 2]!);

  // Fritsch-Carlson limiter keeps each segment monotone.
  for (let i = 0; i < n - 1; i++) {
    const m = slope[i]!;
    if (m === 0) {
      tan[i] = 0;
      tan[i + 1] = 0;
      continue;
    }
    const a = tan[i]! / m;
    const b = tan[i + 1]! / m;
    const s = Math.hypot(a, b);
    if (s > 3) {
      const k = 3 / s;
      tan[i] = k * a * m;
      tan[i + 1] = k * b * m;
    }
  }

  let d = `M ${pts[0]!.x} ${pts[0]!.y}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]!;
    const c1x = pts[i]!.x + h / 3;
    const c1y = pts[i]!.y + (tan[i]! * h) / 3;
    const c2x = pts[i + 1]!.x - h / 3;
    const c2y = pts[i + 1]!.y - (tan[i + 1]! * h) / 3;
    d += ` C ${c1x} ${c1y} ${c2x} ${c2y} ${pts[i + 1]!.x} ${pts[i + 1]!.y}`;
  }
  return d;
}
