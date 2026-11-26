"""Rank places in a chest CT that match one finding from a report.

Run through `spatial_script`. Input: one JSON object in argv[1] (a JSON-encoded
string is also accepted):
  {"side": "right" | "left" | "any",          # patient's side
   "lobe": "upper" | "middle" | "lower" | "any",
   "kind": "solid" | "ground_glass" | "any",
   "size_mm": 16.0,                            # as written in the report
   "size_basis": "long" | "mean" | "auto",     # 长径 -> long; 平均径 -> mean; auto reads "label"
   "near": "pleura" | "any",                   # optional: 胸膜下
   "image_number": 208,                        # optional: report's image/slice number
   "series_hint": "1.5",                       # optional: text the report names the series by
   "label": "右肺下叶前基底段胸膜下结节状影"}   # optional text for the marker
If image_number is given the script does not search: it maps the number through the
kernel, checks the mapped slice against the anatomy named in side/lobe, submits a
marker there, and reports any mismatch in "warning" (the report may count images of
another series; the marker is then only "the slice the number points to", not the
finding's place).

Otherwise it searches. v2 changes over the original:
  * the search runs in the CLOSED lung mask (lungs_closed): solid nodules and vessels
    are denser than air and lie OUTSIDE the air-only lung masks, so searching those
    for hu > -300 could never find anything (the original's flaw);
  * sides are assigned by nearest air-lung mask, so the closed mask can be split;
  * density classes: solid > -300 HU, ground-glass -750..-300, plus a faint class
    -800..-600 tried when nothing else matches (结节状影 may be faint);
  * "near pleura" uses distance to the closed-lung edge with a 4 mm tolerance, and
    the search region is grown 3 mm outwards so nodules fused with the diaphragm,
    pleura or heart border are not lost with the mask; a chest-wall guard excludes
    voxels within 2 mm of bone-dense tissue, so a rib's partial-volumed edge does
    not rank as a subpleural nodule (found by testing on a real scan);
  * size matching follows the report's wording: "长径" matches the longest bounding
    box edge, otherwise the equivalent-sphere diameter; elongated blobs are kept
    (a 16x10 mm nodule is not a sphere) and scored by their long axis;
  * every relaxation is printed, and an empty result says what was searched.

Output (also submitted): up to 5 matches
  {"rank": int, "center_voxel": [k, j, i], "diameter_mm": float, "long_mm": float,
   "kind": str, "mean_hu": float, "contact": [...], "match": float, "why": str}
or an empty list when nothing in that region fits (say so plainly; do not guess).
Lobe limits are approximate by height of the lung: upper top third, middle
(right only) middle third in front, lower bottom third and back.
"""
import json
import sys

import numpy as np
from scipy import ndimage as ndi

from finx_spatial import load, submit


def parse_args(argv):
    if len(argv) <= 1 or not argv[1]:
        return {}
    a = json.loads(argv[1])
    if isinstance(a, str):
        a = json.loads(a)
    if not isinstance(a, dict):
        raise ValueError("input must be a JSON object")
    return a


