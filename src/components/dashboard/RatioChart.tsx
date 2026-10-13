'use client';

/**
 * Intraday aggregate P/C ratio chart with an SPY price pane below it —
 * two stacked charts on one shared (synced) time axis rather than a
 * dual-axis overlay, so both scales stay honest.
 */
import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Card, CardHeader } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useFlowStore } from '@/store/flowStore';

const CHART_OPTIONS = {
  // Pin the locale: lightweight-charts otherwise reads navigator.language,
  // and a malformed system locale crashes its axis label formatting.
  localization: { locale: 'en-US' },
  layout: {
    background: { type: ColorType.Solid, color: 'transparent' },
    textColor: '#64748b',
    fontSize: 10,
  },
  grid: {
    vertLines: { color: '#1a2332' },
    horzLines: { color: '#1a2332' },
  },
  timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#232f42' },
  rightPriceScale: { borderColor: '#232f42' },
  crosshair: { horzLine: { labelBackgroundColor: '#1a2332' }, vertLine: { labelBackgroundColor: '#1a2332' } },
} as const;

/** `embedded` drops the card chrome and shortens the panes for the side panel. */
export function RatioChart({ embedded = false }: { embedded?: boolean }): JSX.Element {
  const ratioHeight = embedded ? 150 : 180;
  const spyHeight = embedded ? 70 : 90;
  const series = useFlowStore((s) => s.ratioSeries);
  const ratioContainer = useRef<HTMLDivElement>(null);
  const spyContainer = useRef<HTMLDivElement>(null);
  const charts = useRef<{
    ratio: IChartApi;
    spy: IChartApi;
    ratioSeries: ISeriesApi<'Line'>;
    spySeries: ISeriesApi<'Line'>;
  } | null>(null);

  useEffect(() => {
    if (!ratioContainer.current || !spyContainer.current) return;

    const ratioChart = createChart(ratioContainer.current, { ...CHART_OPTIONS, height: ratioHeight, autoSize: true });
    const spyChart = createChart(spyContainer.current, { ...CHART_OPTIONS, height: spyHeight, autoSize: true });

    const ratioSeries = ratioChart.addLineSeries({
      color: '#60a5fa',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    ratioSeries.createPriceLine({
      price: 1,
      color: '#64748b',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: false,
      title: 'neutral',
    });
    const spySeries = spyChart.addLineSeries({
      color: '#a78bfa',
      lineWidth: 2,
      priceLineVisible: false,
    });

    // Keep the two panes' visible ranges in lockstep.
    let syncing = false;
    const link = (from: IChartApi, to: IChartApi): void => {
      from.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (syncing || !range) return;
        syncing = true;
        to.timeScale().setVisibleLogicalRange(range);
        syncing = false;
      });
    };
    link(ratioChart, spyChart);
    link(spyChart, ratioChart);

    charts.current = { ratio: ratioChart, spy: spyChart, ratioSeries, spySeries };
    return () => {
      ratioChart.remove();
      spyChart.remove();
      charts.current = null;
    };
  }, [ratioHeight, spyHeight]);

  useEffect(() => {
    if (!charts.current || series.length === 0) return;
    const ratioData: LineData[] = series.map((p) => ({ time: p.time as UTCTimestamp, value: p.ratio }));
    const spyData: LineData[] = series
      .filter((p) => p.spx !== undefined)
      .map((p) => ({ time: p.time as UTCTimestamp, value: p.spx as number }));
    charts.current.ratioSeries.setData(ratioData);
    charts.current.spySeries.setData(spyData);
    charts.current.ratio.timeScale().fitContent();
  }, [series]);

  const legend = (
    <span className="flex items-center gap-3 text-[10px] text-slate-500">
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-3 bg-[#60a5fa]" /> P/C ratio
      </span>
      <span className="flex items-center gap-1">
        <span className="h-0.5 w-3 bg-[#a78bfa]" /> SPY
      </span>
    </span>
  );
  const panes = (
    <div className={cn('relative', !embedded && 'p-2')}>
      <div ref={ratioContainer} className="w-full" style={{ height: ratioHeight }} />
      <div ref={spyContainer} className="w-full" style={{ height: spyHeight }} />
      {series.length === 0 && (
        <p className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
          Chart populates as poll cycles complete…
        </p>
      )}
    </div>
  );

  if (embedded) {
    return (
      <div>
        <div className="mb-1 flex justify-end">{legend}</div>
        {panes}
      </div>
    );
  }
  return (
    <Card>
      <CardHeader title="Aggregate Ratio — Intraday" right={legend} />
      {panes}
    </Card>
  );
}
