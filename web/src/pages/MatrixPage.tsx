import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type MatrixPoint, type MatrixView } from '../api';

/**
 * The value matrix: is a ticket worth its effort?
 *
 * Every open scored ticket, business score against effort, in four boxes. The
 * one that matters is bottom-right - a lot of effort for little value - and
 * the page is built to make those easy to find and take to a conversation:
 * more justification, or close it. Nothing here decides anything; it rings
 * them round so somebody asks.
 *
 * The two split lines are a judgement call, so they can be dragged. The boxes,
 * counts and lists all follow live; saving makes the new lines everyone's.
 */

type QuadrantId = 'doNext' | 'plan' | 'fitIn' | 'question';

/**
 * Colour carries identity together with position, a legend and labels -
 * never alone. Validated as a set: the red and green pair sits in the CVD
 * warn band, which is legal here only because they occupy opposite corners
 * and every box is named on the chart.
 */
const QUADRANTS: Record<QuadrantId, { name: string; color: string; tagline: string; advice: string }> = {
  doNext: {
    name: 'Do next',
    color: '#1baf7a',
    tagline: 'High value · low effort',
    advice: 'Best return — line these up first.',
  },
  plan: {
    name: 'Plan for',
    color: '#2a78d6',
    tagline: 'High value · high effort',
    advice: 'Worth it, but big — plan it, or split it.',
  },
  fitIn: {
    name: 'Fit in',
    color: '#eda100',
    tagline: 'Low value · low effort',
    advice: 'Cheap — pick up when there is space.',
  },
  question: {
    name: 'Question it',
    color: '#e34948',
    tagline: 'Low value · high effort',
    advice: 'Ask for more justification, or close.',
  },
};

/** Reading order on the page mirrors the chart: top row, then bottom row. */
const GRID_ORDER: QuadrantId[] = ['doNext', 'plan', 'fitIn', 'question'];

function quadrantOf(p: MatrixPoint, valueSplit: number, effortSplit: number): QuadrantId {
  const high = p.businessScore >= valueSplit;
  const heavy = p.effort.total >= effortSplit;
  if (high) return heavy ? 'plan' : 'doNext';
  return heavy ? 'question' : 'fitIn';
}

