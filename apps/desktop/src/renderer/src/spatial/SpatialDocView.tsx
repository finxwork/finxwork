import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { baseName, type RpcClient } from "@finx/client";
import type { SpatialFinding } from "@finx/protocol";
import { docAttachment } from "../composer/attachments";
import { toComposer } from "../composer/inbox";
import type { DocAnchor, DocTab, Jump } from "../docs/state";
import { usePanelWidth } from "../panelWidth";
import { FindingsList } from "./FindingsList";
import { partQuote, sealFindings, sizeLabel, type Finding, type PartInfo } from "./model";
import type { Axis, Viewer, ViewName } from "./scene";
import { SliceView, type SliceCircle } from "./SliceView";
import { BrickSource, sliceAt, slicePlane, toVoxel, windowsOf, type Dims, type Geometry, type Vec3, type Window } from "./volume";
import "./spatial.css";

const SOURCE_COLOR: Record<Finding["source"], string> = { reference: "#6aa7ff", ai: "#f59e0b", user: "#6fd97a" };
const SIDE_MIN_WIDTH = 240;
const CANVAS_MIN_ROOM = 220;

export default function SpatialDocView({ rpc, session, tab, jump }: { rpc: RpcClient; session: string; tab: DocTab; jump: Jump | null }) {
  const { t } = useTranslation("session");
  const side = usePanelWidth("finxwork.spatialSideWidth", () => CANVAS_MIN_ROOM, SIDE_MIN_WIDTH);
  const spatial = tab.info.spatial;
  const volume = spatial?.volume ?? null;
  const geom = useMemo<Geometry | null>(
    () =>
      volume
        ? {
            dims: volume.dims as Dims,
            spacing: volume.spacing as Vec3,
            origin: volume.origin as Vec3,
            direction: volume.direction as [Vec3, Vec3, Vec3],
          }
        : null,
    [volume],
  );
  const source = useMemo(() => (volume ? new BrickSource(`finxdoc://${tab.token}`) : null), [tab.token, !!volume]);
  const windows = useMemo(() => windowsOf(spatial?.profile?.windows, t("spatial.defaultWindow")), [spatial?.profile?.windows, t]);

  const [k, setK] = useState(() => (volume ? Math.floor(volume.dims[2] / 2) : 0));
  const [win, setWin] = useState<Window>(() => windows[0]);
  useEffect(() => {
    setWin((prev) => windows.find((w) => w.name === prev.name && w.width === prev.width && w.level === prev.level) ?? windows[0]);
  }, [windows]);

  // A skill that is off and says it helps with volumes (`metadata.suggest-for`): offer to turn it on.
  const [suggested, setSuggested] = useState<{ dir: string; name: string } | null>(null);
  const [enablingSkill, setEnablingSkill] = useState(false);
  useEffect(() => {
    if (spatial?.kind !== "volume") return;
    let gone = false;
    void rpc
      .request("skills/list", {})
      .then((res) => {
        if (gone) return;
        const skill = res.skills.find((s) => s.state === "disabled" && s.suggest_for?.includes("spatial-volume"));
        setSuggested(skill ? { dir: skill.path.replace(/[\\/]SKILL\.md$/i, ""), name: skill.name } : null);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [rpc, spatial?.kind]);

  const enableSuggested = () => {
    if (!suggested || enablingSkill) return;
    setEnablingSkill(true);
    void rpc
      .request("skills/set_enabled", { path: suggested.dir, enabled: true })
      .then(() => setSuggested(null))
      .finally(() => setEnablingSkill(false));
  };

  const has3d = (spatial?.meshes.length ?? 0) > 0 || (spatial?.structures.length ?? 0) > 0;
  const host = useRef<HTMLDivElement>(null);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [parts, setParts] = useState<PartInfo[]>([]);
  const [selected, setSelected] = useState<PartInfo | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);
  const [axis, setAxis] = useState<Axis>(2);
  const [cut, setCut] = useState<number | null>(null);
  const [focusedFinding, setFocusedFinding] = useState<string | null>(null);
  const [sliceFindingId, setSliceFindingId] = useState<string | null>(null);
  const [sliceCanvas, setSliceCanvas] = useState<HTMLCanvasElement | null>(null);
  // The parts panel floats over the 3D view; collapsed it is one small button.
  const [layersOpen, setLayersOpen] = useState(true);

  const geomRef = useRef(geom);
  geomRef.current = geom;

  // Lazy-load three.js Viewer only when there is 3D geometry/structures to show.
  useEffect(() => {
    if (!has3d) return;
    let v: Viewer | null = null;
    let gone = false;
    setViewerError(null);
    void (async () => {
      try {
        const { Viewer } = await import("./scene");
        if (gone || !host.current) return;
        v = new Viewer(host.current, {
          parts: setParts,
          select: setSelected,
          hover: setHover,
          point: (at) => {
            if (geomRef.current) setK(sliceAt(geomRef.current, at));
          },
        });
        if (!gone) setViewer(v);
      } catch (e) {
        if (!gone) setViewerError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      gone = true;
      v?.dispose();
      setViewer(null);
      setParts([]);
      setSelected(null);
    };
  }, [has3d, tab.info.doc_id]);

  // Orientation: patient (LPS) vs generic XYZ.
  useEffect(() => {
    viewer?.setOrientation(spatial?.profile?.orientation === "patient");
  }, [viewer, spatial?.profile?.orientation]);

  // Fetch meshes incrementally as they appear in DocInfo.spatial.meshes.
  const fetchedMeshes = useRef(new Set<string>());
  useEffect(() => {
    fetchedMeshes.current.clear();
  }, [tab.token, tab.info.doc_id]);

  useEffect(() => {
    if (!viewer || !spatial) return;
    let gone = false;
    for (const m of spatial.meshes) {
      if (viewer.hasMesh(m.id) || fetchedMeshes.current.has(m.id)) continue;
      fetchedMeshes.current.add(m.id);
      void fetch(`finxdoc://${tab.token}/spatial/mesh/${encodeURIComponent(m.id)}/0.bin`)
        .then(async (r) => {
          if (!r.ok) throw new Error(`mesh ${m.id}: ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => {
          if (!gone && !viewer.hasMesh(m.id)) {
            viewer.addMesh({ key: m.id, name: m.name, color: m.color, opacity: m.opacity, data });
          }
        })
        .catch(() => {
          fetchedMeshes.current.delete(m.id);
        });
    }
    return () => {
      gone = true;
    };
  }, [viewer, spatial?.meshes, tab.token]);

  // Findings in 3D + flash newly arrived findings without stealing camera.
  const sealedFindings = useMemo(() => {
    const raw: Finding[] = (spatial?.findings ?? [])
      .filter((f): f is SpatialFinding & { position_mm: [number, number, number] } => Array.isArray(f.position_mm) && f.position_mm.length === 3)
      .map((f) => ({
        id: f.id,
        position: [f.position_mm[0], f.position_mm[1], f.position_mm[2]] as const,
        radius: f.radius_mm ?? 0,
        source: f.source,
        label: f.name,
      }));
    return sealFindings(raw);
  }, [spatial?.findings]);

  const seenFindings = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!viewer) return;
    viewer.setFindings(sealedFindings);
    const current = new Set(sealedFindings.map((f) => f.id));
    if (seenFindings.current !== null) {
      for (const id of current) {
        if (!seenFindings.current.has(id)) viewer.flash(id);
      }
    }
    seenFindings.current = current;
  }, [viewer, sealedFindings]);

  // Keep the 3D slice plane synced with k and the SliceView canvas.
  useEffect(() => {
    if (!viewer || !geom) {
      viewer?.setSlice(null);
      return;
    }
    const sp = slicePlane(geom, k);
    viewer.setSlice({
      origin: sp.origin,
      normal: [0, 0, 1],
      axes: [sp.u, sp.v],
      size: sp.size,
      texture: sliceCanvas ?? undefined,
    });
  }, [viewer, geom, k, sliceCanvas]);

  const handleCanvasDrawn = useCallback(() => {
    viewer?.touchSlice();
  }, [viewer]);

  useEffect(() => {
    viewer?.setClip(axis, cut);
  }, [viewer, axis, cut]);

  // Apply an anchor (from spatial/view event or doc jump).
  const applyAnchor = useCallback(
    (anchor: DocAnchor) => {
      if (anchor.kind === "spatial_view") {
        if (anchor.camera && viewer) {
          viewer.setCamera(anchor.camera.position, anchor.camera.target, anchor.camera.up);
        }
        if (anchor.slice && geom) {
          setK(Math.max(0, Math.min(geom.dims[2] - 1, anchor.slice.index)));
        }
      } else if (anchor.kind === "spatial_slice" && geom) {
        setK(Math.max(0, Math.min(geom.dims[2] - 1, anchor.index)));
      } else if (anchor.kind === "spatial_point") {
        if (anchor.position_mm.length === 3) {
          viewer?.focus(anchor.position_mm);
          if (geom) setK(sliceAt(geom, anchor.position_mm));
        }
      } else if (anchor.kind === "spatial_finding") {
        const f = spatial?.findings.find((x) => x.id === anchor.id);
        setFocusedFinding(anchor.id);
        viewer?.highlight(anchor.id);
        if (f?.position_mm?.length === 3) {
          viewer?.focus(f.position_mm, f.radius_mm ?? 20);
          if (geom) setK(sliceAt(geom, f.position_mm));
          setSliceFindingId(f.id);
        } else if (f?.view?.camera) {
          viewer?.setCamera(f.view.camera.position, f.view.camera.target, f.view.camera.up);
        }
      } else if (anchor.kind === "spatial_part" && viewer) {
        const match = parts.find((p) => p.key === anchor.id || p.name === anchor.id);
        if (match) viewer.select(match.id);
      }
    },
    [viewer, geom, spatial?.findings, parts],
  );

  useEffect(() => {
    return rpc.on("spatial/view", (p) => {
      if (p.doc_id === tab.info.doc_id) applyAnchor(p.target);
    });
  }, [rpc, tab.info.doc_id, applyAnchor]);

  useEffect(() => {
    if (jump && jump.doc_id === tab.info.doc_id) applyAnchor(jump.anchor);
  }, [jump, tab.info.doc_id, applyAnchor]);

  // Finding card actions.
  const locateFinding = (f: SpatialFinding) => {
    if (focusedFinding === f.id) {
      setFocusedFinding(null);
      viewer?.highlight(null);
      return;
    }
    setFocusedFinding(f.id);
    viewer?.highlight(f.id);
    if (f.position_mm?.length === 3) {
      viewer?.focus(f.position_mm, f.radius_mm ?? 20);
    } else if (f.view?.camera) {
      viewer?.setCamera(f.view.camera.position, f.view.camera.target, f.view.camera.up);
    }
  };

  const viewFindingSlice = (f: SpatialFinding) => {
    if (!geom) return;
    const targetK = f.view?.slice ? f.view.slice.index : f.position_mm?.length === 3 ? sliceAt(geom, f.position_mm) : null;
    if (targetK !== null) {
      setK(Math.max(0, Math.min(geom.dims[2] - 1, targetK)));
      setSliceFindingId(f.id);
    }
  };

  const askFinding = (f: SpatialFinding) => {
    const text = [t("spatial.quotePrefix"), baseName(tab.info.path), f.name, f.summary].filter(Boolean).join(" · ");
    toComposer(session, [docAttachment({ path: tab.info.path, doc_id: tab.info.doc_id, text })]);
  };

  const quotePart = (p: PartInfo) => {
    const text = partQuote(t("spatial.quotePrefix"), baseName(tab.info.path), p.name, p.size);
    toComposer(session, [docAttachment({ path: tab.info.path, doc_id: tab.info.doc_id, text })]);
  };

  // Slice ticks and active finding circle on SliceView.
  const findingTicks = useMemo(() => {
    if (!geom || !spatial?.findings.length) return [];
    const out: number[] = [];
    for (const f of spatial.findings) {
      if (f.view?.slice) out.push(f.view.slice.index);
      else if (f.position_mm?.length === 3) out.push(sliceAt(geom, f.position_mm));
    }
    return out;
  }, [geom, spatial?.findings]);

  const sliceCircle = useMemo<SliceCircle | null>(() => {
    if (!geom || !sliceFindingId || !spatial?.findings.length) return null;
    const f = spatial.findings.find((x) => x.id === sliceFindingId);
    if (!f?.position_mm || f.position_mm.length !== 3) return null;
    const fk = sliceAt(geom, f.position_mm);
    if (Math.abs(fk - k) > 1) return null;
    const [vi, vj] = toVoxel(geom, f.position_mm);
    const radiusPx = Math.max(6, (f.radius_mm ?? 6) / Math.max(geom.spacing[0], 0.1));
    return { i: vi, j: vj, radiusPx, color: SOURCE_COLOR[f.source], dashed: f.source === "ai" };
  }, [geom, sliceFindingId, spatial?.findings, k]);

  const views: [ViewName, string][] = [
    ["front", t("spatial.front")],
    ["side", t("spatial.side")],
    ["top", t("spatial.top")],
    ["reset", t("spatial.reset")],
  ];

  const hasAiFinding = (spatial?.findings ?? []).some((f) => f.source === "ai");
  const hasSide = Boolean(volume || (spatial?.findings.length ?? 0) > 0);
  const meshIds = new Set((spatial?.meshes ?? []).map((m) => m.id));
  // Hidden structures (helpers a script builds other parts from) have no surface: never pending.
  const pendingStructures = (spatial?.structures ?? []).filter((s) => !s.hidden && !meshIds.has(s.id));

  if (!spatial) {
    return <div className="spv"><div className="spv-msg">{t("spatial.loading")}</div></div>;
  }

  return (
    <div className="spv">
      {suggested && (
        <div className="spv-skill-banner">
          <span>{t("spatial.enableSkillHint", { name: suggested.name })}</span>
          <button className="btn sm on" disabled={enablingSkill} onClick={enableSuggested}>
            {t("spatial.enableSkill")}
          </button>
        </div>
      )}

      {has3d && (
        <div className="spv-bar">
          {views.map(([v, label]) => (
            <button key={v} className="btn sm" disabled={!viewer} onClick={() => viewer?.view(v)}>
              {label}
            </button>
          ))}
          <span className="spv-gap" />
          <label className="spv-cut" title={t("spatial.clipHint")}>
            <input type="checkbox" checked={cut !== null} disabled={!viewer} onChange={(e) => setCut(e.target.checked ? 0.5 : null)} />
            {t("spatial.clip")}
            <select value={axis} disabled={cut === null} onChange={(e) => setAxis(Number(e.target.value) as Axis)} aria-label={t("spatial.clipAxis")}>
              <option value={0}>X</option>
              <option value={1}>Y</option>
              <option value={2}>Z</option>
            </select>
            <input type="range" min={0} max={1} step={0.005} value={cut ?? 1} disabled={cut === null} onChange={(e) => setCut(Number(e.target.value))} aria-label={t("spatial.clipAt")} />
          </label>
        </div>
      )}

      <div className={`spv-body ${side.resizing ? "resizing" : ""}`}>
        {has3d && (
          <div className="spv-canvas" ref={host}>
            {!viewer && !viewerError && <div className="spv-msg">{t("spatial.loading")}</div>}
            {viewerError && <div className="spv-msg bad">{t("spatial.failed", { message: viewerError })}</div>}
            {hover && !selected && <div className="spv-hover">{hover}</div>}
            {(parts.length > 0 || pendingStructures.length > 0) &&
              (layersOpen ? (
                <div className="spv-layers" aria-label={t("spatial.parts")}>
                  <div className="spv-layers-head">
                    <span>{t("spatial.parts")}</span>
                    <button className="spv-layers-btn" title={t("spatial.layersHide")} aria-label={t("spatial.layersHide")} onClick={() => setLayersOpen(false)}>
                      ▾
                    </button>
                  </div>
                  <ul className="spv-parts">
                    {parts.map((p) => (
                      <li key={p.id} className={`${selected?.id === p.id ? "on" : ""} ${hover === p.name ? "hover" : ""}`}>
                        <input type="checkbox" checked={p.visible} onChange={(e) => viewer?.setVisible(p.id, e.target.checked)} aria-label={t("spatial.show", { name: p.name })} />
                        <button className="spv-name" title={p.name} onClick={() => viewer?.select(selected?.id === p.id ? null : p.id)}>
                          {p.name}
                        </button>
                        <input
                          type="range"
                          min={0}
                          max={1}
                          step={0.05}
                          value={p.opacity}
                          onChange={(e) => viewer?.setOpacity(p.id, Number(e.target.value))}
                          aria-label={t("spatial.opacity", { name: p.name })}
                          title={t("spatial.opacity", { name: p.name })}
                        />
                      </li>
                    ))}
                    {pendingStructures.map((s) => (
                      <li key={`pending-${s.id}`} className="spv-part-pending">
                        <span className="spv-spin" aria-hidden="true" />
                        <span className="spv-name" title={s.name}>{s.name}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <button className="spv-layers-btn spv-layers-collapsed" onClick={() => setLayersOpen(true)}>
                  {t("spatial.parts")}
                </button>
              ))}
            {selected && (
              <div className="spv-card" role="status">
                <strong title={selected.name}>{selected.name}</strong>
                <span>{sizeLabel(selected.size)}</span>
                <div className="spv-card-actions">
                  <button className="btn sm" onClick={() => quotePart(selected)}>{t("spatial.addToChat")}</button>
                  <button className="btn sm" onClick={() => viewer?.select(null)}>{t("spatial.deselect")}</button>
                </div>
              </div>
            )}
          </div>
        )}

        {has3d && hasSide && (
          <div
            className="spv-grip no-drag"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("spatial.resizeSide")}
            tabIndex={0}
            {...side.grip}
          />
        )}

        {hasSide && (
          <aside
            ref={side.panel}
            className={`spv-side ${!has3d ? "full" : ""}`}
            style={side.style(!has3d)}
          >
            {volume && source && (
              <SliceView
                volume={volume}
                source={source}
                k={k}
                onSliceChange={setK}
                win={win}
                windows={windows}
                onWindowChange={setWin}
                ticks={findingTicks}
                circle={sliceCircle}
                patientOrientation={spatial.profile?.orientation !== "none"}
                onCanvasReady={setSliceCanvas}
                onCanvasDrawn={handleCanvasDrawn}
              />
            )}
            {spatial.findings.length > 0 && (
              <FindingsList
                findings={spatial.findings}
                focusedId={focusedFinding}
                hasVolume={!!volume}
                onLocate={locateFinding}
                onViewSlice={viewFindingSlice}
                onAsk={askFinding}
              />
            )}
          </aside>
        )}
      </div>

      {hasAiFinding && (
        <div className="spv-disclaimer" role="note">
          {spatial.profile?.disclaimer?.trim() || t("spatial.disclaimer")}
        </div>
      )}
    </div>
  );
}
