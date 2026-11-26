"""Find lung nodule candidates in a chest CT volume.

Run through `spatial_script`. Input: one JSON object in argv[1] (a JSON-encoded
string is also accepted), all optional:
  {"min_mm": 3, "max_mm": 30, "max_candidates": 30, "region": "lungs_closed"}
  region: a structure built by scripts/chest_structures.py. Default "lungs_closed"
  (air + vessels + nodules): solid nodules are denser than air and lie OUTSIDE the
  air-only masks, so the original default "lungs" could never find them (v2 fix).
  The pleura shell is measured on the air-only "lungs" mask when it exists.

Output (also submitted with submit.candidates): a list of candidates, each
  {"id": int, "center_voxel": [k, j, i], "diameter_mm": float,
   "kind": "solid" | "ground_glass",   # mean HU above -300 vs -750..-300
   "mean_hu": float, "sphericity": float, "blobness": float,
   "contact": [] | ["pleura"] | ["vessel"] | ["pleura", "vessel"],
   "score": float, "note": str}
Candidates touching pleura or vessels are kept but flagged in "contact".
These are hints for the model to check on the slices, never a diagnosis.
"""
import json
import sys

import numpy as np
from scipy import ndimage as ndi
from skimage.feature import hessian_matrix, hessian_matrix_eigvals

from finx_spatial import load, submit


def blobness(hu, spacing, mask):
    """Hessian blobness in [0, 1] at a 2 mm scale: blobs have three similar negative
    eigenvalues, vessels two large and one small. Returns an array like hu."""
    sigma = 2.0 / min(spacing)
    h = hessian_matrix(np.clip(hu, -1000, 200).astype(np.float32), sigma=sigma,
                       order="rc", use_gaussian_derivatives=True)
    ev = hessian_matrix_eigvals(h)  # sorted descending: e1 >= e2 >= e3
    e3 = np.abs(ev[2]) + 1e-6
    e1 = np.abs(ev[0])
    out = np.where((ev[0] < 0) & (ev[1] < 0) & (ev[2] < 0), e1 / e3, 0.0)
    out = np.clip(out, 0, 1)
    return np.where(mask, out, 0.0)


def main():
    raw = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}
    args = json.loads(raw) if isinstance(raw, str) else raw
    min_mm = float(args.get("min_mm", 3))
    max_mm = float(args.get("max_mm", 30))
    limit = int(args.get("max_candidates", 30))
    region = args.get("region", "lungs_closed")

    vol = load()
    hu = vol.hu
    sp = np.asarray(vol.spacing, dtype=float)  # (dk, dj, di) in mm
    voxel_mm3 = float(np.prod(sp))
    lungs = vol.segment(region).astype(bool)
    try:
        air_lungs = vol.segment("lungs").astype(bool)
    except Exception:
        air_lungs = lungs

    # Lung parenchyma interior and the shell near the pleura (within 2 mm of the air-lung edge).
    dist_edge = ndi.distance_transform_edt(air_lungs, sampling=sp)
    shell = air_lungs & (dist_edge <= 2.0)
    smooth = ndi.gaussian_filter(hu.astype(np.float32), sigma=0.5 / sp)

    # Vessels: bright, very tubular, connected to large structures. Dense = > -300 HU.
    dense = (smooth > -300) & lungs
    ggo = (smooth > -750) & (smooth <= -300) & lungs
    blob = blobness(hu, sp, lungs)

    results = []
    for kind, mask in (("solid", dense), ("ground_glass", ggo)):
        # Open to cut thin vessels, then label what remains.
        opened = ndi.binary_opening(mask, structure=ndi.generate_binary_structure(3, 1), iterations=1)
        labels, n = ndi.label(opened)
        if n == 0:
            continue
        objs = ndi.find_objects(labels)
        for lab, sl in enumerate(objs, start=1):
            m = labels[sl] == lab
            vox = int(m.sum())
            vol_mm3 = vox * voxel_mm3
            d = (6.0 * vol_mm3 / np.pi) ** (1 / 3)  # equivalent sphere diameter
            if d < min_mm or d > max_mm:
                continue
            idx = np.argwhere(m)
            ext = (idx.max(0) - idx.min(0) + 1) * sp
            if ext.max() > max_mm * 1.3:  # long and thin: vessel or airway wall
                continue
            elong = ext.max() / max(ext.min(), 1e-6)
            sphericity = float(min(ext) / max(ext))
            center = idx.mean(0) + np.array([s.start for s in sl])
            c = tuple(int(round(v)) for v in center)
            mean_hu = float(hu[sl][m].mean())
            b = float(blob[sl][m].mean())
            full = np.zeros(hu.shape, bool)
            full[sl] = m
            ring = ndi.binary_dilation(full, iterations=2) & ~full
            contact = []
            if (ring & ~air_lungs).any() or (full & shell).any():
                contact.append("pleura")
            if kind == "ground_glass":
                touch_vessel = False
            else:
                touch_vessel = bool((ring & dense & ~opened).any())
            if touch_vessel:
                contact.append("vessel")
            # Vessel-like: low sphericity or low blobness. Keep, but score lower.
            score = 0.5 * sphericity + 0.5 * b - (0.15 if contact else 0.0) - 0.05 * max(elong - 1.5, 0)
            results.append({
                "center_voxel": list(c),
                "diameter_mm": round(float(d), 1),
                "kind": kind,
                "mean_hu": round(mean_hu, 0),
                "sphericity": round(sphericity, 2),
                "blobness": round(b, 2),
                "contact": contact,
                "score": round(float(score), 3),
                "note": "contacts " + "/".join(contact) if contact else "",
            })

    results.sort(key=lambda r: -r["score"])
    results = results[:limit]
    for n, r in enumerate(results, start=1):
        r["id"] = n
    submit.candidates(results, source="lung_nodule_candidates.py", args=args)
    print(json.dumps(results, ensure_ascii=False))


if __name__ == "__main__":
    main()