function ratio(p: MatrixPoint): number {
  return p.businessScore / p.effort.total;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function fmt(n: number | null, dp = 1): string {
  return n === null || !Number.isFinite(n) ? '—' : n.toFixed(dp).replace(/\.0$/, '');
}

function niceCeil(n: number, step: number): number {
  return Math.ceil(n / step) * step;
}

/** The total, with where it came from underneath - for the tables. */
function EffortCell({ p }: { p: MatrixPoint }) {
  const full = effortBreakdown(p);
  const detail = full.includes('(') ? full.slice(full.indexOf('(') + 1, -1) : '';
  return (
    <>
      {p.effort.total}
      {detail ? <span className="matrix-row-summary">{detail}</span> : null}
    </>
  );
}

function effortBreakdown(p: MatrixPoint): string {
  if (p.effort.manual !== null) return `${p.effort.total} (set by hand)`;
  const parts = [
    p.effort.backend ? `BE ${p.effort.backend}` : '',
    p.effort.frontend ? `FE ${p.effort.frontend}` : '',
    p.effort.testingHours ? `Test ${p.effort.testingHours}h = ${p.effort.testing}d` : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${p.effort.total} (${parts.join(' + ')})` : String(p.effort.total);
}

function TicketKey({ k, browse }: { k: string; browse: string }) {
  return browse ? (
    <a href={`${browse}${k}`} target="_blank" rel="noreferrer">
      {k}
    </a>
  ) : (
    <>{k}</>
  );
}

// ---------- The chart ----------

const W = 760;
const H = 500;
const PAD = { top: 26, right: 22, bottom: 46, left: 50 };

interface ChartProps {
  points: MatrixPoint[];
  valueSplit: number;
  effortSplit: number;
  onSplits: (value: number, effort: number) => void;
  bands: { high: number; medium: number };
  focus: QuadrantId | null;
  highlight: string;
  browse: string;
}

interface Group {
  x: number;
  y: number;
  points: MatrixPoint[];
  quadrant: QuadrantId;
}

function MatrixChart({ points, valueSplit, effortSplit, onSplits, bands, focus, highlight, browse }: ChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{
    group: Group;
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = useState<'value' | 'effort' | null>(null);

  const maxEffort = Math.max(0, ...points.map((p) => p.effort.total));
  const maxScore = Math.max(0, ...points.map((p) => p.businessScore));
  const xMax = Math.max(40, niceCeil(maxEffort + 2, 5), niceCeil(effortSplit + 5, 5));
  const yMax = Math.max(70, niceCeil(maxScore + 5, 10), niceCeil(valueSplit + 10, 10));
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const sx = (v: number) => PAD.left + (v / xMax) * plotW;
  const sy = (v: number) => PAD.top + plotH - (v / yMax) * plotH;

  // Tickets on the same spot share one mark with a count - otherwise eight
  // carousel tickets at (8, 46) look like one.
  const groups = useMemo(() => {
    const byXY = new Map<string, Group>();
    for (const p of points) {
      const id = `${p.effort.total}|${p.businessScore}`;
      if (!byXY.has(id)) {
        byXY.set(id, {
          x: p.effort.total,
          y: p.businessScore,
          points: [],
          quadrant: quadrantOf(p, valueSplit, effortSplit),
        });
      }
      byXY.get(id)!.points.push(p);
    }
    return [...byXY.values()];
  }, [points, valueSplit, effortSplit]);

  // Direct labels only where they earn it: the toQuestion tickets, which are
  // the ones somebody needs to act on, and anything searched for. Every
  // other key is a hover away - a key on every dot is noise, and the do-next
  // tickets sit too close together to label without collisions.
  const labelled = useMemo(
    () => new Set(groups.filter((g) => g.quadrant === 'question').map((g) => `${g.x}|${g.y}`)),
    [groups],
  );

  function toData(event: React.PointerEvent): { x: number; y: number } | null {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return null;
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return {
      x: Math.min(xMax, Math.max(0, ((pt.x - PAD.left) / plotW) * xMax)),
      y: Math.min(yMax, Math.max(0, ((PAD.top + plotH - pt.y) / plotH) * yMax)),
    };
  }

  function onMove(event: React.PointerEvent) {
    if (!dragging) return;
    const d = toData(event);
    if (!d) return;
    if (dragging === 'value') onSplits(Math.round(d.y), effortSplit);
    else onSplits(valueSplit, Math.round(d.x));
  }

  function showTip(group: Group, event: React.PointerEvent | React.FocusEvent) {
    const wrap = wrapRef.current?.getBoundingClientRect();
    const target = (event.currentTarget as Element).getBoundingClientRect();
    if (!wrap) return;
    setHover({
      group,
      left: target.left - wrap.left + target.width / 2,
      top: target.top - wrap.top,
    });
  }

  const quadRects: Array<[QuadrantId, number, number, number, number]> = [
    ['doNext', 0, valueSplit, effortSplit, yMax],
    ['plan', effortSplit, valueSplit, xMax, yMax],
    ['fitIn', 0, 0, effortSplit, valueSplit],
    ['question', effortSplit, 0, xMax, valueSplit],
  ];
  const counts = Object.fromEntries(
    GRID_ORDER.map((q) => [q, points.filter((p) => quadrantOf(p, valueSplit, effortSplit) === q).length]),
  ) as Record<QuadrantId, number>;

  const xTicks = Array.from({ length: xMax / 5 + 1 }, (_, i) => i * 5);
  const yTicks = Array.from({ length: yMax / 10 + 1 }, (_, i) => i * 10);
  const q = highlight.trim().toUpperCase();

  // Guide lines for the priority ratio bands: everything above a line has a
  // better value-for-effort than that band's threshold.
  const bandLine = (r: number) => {
    const xEnd = Math.min(xMax, yMax / r);
    return {
      x2: sx(xEnd),
      y2: sy(xEnd * r),
      labelX: sx(xEnd),
      labelY: sy(xEnd * r),
    };
  };

  return (
    <div className="matrix-chart" ref={wrapRef}>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Business score against effort for ${points.length} tickets. ${GRID_ORDER.map((id) => `${QUADRANTS[id].name}: ${counts[id]}`).join(', ')}.`}
        onPointerMove={onMove}
        onPointerUp={() => setDragging(null)}
        onPointerLeave={() => {
          setDragging(null);
          setHover(null);
        }}
        className={dragging ? 'is-dragging' : undefined}
      >
        <defs>
          <filter id="mx-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {quadRects.map(([id, x0, y0, x1, y1]) => (
          <rect
            key={id}
            x={sx(x0)}
            y={sy(y1)}
            width={Math.max(0, sx(x1) - sx(x0))}
            height={Math.max(0, sy(y0) - sy(y1))}
            fill={QUADRANTS[id].color}
            className={`matrix-zone ${focus && focus !== id ? 'is-dim' : ''}`}
          />
        ))}

        {/* Recessive grid */}
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line x1={sx(t)} x2={sx(t)} y1={PAD.top} y2={PAD.top + plotH} className="matrix-grid" />
            <text x={sx(t)} y={PAD.top + plotH + 16} textAnchor="middle" className="matrix-tick">
              {t}
            </text>
          </g>
        ))}
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={sy(t)} y2={sy(t)} className="matrix-grid" />
            <text x={PAD.left - 8} y={sy(t) + 4} textAnchor="end" className="matrix-tick">
              {t}
            </text>
          </g>
        ))}
        <text x={PAD.left + plotW / 2} y={H - 6} textAnchor="middle" className="matrix-axis-title">
          Effort (days) →
        </text>
        <text
          transform={`translate(14 ${PAD.top + plotH / 2}) rotate(-90)`}
          textAnchor="middle"
          className="matrix-axis-title"
        >
          Business score →
        </text>

        {/* Zone names, in the outer corner of each box */}
        {(
          [
            ['doNext', sx(0) + 10, sy(yMax) + 20, 'start'],
            ['plan', sx(xMax) - 10, sy(yMax) + 20, 'end'],
            ['fitIn', sx(0) + 10, sy(0) - 12, 'start'],
            ['question', sx(xMax) - 10, sy(0) - 12, 'end'],
          ] as Array<[QuadrantId, number, number, 'start' | 'end']>
        ).map(([id, x, y, anchor]) => (
          <text
            key={id}
            x={x}
            y={y}
            textAnchor={anchor}
            className={`matrix-zone-label ${focus && focus !== id ? 'is-dim' : ''}`}
          >
            {QUADRANTS[id].name} · {counts[id]}
          </text>
        ))}

        {/* Priority ratio guides */}
        {[
          [bands.high, 'High priority'],
          [bands.medium, 'Medium'],
        ].map(([r, label]) => {
          const l = bandLine(r as number);
          return (
            <g key={label as string} className="matrix-band">
              <line x1={sx(0)} y1={sy(0)} x2={l.x2} y2={l.y2} />
              <text x={l.labelX - 4} y={l.labelY + 14} textAnchor="end">
                {label} ratio {r}
              </text>
            </g>
          );
        })}

        {/* The two split lines - drag to move */}
        <g className="matrix-split">
          <line x1={sx(effortSplit)} x2={sx(effortSplit)} y1={PAD.top} y2={PAD.top + plotH} />
          <line x1={PAD.left} x2={PAD.left + plotW} y1={sy(valueSplit)} y2={sy(valueSplit)} />
          <line
            x1={sx(effortSplit)}
            x2={sx(effortSplit)}
            y1={PAD.top}
            y2={PAD.top + plotH}
            className="matrix-split-hit vertical"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDragging('effort');
            }}
          />
          <line
            x1={PAD.left}
            x2={PAD.left + plotW}
            y1={sy(valueSplit)}
            y2={sy(valueSplit)}
            className="matrix-split-hit horizontal"
            onPointerDown={(e) => {
              (e.target as Element).setPointerCapture?.(e.pointerId);
              setDragging('value');
            }}
          />
          <g transform={`translate(${sx(effortSplit)} ${PAD.top + 2})`} className="matrix-handle">
            <rect x={-18} y={-11} width={36} height={22} rx={11} />
            <text y={4} textAnchor="middle">
              {effortSplit}
            </text>
          </g>
          <g transform={`translate(${PAD.left} ${sy(valueSplit)})`} className="matrix-handle">
            <rect x={-18} y={-11} width={36} height={22} rx={11} />
            <text y={4} textAnchor="middle">
              {valueSplit}
            </text>
          </g>
        </g>

        {/* The tickets */}
        {groups.map((g, i) => {
          const id = `${g.x}|${g.y}`;
          const matches = q && g.points.some((p) => p.key.toUpperCase().includes(q));
          const dim = (focus && focus !== g.quadrant) || (q && !matches);
          const r = g.points.length > 1 ? 7 + Math.min(4, g.points.length) : 6;
          return (
            <g
              key={id}
              className={`matrix-dot ${dim ? 'is-dim' : ''} ${matches ? 'is-match' : ''}`}
              style={{ animationDelay: `${Math.min(i * 12, 600)}ms` }}
              tabIndex={0}
              role="button"
              aria-label={`${g.points.map((p) => p.key).join(', ')}: score ${g.y}, effort ${g.x}, ${QUADRANTS[g.quadrant].name}`}
              onPointerEnter={(e) => showTip(g, e)}
              onPointerLeave={() => setHover(null)}
              onFocus={(e) => showTip(g, e)}
              onBlur={() => setHover(null)}
            >
              {/* Hit target well beyond the painted mark */}
              <circle cx={sx(g.x)} cy={sy(g.y)} r={14} fill="transparent" />
              {matches ? (
                <circle cx={sx(g.x)} cy={sy(g.y)} r={r + 6} className="matrix-match-ring" filter="url(#mx-glow)" />
              ) : null}
              <circle cx={sx(g.x)} cy={sy(g.y)} r={r} fill={QUADRANTS[g.quadrant].color} className="matrix-dot-mark" />
              {g.points.length > 1 ? (
                <text x={sx(g.x)} y={sy(g.y) + 3.5} textAnchor="middle" className="matrix-dot-count">
                  {g.points.length}
                </text>
              ) : null}
              {labelled.has(id) || matches ? (
                <text x={sx(g.x) + r + 5} y={sy(g.y) + 4} className="matrix-dot-label">
                  {g.points.length > 1 ? `${g.points[0].key} +${g.points.length - 1}` : g.points[0].key}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>

      {hover ? (
        <div
          className="matrix-tip"
          style={{ left: hover.left, top: hover.top }}
          role="tooltip"
          onPointerEnter={() => setHover(hover)}
        >
          <div className="matrix-tip-head">
            <span className="matrix-swatch" style={{ background: QUADRANTS[hover.group.quadrant].color }} />
            {QUADRANTS[hover.group.quadrant].name}
          </div>
          {hover.group.points.slice(0, 5).map((p) => (
            <div key={p.key} className="matrix-tip-row">
              <strong>
                <TicketKey k={p.key} browse={browse} />
              </strong>{' '}
              <span className="matrix-tip-summary">{p.summary}</span>
              <span className="matrix-tip-stats">
                Score <b>{p.businessScore}</b> · Effort <b>{effortBreakdown(p)}</b> · Ratio <b>{fmt(ratio(p))}</b>
                {p.status ? ` · ${p.status}` : ''}
              </span>
            </div>
          ))}
          {hover.group.points.length > 5 ? <div className="hint">and {hover.group.points.length - 5} more</div> : null}
        </div>
      ) : null}
    </div>
  );
}

// ---------- Where the effort goes ----------

function ShareBars({ points, quadrantFor }: { points: MatrixPoint[]; quadrantFor: (p: MatrixPoint) => QuadrantId }) {
  const totalEffort = points.reduce((n, p) => n + p.effort.total, 0) || 1;
  const totalValue = points.reduce((n, p) => n + p.businessScore, 0) || 1;
  const order: QuadrantId[] = ['doNext', 'plan', 'fitIn', 'question'];
  const share = (key: 'effort' | 'value', id: QuadrantId) => {
    const pts = points.filter((p) => quadrantFor(p) === id);
    return key === 'effort'
      ? pts.reduce((n, p) => n + p.effort.total, 0) / totalEffort
      : pts.reduce((n, p) => n + p.businessScore, 0) / totalValue;
  };
  const rows: Array<['effort' | 'value', string]> = [
    ['effort', 'Share of effort'],
    ['value', 'Share of value'],
  ];
  const questionEffort = share('effort', 'question');
  const questionValue = share('value', 'question');
  const doNextEffort = share('effort', 'doNext');
  const doNextValue = share('value', 'doNext');

  return (
    <div className="card matrix-shares">
      <h2>Where the effort goes</h2>
      <p className="matrix-insight">
        Tickets to question take <strong>{Math.round(questionEffort * 100)}%</strong> of the estimated effort for{' '}
        <strong>{Math.round(questionValue * 100)}%</strong> of the value. “Do next” tickets deliver{' '}
        <strong>{Math.round(doNextValue * 100)}%</strong> of the value for{' '}
        <strong>{Math.round(doNextEffort * 100)}%</strong> of the effort.
      </p>
      {rows.map(([key, label]) => (
        <div key={key} className="matrix-share-row">
          <span className="matrix-share-label">{label}</span>
          <div
            className="matrix-share-bar"
            role="img"
            aria-label={`${label}: ${order.map((id) => `${QUADRANTS[id].name} ${Math.round(share(key, id) * 100)}%`).join(', ')}`}
          >
            {order.map((id) => {
              const s = share(key, id);
              return s > 0 ? (
                <span
                  key={id}
                  style={{ flexGrow: s, background: QUADRANTS[id].color }}
                  title={`${QUADRANTS[id].name}: ${Math.round(s * 100)}%`}
                >
                  {s >= 0.09 ? `${Math.round(s * 100)}%` : ''}
                </span>
              ) : null;
            })}
          </div>
        </div>
      ))}
      <ul className="matrix-legend" aria-hidden="true">
        {order.map((id) => (
          <li key={id}>
            <span className="matrix-swatch" style={{ background: QUADRANTS[id].color }} /> {QUADRANTS[id].name}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- The page ----------

export function MatrixPage() {
  const [view, setView] = useState<MatrixView | null>(null);
  const [error, setError] = useState('');
  const [valueSplit, setValueSplit] = useState(50);
  const [effortSplit, setEffortSplit] = useState(20);
  const [focus, setFocus] = useState<QuadrantId | null>(null);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api
      .matrix()
      .then((v) => {
        setView(v);
        setValueSplit(v.splits.value);
        setEffortSplit(v.splits.effort);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load the matrix'));
  }, []);

  if (error) return <p className="status error">{error}</p>;
  if (!view) return <p>Loading…</p>;

  const points = view.points;
  const quadrantFor = (p: MatrixPoint) => quadrantOf(p, valueSplit, effortSplit);
  const inQuad = (id: QuadrantId) => points.filter((p) => quadrantFor(p) === id);
  const moved = valueSplit !== view.splits.value || effortSplit !== view.splits.effort;
  const toQuestion = inQuad('question').sort((a, b) => ratio(a) - ratio(b));
  const doNext = inQuad('doNext');
  const medianRatio = median(points.map(ratio));
  const totalEffort = points.reduce((n, p) => n + p.effort.total, 0);
  const questionEffort = toQuestion.reduce((n, p) => n + p.effort.total, 0);
  // Within a few points of a line: a small re-estimate or score change moves them.
  const borderline = points.filter(
    (p) => Math.abs(p.businessScore - valueSplit) <= 3 || Math.abs(p.effort.total - effortSplit) <= 2,
  );

  async function saveSplits() {
    setSaving(true);
    setMessage('');
    try {
      await api.saveConfig('matrix', { valueSplit, effortSplit });
      setView((v) => (v ? { ...v, splits: { value: valueSplit, effort: effortSplit } } : v));
      setMessage('Saved — these lines are now the default for everyone.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  async function copyKeys() {
    const jql = `key in (${toQuestion.map((p) => p.key).join(', ')})`;
    try {
      await navigator.clipboard.writeText(jql);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this JQL', jql);
    }
  }

  return (
    <div className="matrix-page">
      <section className="matrix-hero">
        <div className="matrix-hero-text">
          <p className="matrix-eyebrow">Value matrix</p>
          <h1>Is it worth the effort?</h1>
          <p>
            Every scored ticket waiting to be built, business score against effort. Bottom-right is where effort goes in for little
            back — those are the ones to question.
          </p>
        </div>
        <div className="matrix-kpis">
          <div className="matrix-kpi">
            <span className="matrix-kpi-value">{points.length}</span>
            <span className="matrix-kpi-label">tickets placed</span>
            {view.unestimated.length ? (
              <span className="matrix-kpi-sub">+{view.unestimated.length} waiting for effort</span>
            ) : null}
          </div>
          <div className="matrix-kpi">
            <span className="matrix-kpi-value" style={{ color: '#5fd3a6' }}>
              {doNext.length}
            </span>
            <span className="matrix-kpi-label">to do next</span>
            <span className="matrix-kpi-sub">
              {points.length ? Math.round((doNext.length / points.length) * 100) : 0}% of tickets
            </span>
          </div>
          <div className="matrix-kpi">
            <span className="matrix-kpi-value" style={{ color: '#ff8a89' }}>
              {toQuestion.length}
            </span>
            <span className="matrix-kpi-label">to question</span>
            <span className="matrix-kpi-sub">
              {totalEffort ? Math.round((questionEffort / totalEffort) * 100) : 0}% of all effort
            </span>
          </div>
          <div className="matrix-kpi">
            <span className="matrix-kpi-value">{fmt(medianRatio)}</span>
            <span className="matrix-kpi-label">median value ratio</span>
            <span className="matrix-kpi-sub">score ÷ effort</span>
          </div>
        </div>
      </section>

      {view.sourceNote ? <div className="notice">{view.sourceNote}</div> : null}

      {!points.length ? (
        <div className="notice">
          No scored tickets with an effort estimate yet. They appear here as soon as a ticket has both.
        </div>
      ) : (
        <>
          <div className="matrix-toolbar">
            <div className="field">
              <label htmlFor="matrix-find">Find a ticket</label>
              <input
                id="matrix-find"
                type="text"
                placeholder="e.g. ECOM-1705"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="matrix-value">High value from</label>
              <input
                id="matrix-value"
                type="number"
                min={0}
                value={valueSplit}
                onChange={(e) => setValueSplit(Number(e.target.value))}
              />
            </div>
            <div className="field">
              <label htmlFor="matrix-effort">High effort from</label>
              <input
                id="matrix-effort"
                type="number"
                min={0}
                value={effortSplit}
                onChange={(e) => setEffortSplit(Number(e.target.value))}
              />
            </div>
            {moved ? (
              <div className="matrix-save">
                <button type="button" onClick={saveSplits} disabled={saving}>
                  {saving ? 'Saving…' : 'Save these lines'}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setValueSplit(view.splits.value);
                    setEffortSplit(view.splits.effort);
                  }}
                >
                  Reset
                </button>
              </div>
            ) : (
              <p className="hint matrix-drag-hint">Drag either line on the chart to see what changes.</p>
            )}
          </div>
          {message ? <p className="status">{message}</p> : null}

          <div className="matrix-main">
            <div className="card matrix-chart-card">
              <div className="matrix-chart-scroll">
                <MatrixChart
                  points={points}
                  valueSplit={valueSplit}
                  effortSplit={effortSplit}
                  onSplits={(v, e) => {
                    setValueSplit(v);
                    setEffortSplit(e);
                  }}
                  bands={view.priorityBands}
                  focus={focus}
                  highlight={search}
                  browse={view.jiraBrowseUrl}
                />
              </div>
              <p className="hint" style={{ margin: '0.4rem 0 0' }}>
                Effort is in days:{' '}
                {view.testingIncluded
                  ? `the poker estimates plus testing, converted from hours at ${view.testingHoursPerDay} hours a day.`
                  : 'the poker estimates.'}
                Dashed lines are the priority ratio bands from Settings — above a line is better value for the effort.
                Numbers in a dot are tickets on the same spot.
              </p>
            </div>

            <div className="matrix-quads">
              {GRID_ORDER.map((id) => {
                const qs = inQuad(id);
                const avg = (f: (p: MatrixPoint) => number) =>
                  qs.length ? qs.reduce((n, p) => n + f(p), 0) / qs.length : null;
                return (
                  <button
                    key={id}
                    type="button"
                    className={`matrix-quad ${focus === id ? 'is-active' : ''}`}
                    style={{ ['--quad' as string]: QUADRANTS[id].color }}
                    aria-pressed={focus === id}
                    onClick={() => setFocus(focus === id ? null : id)}
                  >
                    <span className="matrix-quad-top">
                      <span className="matrix-quad-num" aria-hidden="true" />
                      <span className="matrix-quad-name">{QUADRANTS[id].name}</span>
                    </span>
                    <span className="matrix-quad-count">{qs.length}</span>
                    <span className="matrix-quad-tag">{QUADRANTS[id].tagline}</span>
                    <span className="matrix-quad-stats">
                      Avg score{' '}
                      {fmt(
                        avg((p) => p.businessScore),
                        0,
                      )}{' '}
                      · effort{' '}
                      {fmt(
                        avg((p) => p.effort.total),
                        0,
                      )}
                    </span>
                    <span className="matrix-quad-advice">{QUADRANTS[id].advice}</span>
                  </button>
                );
              })}
              <p className="hint" style={{ gridColumn: '1 / -1', margin: 0 }}>
                Click a box to pick it out on the chart.
              </p>
            </div>
          </div>

          <div className="matrix-lower">
            <div className="card matrix-review">
              <div className="row between" style={{ alignItems: 'baseline', gap: '0.5rem' }}>
                <h2>
                  <span className="matrix-swatch" style={{ background: QUADRANTS.question.color }} /> Needs a
                  conversation
                </h2>
                {toQuestion.length ? (
                  <button type="button" className="secondary" onClick={copyKeys}>
                    {copied ? 'Copied ✓' : 'Copy as JQL'}
                  </button>
                ) : null}
              </div>
              <p className="hint" style={{ marginTop: 0 }}>
                Low value for high effort, worst value-for-effort first. Ask for more justification — and if there is
                none, it is a candidate to close.
              </p>
              {toQuestion.length ? (
                <div className="table-scroll">
                  <table>
                    <caption className="visually-hidden">Tickets to question</caption>
                    <thead>
                      <tr>
                        <th scope="col">Ticket</th>
                        <th scope="col" className="num">
                          Score
                        </th>
                        <th scope="col" className="num">
                          Effort
                        </th>
                        <th scope="col" className="num">
                          Ratio
                        </th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {toQuestion.map((p) => (
                        <tr key={p.key}>
                          <td>
                            <strong>
                              <TicketKey k={p.key} browse={view.jiraBrowseUrl} />
                            </strong>
                            <span className="matrix-row-summary">{p.summary}</span>
                          </td>
                          <td className="num">{p.businessScore}</td>
                          <td className="num">
                            <EffortCell p={p} />
                          </td>
                          <td className="num">
                            <strong>{fmt(ratio(p))}</strong>
                          </td>
                          <td>{p.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>Nothing in this box with the lines where they are. 🎉</p>
              )}
            </div>

            <div className="matrix-side">
              <ShareBars points={points} quadrantFor={quadrantFor} />
              <div className="card">
                <h2>Close to a line</h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  Within 3 points of the value line or 2 of the effort line — a re-estimate or the weekly score
                  acceleration could move these into another box.
                </p>
                {borderline.length ? (
                  <ul className="matrix-chips">
                    {borderline.map((p) => (
                      <li key={p.key}>
                        <button type="button" className="matrix-chip" onClick={() => setSearch(p.key)}>
                          <span
                            className="matrix-swatch"
                            style={{
                              background: QUADRANTS[quadrantFor(p)].color,
                            }}
                          />
                          {p.key}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="hint">None at the moment.</p>
                )}
              </div>
              {view.unestimated.length ? (
                <div className="card">
                  <h2>Waiting for effort</h2>
                  <p className="hint" style={{ marginTop: 0 }}>
                    Scored, but no estimate yet, so they cannot be placed.
                  </p>
                  <ul className="matrix-chips">
                    {view.unestimated.map((u) => (
                      <li key={u.key}>
                        <span className="matrix-chip is-static" title={`${u.summary} — score ${u.businessScore}`}>
                          <TicketKey k={u.key} browse={view.jiraBrowseUrl} /> · {u.businessScore}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>

          <details className="card matrix-table">
            <summary>
              <strong>All {points.length} tickets as a table</strong>
            </summary>
            <div className="table-scroll">
              <table>
                <caption className="visually-hidden">Every ticket on the matrix</caption>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Box</th>
                    <th scope="col" className="num">
                      Score
                    </th>
                    <th scope="col" className="num">
                      Effort
                    </th>
                    <th scope="col" className="num">
                      Ratio
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...points]
                    .sort((a, b) => ratio(b) - ratio(a))
                    .map((p) => (
                      <tr key={p.key}>
                        <td>
                          <strong>
                            <TicketKey k={p.key} browse={view.jiraBrowseUrl} />
                          </strong>
                          <span className="matrix-row-summary">{p.summary}</span>
                        </td>
                        <td>
                          <span
                            className="matrix-swatch"
                            style={{
                              background: QUADRANTS[quadrantFor(p)].color,
                            }}
                          />{' '}
                          {QUADRANTS[quadrantFor(p)].name}
                        </td>
                        <td className="num">{p.businessScore}</td>
                        <td className="num">
                          <EffortCell p={p} />
                        </td>
                        <td className="num">{fmt(ratio(p))}</td>
                        <td>{p.status}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </details>
          <p className="hint">
            {view.source === 'jira' ? 'Read live from JIRA' : 'From the app'} at{' '}
            {new Date(view.fetchedAt).toLocaleTimeString('en-GB', {
              hour: '2-digit',
              minute: '2-digit',
            })}
            .
          </p>
        </>
      )}
    </div>
  );
}
