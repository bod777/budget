import { useEffect, useMemo, useState } from 'react';
import { api, formatMoney, type CategoryStat, type PeriodStat, type Reference } from '../api.ts';
import { Accounts } from './Accounts.tsx';

interface Props {
  reference: Reference;
  refreshKey: number;
}

/**
 * History charts.
 *
 * Two questions, two forms:
 *   - how spending and income have moved period to period  -> two lines, the
 *     only place a categorical palette is used (two series, direct-labelled)
 *   - where this period's money went                       -> horizontal bars,
 *     one hue, magnitude only
 *
 * Everything is bucketed by budget period, not calendar month, so these agree
 * with the dashboard.
 */

const CHART_W = 320;
const CHART_H = 150;
const PAD = { top: 12, right: 10, bottom: 22, left: 42 };

function shortMonth(month: string): string {
  return new Date(`${month}-01T00:00:00`).toLocaleDateString('en-IE', { month: 'short' });
}

function niceCeiling(value: number): number {
  if (value <= 0) return 100;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / magnitude) * magnitude;
}

export function Trends({ reference, refreshKey }: Props) {
  const [periods, setPeriods] = useState<PeriodStat[]>([]);
  const [categories, setCategories] = useState<CategoryStat[]>([]);
  const [span, setSpan] = useState(12);
  const [hover, setHover] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const money = (value: number) => formatMoney(value, reference.currency, reference.locale);
  const compact = (value: number) =>
    value >= 1000 ? `${Math.round(value / 100) / 10}k` : String(Math.round(value));

  useEffect(() => {
    setLoading(true);
    Promise.all([api.statsPeriods(span), api.statsCategories()])
      .then(([p, c]) => {
        setPeriods(p.periods);
        setCategories(c.categories);
      })
      .catch(() => setPeriods([]))
      .finally(() => setLoading(false));
  }, [span, refreshKey]);

  const geometry = useMemo(() => {
    if (periods.length < 2) return null;
    const max = niceCeiling(
      Math.max(...periods.map((p) => Math.max(p.expenses, p.income)), 1),
    );
    const innerW = CHART_W - PAD.left - PAD.right;
    const innerH = CHART_H - PAD.top - PAD.bottom;
    const x = (index: number) => PAD.left + (index / (periods.length - 1)) * innerW;
    const y = (value: number) => PAD.top + innerH - (value / max) * innerH;
    const path = (pick: (p: PeriodStat) => number) =>
      periods.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(' ');
    return { max, x, y, innerW, innerH, path };
  }, [periods]);

  const active = hover !== null ? periods[hover] : undefined;
  const topCategories = categories.slice(0, 8);
  const categoryMax = Math.max(...topCategories.map((c) => c.amount), 1);

  if (loading && periods.length === 0) return <div className="empty">Loading…</div>;
  if (periods.length < 2) {
    return <div className="empty">Not enough history yet to chart.</div>;
  }

  return (
    <div className="viz-root">
      <div className="spread" style={{ marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>Spending and income</h2>
        <div className="segmented compact-segmented" role="group" aria-label="How far back">
          {[6, 12, 24].map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={span === option}
              onClick={() => setSpan(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="card">
        {/* Two series, so a legend is always present and both are direct-labelled. */}
        <div className="legend">
          <span className="legend-item">
            <span className="swatch" style={{ background: 'var(--series-1)' }} aria-hidden="true" />
            Spending
          </span>
          <span className="legend-item">
            <span className="swatch" style={{ background: 'var(--series-2)' }} aria-hidden="true" />
            Income
          </span>
        </div>

        <svg
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="chart"
          role="img"
          aria-label={`Spending and income for the last ${periods.length} budget periods`}
          onPointerLeave={() => setHover(null)}
          onPointerMove={(event) => {
            if (!geometry) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const px = ((event.clientX - rect.left) / rect.width) * CHART_W;
            const ratio = (px - PAD.left) / geometry.innerW;
            const index = Math.round(ratio * (periods.length - 1));
            setHover(Math.min(Math.max(index, 0), periods.length - 1));
          }}
        >
          {/* Recessive grid: three gridlines, no chart junk. */}
          {[0, 0.5, 1].map((fraction) => {
            const value = geometry!.max * fraction;
            return (
              <g key={fraction}>
                <line
                  x1={PAD.left}
                  x2={CHART_W - PAD.right}
                  y1={geometry!.y(value)}
                  y2={geometry!.y(value)}
                  className="grid"
                />
                <text x={PAD.left - 6} y={geometry!.y(value) + 3} className="axis" textAnchor="end">
                  {compact(value)}
                </text>
              </g>
            );
          })}

          {periods.map((period, index) =>
            index % Math.ceil(periods.length / 6) === 0 ? (
              <text
                key={period.month}
                x={geometry!.x(index)}
                y={CHART_H - 6}
                className="axis"
                textAnchor="middle"
              >
                {shortMonth(period.month)}
              </text>
            ) : null,
          )}

          {hover !== null && (
            <line
              x1={geometry!.x(hover)}
              x2={geometry!.x(hover)}
              y1={PAD.top}
              y2={CHART_H - PAD.bottom}
              className="crosshair"
            />
          )}

          <path d={geometry!.path((p) => p.income)} className="line series-2" />
          <path d={geometry!.path((p) => p.expenses)} className="line series-1" />

          {hover !== null && active && (
            <>
              <circle cx={geometry!.x(hover)} cy={geometry!.y(active.income)} r={4.5} className="dot series-2" />
              <circle cx={geometry!.x(hover)} cy={geometry!.y(active.expenses)} r={4.5} className="dot series-1" />
            </>
          )}
        </svg>

        <div className="chart-readout" aria-live="polite">
          {active ? (
            <>
              <strong>
                {new Date(`${active.month}-01T00:00:00`).toLocaleDateString('en-IE', {
                  month: 'long',
                  year: 'numeric',
                })}
              </strong>
              {active.partial && <span className="muted small"> · still running</span>}
              <div className="small">
                <span className="swatch" style={{ background: 'var(--series-1)' }} aria-hidden="true" />
                {money(active.expenses)} spent
                <span style={{ marginLeft: 12 }}>
                  <span className="swatch" style={{ background: 'var(--series-2)' }} aria-hidden="true" />
                  {money(active.income)} in
                </span>
              </div>
            </>
          ) : (
            <span className="muted small">Touch the chart to read a period.</span>
          )}
        </div>
      </div>

      <div className="spread" style={{ marginTop: 22 }}>
        <h2 style={{ margin: 0 }}>Balances</h2>
        <span className="small muted">right now</span>
      </div>
      <Accounts reference={reference} refreshKey={refreshKey} compact />

      <h2>Where it went this period</h2>
      <div className="card">
        {topCategories.length === 0 ? (
          <div className="empty">Nothing spent yet this period.</div>
        ) : (
          <table className="budget-table">
            <tbody>
              {topCategories.map((category) => {
                const delta = Math.round((category.amount - category.previous) * 100) / 100;
                return (
                  <tr key={category.name}>
                    <td style={{ width: '38%' }}>
                      {category.name}
                      {category.previous > 0 && (
                        <div className="small muted">
                          {delta === 0
                            ? 'same as last period'
                            : `${delta > 0 ? '▲' : '▼'} ${money(Math.abs(delta))} vs last`}
                        </div>
                      )}
                    </td>
                    <td style={{ width: '40%', paddingLeft: 10 }}>
                      {/* One hue: this is magnitude, not identity. */}
                      <span className="bar-track" aria-hidden="true">
                        <span
                          className="bar-fill"
                          style={{ width: `${Math.max((category.amount / categoryMax) * 100, 2)}%` }}
                        />
                      </span>
                    </td>
                    <td className="num money">{money(category.amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
