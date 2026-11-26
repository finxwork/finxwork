import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SpatialSeries, SpatialVolume } from "@finx/protocol";
import { BrickSource, NODATA, edges, fit, paint, snap, type Dims, type Side, type Vec3, type Window } from "./volume";

// Original slice view (spatial-design §4.2, §13): reads axial slices from BrickSource,
// renders coarse-first when uncached, supports window presets, hover HU/value readout,
// patient-side edge labels, finding ticks with drag-snap, and an SVG overlay for finding circles.

const SIDE_KEYS = { R: "right", L: "left", A: "front", P: "back", S: "head", I: "feet" } as const satisfies Record<Side, string>;

export type SliceCircle = {
  i: number;
  j: number;
  radiusPx: number;
  color: string;
  dashed?: boolean;
};

export type SliceViewProps = {
  volume: SpatialVolume;
  source: BrickSource;
  k: number;
  onSliceChange: (k: number) => void;
  win: Window;
  windows: Window[];
  onWindowChange: (w: Window) => void;
  ticks?: number[];
  circle?: SliceCircle | null;
  patientOrientation?: boolean;
  onCanvasReady?: (canvas: HTMLCanvasElement) => void;
  onCanvasDrawn?: () => void;
};

function SeriesTable({ series, picked, reason }: { series: SpatialSeries[]; picked: string; reason: string }) {
  const { t } = useTranslation("session");
  return (
    <div className="slv-series-pop">
      {reason && <div className="slv-series-reason">{reason}</div>}
      <table>
        <tbody>
          {series.map((s) => (
            <tr key={s.uid} className={s.uid === picked ? "on" : !s.usable ? "off" : ""}>
              <td>{s.description || "—"}</td>
              <td>{t("spatial.slicesCount", { n: s.slices })}</td>
              <td>{s.spacing_mm != null ? `${s.spacing_mm.toFixed(2)} mm` : "—"}</td>
              <td title={s.reason ?? undefined}>
                {s.uid === picked ? t("spatial.seriesShown") : s.reason ?? ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SliceView({
  volume,
  source,
  k,
  onSliceChange,
  win,
  windows,
  onWindowChange,
  ticks = [],
  circle,
  patientOrientation = true,
  onCanvasReady,
  onCanvasDrawn,
}: SliceViewProps) {
  const { t } = useTranslation("session");
  const [w, h, depth] = volume.dims;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readout, setReadout] = useState<string | null>(null);
  const [showSeries, setShowSeries] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shown = useRef<{ k: number; level: number; dims: Dims; values: Int16Array } | null>(null);
  const readyNotified = useRef(false);

  const draw = (values: Int16Array, dims: Dims, level: number, at: number) => {
    const c = canvasRef.current;
    if (!c) return;
    if (!readyNotified.current) {
      readyNotified.current = true;
      onCanvasReady?.(c);
    }
    const [lw, lh] = dims;
    if (c.width !== lw || c.height !== lh) {
      c.width = lw;
      c.height = lh;
    }
    const g = c.getContext("2d")!;
    const img = g.createImageData(lw, lh);
    paint(values, fit(values, win), img.data);
    g.putImageData(img, 0, 0);
    shown.current = { k: at, level, dims, values };
    onCanvasDrawn?.();
  };

  useEffect(() => {
    let live = true;
    setError(null);
    const show = async () => {
      const index = await source.loadIndex();
      if (!live) return;
      const brick = index.brick;
      if (!source.has(0, k, brick) && index.levels.length > 1) {
        const lv1 = index.levels[1];
        const k1 = Math.min(Math.floor(k / 2), lv1.dims[2] - 1);
        const coarse = await source.slice(1, k1);
        if (live && (shown.current?.k !== k || shown.current?.level !== 0)) {
          draw(coarse.values, coarse.dims, 1, k);
        }
      }
      const fine = await source.slice(0, k);
      if (!live) return;
      draw(fine.values, fine.dims, 0, k);
      setReady(true);
      const nextBk = Math.floor(k / brick) + 1;
      if (nextBk * brick < depth) void source.slab(0, nextBk).catch(() => {});
    };
    show().catch((e) => {
      if (live) setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      live = false;
    };
  }, [source, k, win, depth]);

  const move = (to: number) => onSliceChange(Math.max(0, Math.min(depth - 1, Math.round(to))));
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY !== 0) move(k + Math.sign(e.deltaY));
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowUp" || e.key === "PageUp") {
      e.preventDefault();
      move(k - (e.key === "PageUp" ? 10 : 1));
    } else if (e.key === "ArrowDown" || e.key === "PageDown") {
      e.preventDefault();
      move(k + (e.key === "PageDown" ? 10 : 1));
    }
  };

  const onHover = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const s = shown.current;
    const c = canvasRef.current;
    if (!s || !c) return;
    const r = c.getBoundingClientRect();
    const [lw, lh] = s.dims;
    const i = Math.floor(((e.clientX - r.left) / r.width) * lw);
    const j = Math.floor(((e.clientY - r.top) / r.height) * lh);
    if (i < 0 || j < 0 || i >= lw || j >= lh) return setReadout(null);
    const value = s.values[j * lw + i];
    const scale = w / lw;
    const where = `(${Math.floor(i * scale) + 1}, ${Math.floor(j * scale) + 1})`;
    setReadout(value === NODATA ? t("spatial.outside", { where }) : `${where} · ${value}${volume.unit ? ` ${volume.unit}` : ""}`);
  };

  const dir = volume.direction as [Vec3, Vec3, Vec3];
  const side = edges(dir);
  const sideLabel = (s: Side) => (patientOrientation ? `${s} · ${t(`spatial.edge.${SIDE_KEYS[s]}`)}` : s);
  const aspect = (w * volume.spacing[0]) / (h * volume.spacing[1]);
  const pickedSeries = volume.series.find((s) => s.uid === volume.picked);
  const reach = Math.max(1, Math.round(depth * 0.015));

  return (
    <div className="slv" tabIndex={0} onKeyDown={onKeyDown}>
      <div className="slv-bar">
        {volume.series.length > 0 && (
          <button
            className={`btn sm slv-series-btn ${showSeries ? "on" : ""}`}
            onClick={() => setShowSeries((v) => !v)}
            title={volume.reason}
          >
            {pickedSeries?.description || t("spatial.series")} ▾
          </button>
        )}
        <span className="slv-where">{t("spatial.sliceAt", { n: k + 1, of: depth })}</span>
        <span className="spv-gap" />
        <div className="slv-windows" role="group" aria-label={t("spatial.window")}>
          {windows.map((preset) => {
            const on = win.name === preset.name && win.width === preset.width && win.level === preset.level;
            return (
              <button
                key={preset.name}
                className={`btn sm ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => onWindowChange(preset)}
              >
                {preset.name}
              </button>
            );
          })}
        </div>
      </div>

      {showSeries && volume.series.length > 0 && (
        <SeriesTable series={volume.series} picked={volume.picked} reason={volume.reason} />
      )}

      <div className="slv-stage" onWheel={onWheel}>
        <div className="slv-frame" style={{ aspectRatio: `${aspect}`, ["--slv-ar" as string]: `${aspect}` }}>
          <canvas
            ref={canvasRef}
            className="slv-canvas"
            onMouseMove={onHover}
            onMouseLeave={() => setReadout(null)}
          />
          {circle && (
            <svg className="slv-overlay" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
              <circle
                cx={circle.i + 0.5}
                cy={circle.j + 0.5}
                r={Math.max(4, circle.radiusPx)}
                fill="none"
                stroke={circle.color}
                strokeWidth={Math.max(1.5, w / 256)}
                strokeDasharray={circle.dashed ? `${w / 64} ${w / 96}` : undefined}
              />
            </svg>
          )}
          <span className="slv-side l">{sideLabel(side.left)}</span>
          <span className="slv-side r">{sideLabel(side.right)}</span>
          <span className="slv-side t">{sideLabel(side.top)}</span>
          <span className="slv-side b">{sideLabel(side.bottom)}</span>
        </div>
        {!ready && !error && <div className="spv-msg">{t("spatial.sliceLoading")}</div>}
        {error && <div className="spv-msg bad">{t("spatial.sliceFailed", { message: error })}</div>}
        {readout && <div className="slv-readout">{readout}</div>}
      </div>

      <div className="slv-strip">
        <div className="slv-slider-wrap">
          <input
            type="range"
            min={0}
            max={Math.max(0, depth - 1)}
            value={k}
            onChange={(e) => move(snap(Number(e.target.value), ticks, reach))}
            aria-label={t("spatial.sliceSlider")}
          />
          {depth > 1 && ticks.length > 0 && (
            <div className="slv-ticks" aria-hidden="true">
              {ticks.map((tk, idx) => (
                <span key={`${tk}-${idx}`} className="slv-tick" style={{ left: `${(tk / (depth - 1)) * 100}%` }} />
              ))}
            </div>
          )}
        </div>
        <span className="slv-facts">
          {volume.spacing[0].toFixed(2)} × {volume.spacing[2].toFixed(2)} mm
        </span>
      </div>
    </div>
  );
}