def main():
    args = parse_args(sys.argv)
    vol = load()
    hu = np.asarray(vol.hu)
    sp = np.asarray(vol.spacing, dtype=float)
    label = args.get("label", "报告所述")
    log = []

    air_seg = {"right": "lung_right", "left": "lung_left", "any": "lungs"}[args.get("side", "any")]
    lung_air = vol.segment(air_seg).astype(bool)

    if args.get("image_number") is not None:
        k = vol.slice_of_image(int(args["image_number"]))
        inside = lung_air[k]
        warning = None
        hint = args.get("series_hint")
        if hint:
            log.append(f"the report names the series by '{hint}'; confirm the shown series matches before trusting the number")
        if not inside.any():
            print(json.dumps([], ensure_ascii=False))
            return
        # Anatomy check: does the named lobe live on this slice at all?
        lobe = args.get("lobe", "any")
        if lobe != "any":
            ks = np.where(lung_air.any(axis=(1, 2)))[0]
            lo_k, hi_k = ks.min(), ks.max()
            t = (hi_k - lo_k + 1) / 3.0
            if vol.k_towards_head:
                band = {"upper": (lo_k + 2 * t, hi_k + 1), "middle": (lo_k + t, lo_k + 2 * t), "lower": (lo_k, lo_k + t)}[lobe]
            else:
                band = {"upper": (lo_k, lo_k + t), "middle": (lo_k + t, lo_k + 2 * t), "lower": (lo_k + 2 * t, hi_k + 1)}[lobe]
            if not (band[0] - t / 2 <= k <= band[1] + t / 2):
                z0 = float(vol.origin[2])
                warning = (f"im{args['image_number']} maps to slice {k} (z={z0 + k * sp[0]:.0f} mm), "
                           f"outside the {lobe}-lobe band ({band[0]:.0f}..{band[1]:.0f}) of the shown series: "
                           "the report may count images of ANOTHER series. The marker only shows where the number points, not the finding.")
                log.append(warning)
        j, i = (int(round(v)) for v in ndi.center_of_mass(inside))
        submit.marker(center_voxel=[k, j, i], label=label, source="reference",
                      note=warning or "位置只到该层面，具体位置请在图上核对")
        print(json.dumps([{"rank": 1, "center_voxel": [k, j, i],
                           "why": "按报告图像号定位到该层", **({"warning": warning} if warning else {})}],
                         ensure_ascii=False))
        return

    # --- Search region: closed lung (air + vessels + nodules), split by side. ---
    closed = vol.segment("lungs_closed").astype(bool)
    if args.get("side", "any") != "any":
        r = vol.segment("lung_right").astype(bool)
        l = vol.segment("lung_left").astype(bool)
        dr = ndi.distance_transform_edt(~r, sampling=sp)
        dl = ndi.distance_transform_edt(~l, sampling=sp)
        region = closed & ((dr <= dl) if args["side"] == "right" else (dl < dr))
        log.append("side split of the closed mask by nearest air-lung mask (approximate near the heart)")
    else:
        region = closed

    lobe = args.get("lobe", "any")
    if lobe != "any" and region.any():
        ks = np.where(region.any(axis=(1, 2)))[0]
        lo_k, hi_k = ks.min(), ks.max()
        t = (hi_k - lo_k + 1) / 3.0
        if vol.k_towards_head:
            band = {"upper": (lo_k + 2 * t, hi_k + 1), "middle": (lo_k + t, lo_k + 2 * t), "lower": (lo_k, lo_k + t)}[lobe]
        else:
            band = {"upper": (lo_k, lo_k + t), "middle": (lo_k + t, lo_k + 2 * t), "lower": (lo_k + 2 * t, hi_k + 1)}[lobe]
        keep = np.zeros_like(region)
        keep[int(band[0]):int(band[1])] = True
        if lobe == "middle":
            js = np.where(region.any(axis=(0, 2)))[0]
            jcut = js.min() + 0.6 * (js.max() - js.min())
            if vol.direction[4] > 0:  # j grows towards posterior
                keep[:, int(jcut):, :] = False
            else:
                keep[:, :int(js.max() - 0.6 * (js.max() - js.min())), :] = False
        region = region & keep

    # Grow the region 3 mm outwards: a nodule fused with pleura/diaphragm/heart is
    # partly outside the closed mask; keep it searchable but stay inside the body
    # and below bone density.
    body = vol.segment("body").astype(bool)
    search = (ndi.distance_transform_edt(~region, sampling=sp) <= 3.0) & body & (hu < 150)
    log.append(f"search voxels: {int(search.sum())} (closed lung, grown 3 mm, bone excluded)")
    # Keep the chest wall out: a rib's partial-volumed edge is a long dense arc that
    # would otherwise rank as a "subpleural nodule". Exclude anything within 2 mm of
    # bone-dense tissue (the pleura itself is under 2 mm thick).
    bone_near = ndi.distance_transform_edt(~(body & (hu > 150)), sampling=sp) <= 2.0
    search &= ~bone_near
    log.append("chest-wall guard: voxels within 2 mm of bone-dense tissue excluded")

    dist_edge = ndi.distance_transform_edt(closed, sampling=sp)
    vox = float(np.prod(sp))
    size = float(args["size_mm"]) if args.get("size_mm") else None
    basis = args.get("size_basis", "auto")
    if basis == "auto":
        basis = "long" if any(w in label for w in ("长径", "最大径", "long")) else "mean"
    smooth = ndi.gaussian_filter(hu.astype(np.float32), sigma=1.0 / sp)

    want = args.get("kind", "any")
    classes = []
    if want in ("solid", "any"):
        classes.append(("solid", (smooth > -300) & search))
    if want in ("ground_glass", "any"):
        classes.append(("ground_glass", (smooth > -750) & (smooth <= -300) & search))

    def collect(classes, pleura_mm):
        out = []
        for kind, mask in classes:
            mask = ndi.binary_opening(mask, iterations=1)
            labels, n = ndi.label(mask)
            for lab, sl in enumerate(ndi.find_objects(labels), start=1):
                m = labels[sl] == lab
                d = (6.0 * m.sum() * vox / np.pi) ** (1 / 3)
                if d < 3 or d > 35:
                    continue
                idx = np.argwhere(m)
                ext = (idx.max(0) - idx.min(0) + 1) * sp
                long_mm = float(ext.max())
                if long_mm > 45:
                    continue
                sph = float(ext.min() / ext.max())
                if sph < 0.25:  # a flat sheet, not a nodule
                    continue
                c = tuple(int(round(v)) for v in (idx.mean(0) + [s.start for s in sl]))
                near_pleura = bool(dist_edge[sl][m].min() <= pleura_mm)
                if args.get("near") == "pleura" and not near_pleura:
                    continue
                ref = long_mm if basis == "long" else d
                match = 0.4 * sph
                why = [f"{kind}, eq.d {d:.0f} mm, long {long_mm:.0f} mm"]
                if size:
                    match += 0.6 * max(0.0, 1 - abs(ref - size) / max(size, 1))
                    why.append(f"report {size:g} mm ({basis})")
                out.append({"center_voxel": list(c), "diameter_mm": round(float(d), 1),
                            "long_mm": round(long_mm, 1), "kind": kind,
                            "mean_hu": round(float(hu[sl][m].mean()), 0),
                            "contact": ["pleura"] if near_pleura else [],
                            "match": round(match, 3), "why": "; ".join(why)})
        return out

    out = collect(classes, 4.0)
    if not out and want in ("any", "ground_glass"):
        log.append("nothing at solid/GGO densities: trying the faint class (-800..-600 HU)")
        out = collect([("faint", (smooth > -800) & (smooth <= -600) & search)], 4.0)
    if not out and args.get("near") == "pleura":
        log.append("nothing near the pleura: repeating without the pleura filter (candidates will say so)")
        args.pop("near", None)
        out = collect(classes + [("faint", (smooth > -800) & (smooth <= -600) & search)], 4.0)
    out.sort(key=lambda r: -r["match"])
    out = out[:5]
    for n, r in enumerate(out, start=1):
        r["rank"] = n
    for line in log:
        print("note: " + line, file=sys.stderr)
    if not out:
        print("note: no candidate in the searched region at any tried density; do not guess a place", file=sys.stderr)
    submit.candidates(out, source="locate_report_item.py (v2)", args=args, reference_label=label)
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()