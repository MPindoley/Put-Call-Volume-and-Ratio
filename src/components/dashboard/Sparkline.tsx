'use client';

import { memo } from 'react';

/**
 * 30-minute P/C ratio sparkline. Line sits above/below the 1.0 midline;
 * colored by where the ratio currently is (green = call-tilted, red =
 * put-tilted) — identity is also carried by the adjacent ratio number.
 */
function SparklineImpl({ points }: { points: number[] }): JSX.Element {
  const width = 96;
  const height = 24;
  if (points.length < 2) {
    return <div className="h-6 w-24 rounded bg-surface-overlay/50" aria-hidden />;
  }
  const min = Math.min(...points, 0.8);
  const max = Math.max(...points, 1.2);
  const range = max - min || 1;
  const x = (i: number): number => (i / (points.length - 1)) * width;
  const y = (v: number): number => height - ((v - min) / range) * (height - 4) - 2;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p).toFixed(1)}`).join(' ');
  const midY = y(1);
  const last = points[points.length - 1] ?? 1;
  const color = last > 1 ? '#ef4444' : '#16a34a';

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="shrink-0"
      role="img"
      aria-label={`Put/call ratio trend, currently ${last.toFixed(2)}`}
    >
      {midY >= 0 && midY <= height && (
        <line x1={0} y1={midY} x2={width} y2={midY} stroke="#33415c" strokeWidth={1} strokeDasharray="2 3" />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

export const Sparkline = memo(SparklineImpl);
