"""Build the structures of a chest CT: body, airway, both lungs, lung vessels, bones.

Run through `spatial_script`. Input: one JSON object in argv[1] (a JSON-encoded
string is also accepted), all optional:
  {"lung_hu": -400,                 # air/tissue limit for body and lungs; "auto" picks it from the histogram
   "airway_range": [-950, -850],    # the airway grows from the first limit towards the second; "auto" starts conservative on deep-inspiration/noisy scans
   "airway_step": 10, "leak_ratio": 1.6, "airway_max_ml": 250,
   "airway_gap_mm": 1,              # how far around the airway is kept out of the lungs
   "vessel_hu": -300, "vessel_min_mm3": 20,
   "bone_hu": 200, "bone_min_mm3": 500, "bone_keep_largest": 0,   # 0 keeps every piece
   "skip": ["airway"],              # structures not to build
   "expect_scale": 1.0,             # scales every expected volume (a child: about 0.3)
   "auto_retry": true}              # when a result falls outside its expected range, retry with tighter inputs (at most 2 extra builds)

v2 changes over the original:
  * the airway result is checked against its expected volume, not just against leaks:
    a result above the cap triggers an automatic retry with a tighter range, down to
    trachea-and-main-bronchi only, instead of silently hollowing out the lungs;
  * the lungs are checked too: if they come out under expectation while the airway is
    large, the airway is rebuilt conservatively and the lungs regrown;
  * "auto" inputs read the scan's own histogram: deep inspiration (a large share of
    voxels below -950 HU inside the body) or high noise starts with the conservative
    airway range; the lung limit is placed in the valley between air and tissue;
  * every automatic decision is printed as a note, so the reader sees what was tried.

Output: structures submitted to the document, each with the volume it is expected to have;
the kernel measures them and reports any outside that as unreliable. Printed: one line per
structure with how it was built. References: references/building.md says what to change when.

Everything about the chest is in this file. The kernel only stores, measures and shows masks.
"""
import json
import sys
import time

import numpy as np
from scipy import ndimage as ndi
from skimage.segmentation import watershed

from finx_spatial import load, submit

WINDOWS = [("肺窗", 1500, -600), ("纵隔窗", 400, 40), ("骨窗", 2000, 400)]
DISCLAIMER = "AI 提示仅供参考，不能代替医生的诊断。"

# How far down from the top the trachea is looked for, and the least area it has in a slice.
TOP_SEARCH_MM = 40.0
TOP_MIN_MM2 = 20.0
TOP_MAX_MM2 = 1500.0
# How far from the body's midline its centre may lie.
TOP_MIDLINE_MM = 50.0
# An airway smaller than this (mL) is tried again on a copy of the scan smoothed by SMOOTH_MM.
AIRWAY_SMALL_ML = 15.0
# The least a trachea holds, mL: below it the airway is still filling its lumen.
AIRWAY_BASE_ML = 8.0
SMOOTH_MM = 0.5
# The second-largest piece of lung counts as a lung when it is at least this share of the largest.
COMPARABLE = 0.2
# How far fused lungs are worn down looking for two cores.
SPLIT_MAX_MM = 15.0


def largest(mask, n=1):
    """The n largest 6-connected components, as a list of masks, largest first."""
    lab, count = ndi.label(mask)
    if count == 0:
        return []
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    order = np.argsort(sizes)[::-1][:n]
    return [lab == i for i in order if sizes[i] > 0]


def drop_small(mask, min_voxels):
    lab, count = ndi.label(mask)
    if count == 0:
        return mask
    sizes = np.bincount(lab.ravel())
    keep = sizes >= min_voxels
    keep[0] = False
    return keep[lab]


def bbox(mask, margin=0):
    """Slices of the mask's bounding box, grown by margin voxels; None when empty."""
    out = []
    for axis in range(mask.ndim):
        other = tuple(a for a in range(mask.ndim) if a != axis)
        hit = np.flatnonzero(mask.any(axis=other))
        if hit.size == 0:
            return None
        out.append(slice(max(int(hit[0]) - margin, 0), min(int(hit[-1]) + 1 + margin, mask.shape[axis])))
    return tuple(out)


def ball(mm, sp):
    """The voxels within mm of a centre, as a footprint."""
    r = [int(np.floor(mm / v + 1e-6)) for v in sp]
    grid = np.ogrid[tuple(slice(-n, n + 1) for n in r)]
    return sum((g * v) ** 2 for g, v in zip(grid, sp)) <= mm * mm * (1 + 1e-5)


def within(mask, mm, sp):
    """Every voxel within mm of the mask (a ball in mm)."""
    box = bbox(mask, int(np.ceil(mm / sp.min())) + 1)
    if box is None:
        return mask.copy()
    out = np.zeros_like(mask)
    if mm / sp.min() <= 3:
        out[box] = ndi.binary_dilation(mask[box], structure=ball(mm, sp))
    else:
        out[box] = ndi.distance_transform_edt(~mask[box], sampling=sp) <= mm
    return out


def coarse(mask, sp, target_mm=1.5):
    """The mask at a coarser grid (voxels of about target_mm; a coarse voxel is set when any of
    its voxels is), its spacing, and a function that brings a coarse array back to the mask's
    grid. Shapes that are measured in several mm do not need the scan's full resolution."""
    f = [max(int(round(target_mm / v)), 1) for v in sp]
    pad = [(0, (-n) % k) for n, k in zip(mask.shape, f)]
    m = np.pad(mask, pad)
    small = m.reshape(m.shape[0] // f[0], f[0], m.shape[1] // f[1], f[1], m.shape[2] // f[2], f[2]).any(axis=(1, 3, 5))

    def back(a):
        for axis, k in enumerate(f):
            if k > 1:
                a = np.repeat(a, k, axis=axis)
        return a[:mask.shape[0], :mask.shape[1], :mask.shape[2]]

    return small, sp * np.array(f, dtype=float), back


def closed(mask, mm, sp):
    """Dilate then erode by mm: gaps and channels narrower than 2 mm are filled."""
    box = bbox(mask, int(np.ceil(mm / sp.min())) + 2)
    if box is None:
        return mask.copy()
    small, csp, back = coarse(mask[box], sp)
    small = np.pad(small, int(np.ceil(mm / csp.min())) + 1)
    grown = ndi.distance_transform_edt(~small, sampling=csp) <= mm
    shut = ndi.distance_transform_edt(grown, sampling=csp) > mm
    n = int(np.ceil(mm / csp.min())) + 1
    # A coarse voxel on the closed shape's edge is only partly inside it: leave the edge to the
    # mask itself, or the chest wall next to the lungs would count as closed over.
    shut = ndi.binary_erosion(shut)
    out = np.zeros_like(mask)
    out[box] = back(shut[n:-n, n:-n, n:-n])
    return out | mask


class Axes:
    """Which way the array's axes run in the patient (LPS: x to the left, y back, z up)."""

    def __init__(self, vol):
        d = np.asarray(vol.direction, dtype=float).reshape(3, 3)  # rows: i, j, k
        self.sp = np.asarray(vol.spacing, dtype=float)             # (dk, dj, di)
        self.dir = d[::-1]                                         # rows: array axes 0, 1, 2
        self.up = int(np.argmax(np.abs(self.dir[:, 2])))           # the head-foot array axis
        self.head_last = self.dir[self.up, 2] > 0                  # index grows towards the head
        self.origin_x = float(vol.origin[0])
        self.start = (0, 0, 0)          # where the working box starts in the volume
        self.full = None                # the volume's shape; None: the box is the volume

    def crop(self, box, full):
        """Work goes on inside box (slices) of a volume of shape full."""
        self.start = tuple(b.start for b in box)
        self.full = tuple(full)

    def x(self, shape):
        """Patient x (mm, growing to the patient's left) of every voxel, broadcastable."""
        out = self.origin_x
        for a in range(3):
            idx = (np.arange(shape[a], dtype=np.float32) + self.start[a]) * (self.sp[a] * self.dir[a, 0])
            out = out + idx.reshape([-1 if b == a else 1 for b in range(3)])
        return out


def side_faces(shape, axes):
    """(axis, index) of the faces of the working box that are faces of the volume, other than
    the head and foot ends."""
    full = axes.full or shape
    out = []
    for a in range(3):
        if a == axes.up:
            continue
        if axes.start[a] == 0:
            out.append((a, 0))
        if axes.start[a] + shape[a] == full[a]:
            out.append((a, shape[a] - 1))
    return out


def build_body(hu, limit, axes):
    """The largest piece denser than air, with what it encloses in each slice (the lungs)."""
    parts = largest(hu >= limit)
    if not parts:
        return np.zeros(hu.shape, bool)
    body = parts[0]
    for n in range(body.shape[axes.up]):
        sl = [slice(None)] * 3
        sl[axes.up] = n
        body[tuple(sl)] = ndi.binary_fill_holes(body[tuple(sl)])
    return body


def top_seed(air, body, axes):
    """A voxel of the trachea: in the most superior slice that has one, the largest enclosed
    piece of air of a trachea's size lying near the body's midline; the voxel of it nearest its
    centre. Air caught between the body and the table, an arm or clothing is enclosed too, but
    lies off to the side."""
    depth = air.shape[axes.up]
    steps = int(min(max(np.ceil(TOP_SEARCH_MM / axes.sp[axes.up]), 1), depth))
    in_plane = [a for a in range(3) if a != axes.up]
    area = float(axes.sp[in_plane[0]] * axes.sp[in_plane[1]])
    # Which in-plane axis runs left-right, and its spacing.
    lateral = int(np.argmax([abs(axes.dir[a, 0]) for a in in_plane]))
    lateral_mm = float(axes.sp[in_plane[lateral]])
    for s in range(steps):
        n = depth - 1 - s if axes.head_last else s
        sl = [slice(None)] * 3
        sl[axes.up] = n
        plane = air[tuple(sl)]
        lab, count = ndi.label(plane)
        if count == 0:
            continue
        inside = np.argwhere(body[tuple(sl)])
        if not len(inside):
            continue
        midline = inside[:, lateral].mean()
        edge = set(np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]])))
        sizes = np.bincount(lab.ravel())
        centres = ndi.center_of_mass(plane, lab, range(1, count + 1))
        best = max((i for i in range(1, count + 1)
                    if i not in edge and TOP_MIN_MM2 <= sizes[i] * area <= TOP_MAX_MM2
                    and abs(centres[i - 1][lateral] - midline) * lateral_mm <= TOP_MIDLINE_MM),
                   key=lambda i: sizes[i], default=None)
        if best is None:
            continue
        pts = np.argwhere(lab == best)
        p = pts[np.argmin(((pts - pts.mean(axis=0)) ** 2).sum(axis=1))]
        seed = [int(p[0]), int(p[1])]
        seed.insert(axes.up, n)
        return tuple(seed)
    return None


# Wave fronts (see grow_fronts). A front piece this many times the smallest of its last three
# ancestors is a leak, when it is also at least FRONT_MIN_MM3; so is one this many times the
# trunk's own front. The trunk is measured over TRUNK_MM from the seed; nothing is cut within it.
FRONT_RATIO = 2.5
FRONT_MIN_MM3 = 150.0
FRONT_OVER_TRUNK = 3.0
TRUNK_MM = 15.0


class Flood:
    """Growing through the 6-neighbours of a set of voxels, held as flat indexes into a volume
    padded by one voxel (so a neighbour is always a valid index)."""

    def __init__(self, allowed):
        self.shape = allowed.shape
        self.padded = np.pad(allowed, 1)
        s = self.padded.shape
        self.steps = np.array([1, -1, s[2], -s[2], s[1] * s[2], -s[1] * s[2]], dtype=np.int64)
        self.flat = self.padded.ravel()

    def index(self, voxel):
        return int(np.ravel_multi_index(tuple(v + 1 for v in voxel), self.padded.shape))

    def step(self, frontier, seen, origin=None):
        """The unseen allowed neighbours of frontier (marked seen), and for each the origin of
        the voxel it was reached from."""
        nb = (frontier[:, None] + self.steps[None, :]).ravel()
        ok = self.flat[nb] & ~seen[nb]
        nb = nb[ok]
        nb, first = np.unique(nb, return_index=True)
        seen[nb] = True
        if origin is None:
            return nb, None
        return nb, np.repeat(origin, 6)[ok][first]

    def mask(self, indexes):
        out = np.zeros(self.padded.shape, bool)
        out.ravel()[indexes] = True
        return out[1:-1, 1:-1, 1:-1]

    def pieces(self, indexes):
        """The 6-connected pieces of a sorted set of voxels: a piece number for each."""
        from scipy.sparse import coo_matrix
        from scipy.sparse.csgraph import connected_components
        rows, cols = [], []
        for st in self.steps[::2]:
            at = np.searchsorted(indexes, indexes + st)
            at[at == len(indexes)] = 0
            hit = indexes[at] == indexes + st
            rows.append(np.flatnonzero(hit))
            cols.append(at[hit])
        n = len(indexes)
        graph = coo_matrix((np.ones(sum(len(r) for r in rows), bool), (np.concatenate(rows), np.concatenate(cols))), shape=(n, n))
        return connected_components(graph, directed=False)


def grow_plain(flood, seed, max_voxels):
    """Everything connected to the seed, nearest first; None once it is over max_voxels."""
    seen = np.zeros(flood.flat.shape, bool)
    seen[seed] = True
    frontier = np.array([seed], dtype=np.int64)
    found = [frontier]
    count = 1
    while frontier.size:
        frontier, _ = flood.step(frontier, seen)
        count += frontier.size
        if count > max_voxels:
            return None
        found.append(frontier)
    return np.concatenate(found)


def grow_fronts(flood, seed, max_voxels, sp):
    """Grows a tube from the seed by wave fronts: layers of equal distance from it. Each layer
    falls into pieces (the tube's branches, cut across); a piece that suddenly outgrows its
    ancestors has left the tube for the porous tissue around it, and is cut off with everything
    past it while the other branches go on. Returns (voxels, pieces cut), or None over
    max_voxels."""
    finest = float(sp.min())
    per_layer = max(int(round(2.0 / finest)), 2)   # a layer is about 2 mm of growth
    trunk_layers = int(np.ceil(TRUNK_MM / (per_layer * finest)))
    voxel = float(np.prod(sp))
    seen = np.zeros(flood.flat.shape, bool)
    seen[seed] = True
    found = [np.array([seed], dtype=np.int64)]
    count, cut, trunk, layer = 1, 0, 0, 0
    # The accepted pieces of the last layer: voxels, the piece each belongs to, and per piece
    # the sizes of itself and its two ancestors.
    front = np.array([seed], dtype=np.int64)
    owner = np.zeros(1, np.int64)
    history = np.array([[1, 0, 0]], dtype=np.int64)
    while front.size:
        layer += 1
        new, new_from = [], []
        frontier, origin = front, owner
        for _ in range(per_layer):
            frontier, origin = flood.step(frontier, seen, origin)
            new.append(frontier)
            new_from.append(origin)
        new, new_from = np.concatenate(new), np.concatenate(new_from)
        if not new.size:
            break
        order = np.argsort(new)
        new, new_from = new[order], new_from[order]
        n_pieces, label = flood.pieces(new)
        sizes = np.bincount(label, minlength=n_pieces)
        # The largest parent speaks for the piece.
        parent_size = history[new_from, 0]
        best = np.lexsort((parent_size, label))
        last = np.flatnonzero(np.r_[label[best][1:] != label[best][:-1], True])
        parent = new_from[best][last]
        ancestors = history[parent]
        floor = np.where(ancestors > 0, ancestors, np.iinfo(np.int64).max).min(axis=1)
        leak = np.zeros(n_pieces, bool)
        if layer > trunk_layers:
            leak = ((sizes > FRONT_RATIO * floor) & (sizes * voxel > FRONT_MIN_MM3)) | ((trunk > 0) & (sizes > FRONT_OVER_TRUNK * trunk))
        else:
            trunk = max(trunk, int(sizes.max()))
        cut += int(leak.sum())
        keep = ~leak[label]
        count += int(keep.sum())
        if count > max_voxels:
            return None
        front = new[keep]
        renumber = np.cumsum(~leak) - 1
        owner = renumber[label[keep]]
        history = np.column_stack([sizes, ancestors[:, 0], ancestors[:, 1]])[~leak]
        found.append(front)
    return np.concatenate(found), cut


def build_airway(hu, body, axes, lo, hi, step, leak_ratio, max_ml):
    """A tube of air grown from the trachea with a leak watched for: the limit is loosened from
    lo to hi, and the region kept while it grows steadily. When a looser limit makes it jump (by
    leak_ratio, or past max_ml), that limit and the looser ones are grown by wave fronts, which
    cut only the branches that leak; if even that jumps, the last steady region stands.
    Returns (mask, notes, why it is unreliable or None)."""
    voxel_ml = float(np.prod(axes.sp)) / 1000.0
    max_voxels = max(int(max_ml / voxel_ml), 1)
    slack = int(max_voxels * 0.05)   # a jump smaller than this is growth, not a leak
    empty = np.zeros(hu.shape, bool)

    limit, seed = lo, None
    while limit <= hi + 1e-9:
        seed = top_seed((hu <= limit) & body, body, axes)
        if seed is not None:
            break
        limit += step
    if seed is None:
        return empty, [], f"no enclosed air in the top {TOP_SEARCH_MM:.0f} mm of the scan: it may start below the trachea"

    def jumped(size, kept):
        return kept is not None and size > len(kept) * leak_ratio and size > len(kept) + slack

    kept, kept_at, leaked_at, cut, trace = None, limit, None, 0, []
    flood = None
    while limit <= hi + 1e-9:
        flood = Flood((hu <= limit) & body)
        at = flood.index(seed)
        candidate, pieces = None, 0
        if leaked_at is None:
            grown = grow_plain(flood, at, max_voxels)
            if grown is None or jumped(len(grown), kept):
                leaked_at = limit
            else:
                candidate = grown
        if leaked_at is not None:
            fronts = grow_fronts(flood, at, max_voxels, axes.sp)
            if fronts is not None:
                grown = fronts[0] if kept is None else np.union1d(fronts[0], kept)
                # While what is kept is less than a trachea, growing fast is filling the lumen,
                # not leaking: the fronts alone watch for leaks then.
                filling = kept is None or len(kept) * voxel_ml < AIRWAY_BASE_ML
                if len(grown) <= max_voxels and (filling or not jumped(len(grown), kept)):
                    candidate, pieces = grown, fronts[1]
        if candidate is None:
            trace.append(f"{limit:.0f}: jumped")
            break
        kept, kept_at, cut = candidate, limit, pieces
        trace.append(f"{limit:.0f}: {len(kept) * voxel_ml:.1f} mL" + (f" ({pieces} cut)" if pieces else ""))
        limit += step
    if kept is None:
        return empty, [f"[{'; '.join(trace)}]"], f"it leaks into the lung even at the tightest limit, {kept_at:.0f} HU"
    how = (f"grew steadily up to {kept_at:.0f} HU (no leak)" if leaked_at is None
           else f"leaked at {leaked_at:.0f} HU; kept up to {kept_at:.0f} HU with {cut} leaking branch(es) cut")
    return flood.mask(kept), [f"{how} [{'; '.join(trace)}]"], None


def split_fused(one, axes):
    """A single piece holding both lungs, cut where it is narrowest: it is worn down until it
    falls into two comparable cores, and each voxel goes to the core it drains to.
    Returns (labels 1/2 with 1 at smaller patient x, how) or (None, why)."""
    box = bbox(one, 1)
    sub, csp, back = coarse(one[box], axes.sp)
    dist = ndi.distance_transform_edt(sub, sampling=csp).astype(np.float32)
    mm = 1.0
    while mm <= SPLIT_MAX_MM:
        core = dist > mm
        if core.sum() < 0.1 * sub.sum():
            break
        lab, count = ndi.label(core)
        if count >= 2:
            sizes = np.bincount(lab.ravel())
            sizes[0] = 0
            a, b = np.argsort(sizes)[::-1][:2]
            if sizes[b] >= COMPARABLE * sizes[a]:
                markers = np.zeros(sub.shape, np.int32)
                markers[lab == a] = 1
                markers[lab == b] = 2
                halves = back(watershed(-dist, markers, mask=sub).astype(np.int8))
                out = np.zeros(one.shape, np.int8)
                out[box] = halves
                out[~one] = 0
                x = np.broadcast_to(axes.x(one.shape), one.shape)
                if x[out == 1].mean() > x[out == 2].mean():
                    out = np.where(out > 0, 3 - out, 0).astype(np.int8)
                return out, f"the two lungs touch; separated where the join is narrowest (after wearing {mm:.0f} mm)"
        mm += 1.0
    return None, "the two lungs touch and no narrow join was found"


def build_lungs(hu, body, airway, axes, limit, gap_mm):
    """Air inside the body that is not airway and does not reach the sides of the scan.
    Returns (lungs, right, left, notes)."""
    notes = []
    air = (hu <= limit) & body
    if airway.any():
        air &= ~within(airway, gap_mm, axes.sp) if gap_mm > 0 else ~airway
    lab, count = ndi.label(air)
    empty = np.zeros(hu.shape, bool)
    if count == 0:
        return empty, empty, empty, ["no enclosed air inside the body"]
    sizes = np.bincount(lab.ravel())
    sizes[0] = 0
    # Pieces reaching a side of the scan are the air around the patient, not lung.
    for a, n in side_faces(hu.shape, axes):
        sizes[np.unique(np.take(lab, n, axis=a))] = 0
    order = [i for i in np.argsort(sizes)[::-1][:2] if sizes[i] > 0]
    if not order:
        return empty, empty, empty, ["no enclosed air inside the body"]
    x = np.broadcast_to(axes.x(hu.shape), hu.shape)
    if len(order) == 2 and sizes[order[1]] >= COMPARABLE * sizes[order[0]]:
        a, b = lab == order[0], lab == order[1]
        if x[a].mean() > x[b].mean():
            a, b = b, a
        return a | b, a, b, notes
    one = lab == order[0]
    halves, how = split_fused(one, axes)
    notes.append(how)
    if halves is None:
        # Cut at the middle of its extent, and say so: this is a guess, not anatomy.
        xs = x[one]
        mid = (float(xs.min()) + float(xs.max())) / 2.0
        notes.append("cut at the middle of its width instead: the sides are approximate")
        return one, one & (x < mid), one & (x >= mid), notes
    return one, halves == 1, halves == 2, notes


def parse_args(argv):
    """Accept both a JSON object and a double-encoded JSON string in argv[1]."""
    if len(argv) <= 1 or not argv[1]:
        return {}
    a = json.loads(argv[1])
    if isinstance(a, str):
        a = json.loads(a)
    if not isinstance(a, dict):
        raise ValueError("input must be a JSON object")
    return a


def survey_scan(hu, body, sp):
    """Cheap facts about this scan: noise outside the body, the share of very dark
    voxels inside it (deep inspiration / emphysema), and a lung/air limit from the
    histogram valley. Returns (sigma, dark_share, lung_hu_suggestion)."""
    outside = hu[~body]
    sigma = float(outside.std()) if outside.size else 0.0
    inside = hu[body]
    dark_share = float((inside < -950).mean()) if inside.size else 0.0
    # Histogram of the body's voxels between -1000 and 0 HU, 25-HU bins; the valley
    # between the air peak and the tissue rise is where the lung limit belongs.
    hist, edges = np.histogram(np.clip(inside, -1000, 0), bins=40, range=(-1000, 0))
    centres = (edges[:-1] + edges[1:]) / 2
    air_peak = int(np.argmax(hist))
    # The last local minimum before the tissue rise: keep the deepest valley seen
    # while walking up from the air peak, stop once tissue clearly dominates.
    valley = air_peak
    for b in range(air_peak + 1, len(hist)):
        if hist[b] < hist[valley]:
            valley = b
        elif hist[b] > 3.0 * max(hist[valley], 1) and centres[b] > -750:
            break
    suggestion = float(np.clip(centres[valley], -700, -350))
    return sigma, dark_share, suggestion


def main():
    args = parse_args(sys.argv)
    lung_arg = args.get("lung_hu", -400)
    air_arg = args.get("airway_range", [-950, -850])
    auto_retry = bool(args.get("auto_retry", True))
    skip = set(args.get("skip", []))
    scale = float(args.get("expect_scale", 1.0))

    def expect(a, b):
        return (a * scale, b * scale)

    vol = load()
    full = np.asarray(vol.hu)
    axes = Axes(vol)
    sp = axes.sp
    voxel_mm3 = float(np.prod(sp))

    submit.profile(orientation="patient", unit="HU", windows=WINDOWS, disclaimer=DISCLAIMER)

    clock = [time.perf_counter()]
    box = tuple(slice(0, n) for n in full.shape)

    def out(mask, id, name, color, notes=(), **kw):
        now = time.perf_counter()
        print(f"time {id} {now - clock[0]:.1f} s", file=sys.stderr)
        print(f"{id}: {float(mask.sum()) * voxel_mm3 / 1000.0:.1f} mL" + "".join(f"\n  {n}" for n in notes))
        whole = np.zeros(full.shape, bool)
        whole[box] = mask
        submit.structure(whole, id, name, color, notes=list(notes), **kw)
        clock[0] = time.perf_counter()

    body0 = build_body(full, -400 if lung_arg == "auto" else float(lung_arg), axes)
    sigma, dark_share, valley_hu = survey_scan(full, body0, sp)
    auto_notes = [f"survey: background sigma {sigma:.0f} HU, {dark_share * 100:.0f}% of the body below -950 HU, histogram valley near {valley_hu:.0f} HU"]
    if lung_arg == "auto":
        lung_hu = valley_hu
        auto_notes.append(f"lung_hu auto -> {lung_hu:.0f} HU")
    else:
        lung_hu = float(lung_arg)
    deep = dark_share > 0.35 or sigma > 35.0
    if air_arg == "auto":
        lo, hi = ([-1000, -950] if deep else [-950, -850])
        auto_notes.append(f"airway_range auto -> [{lo:.0f}, {hi:.0f}]" + (" (deep inspiration or noisy scan: starting conservative)" if deep else ""))
    else:
        lo, hi = (float(v) for v in air_arg)
    for n in auto_notes:
        print("auto: " + n)
    del body0

    body = build_body(full, lung_hu, axes)
    out(body, "body", "体表", "#c8a48a", opacity=0.15)
    # Everything else lies inside the body: work in its box, not in the air around it.
    box = bbox(body) or box
    axes.crop(box, full.shape)
    hu, body = full[box], body[box]

    def grow_airway(hu, lo, hi, extra_notes=()):
        grow = (lo, hi, float(args.get("airway_step", 10)), float(args.get("leak_ratio", 1.6)), float(args.get("airway_max_ml", 250)))
        aw, notes, bad = build_airway(hu, body, axes, *grow)
        if bad or aw.sum() * voxel_mm3 / 1000.0 < AIRWAY_SMALL_ML * scale:
            # A noisy scan breaks the lumen up at a tight limit and lets it leak at a loose
            # one. Smoothed, the lumen holds together; both are guarded against leaks, so the
            # one that got further is the better airway.
            smooth = ndi.gaussian_filter(hu.astype(np.float32), sigma=SMOOTH_MM / sp)
            again = build_airway(smooth, body, axes, *grow)
            del smooth
            if again[2] is None and again[0].sum() > aw.sum():
                aw, notes, bad = again[0], [f"grown on the scan smoothed by {SMOOTH_MM} mm (it is noisy): " + "; ".join(again[1])], None
        return aw, list(extra_notes) + notes, bad

    airway = np.zeros(hu.shape, bool)
    airway_bad = None
    if "airway" not in skip:
        airway, notes, airway_bad = grow_airway(hu, lo, hi)
        aw_ml = airway.sum() * voxel_mm3 / 1000.0
        # The expected range takes part in the decision, not just the labelling: an
        # airway over the cap has leaked whatever the leak watcher said, and taking it
        # would hollow out the lungs. Retry tighter, at most twice.
        retries = 0
        while auto_retry and retries < 2 and (airway_bad or aw_ml > 250 * scale):
            retries += 1
            if lo <= -1000 and hi <= -950:
                break  # already at the tightest range
            # tighten towards trachea-and-main-bronchi only: [-980,-960] then [-1000,-950]
            if hi > -950:
                lo, hi = max(lo - 30, -1000), -950
            else:
                lo, hi = -1000, -950
            hi = max(hi, lo + 10)
            note = f"airway was {aw_ml:.0f} mL (cap {250 * scale:.0f} mL) or unreliable; retry {retries} with [{lo:.0f}, {hi:.0f}]"
            print("auto: " + note)
            airway, notes, airway_bad = grow_airway(hu, lo, hi, extra_notes=[note])
            aw_ml = airway.sum() * voxel_mm3 / 1000.0
        out(airway, "airway", "气道", "#f2e394", notes, expect_ml=expect(10, 250), unreliable=airway_bad)

    gap = float(args.get("airway_gap_mm", 1))
    lungs, right, left, notes = build_lungs(hu, body, airway, axes, lung_hu, gap)
    # The lungs pay for the airway's mistakes: if they came out tiny while the airway
    # is large, rebuild the airway as trachea-and-main-bronchi only and regrow.
    lung_ml = lungs.sum() * voxel_mm3 / 1000.0
    if auto_retry and "airway" not in skip and lung_ml < 1500 * scale and airway.sum() * voxel_mm3 / 1000.0 > 250 * scale:
        note = f"lungs only {lung_ml:.0f} mL with a {airway.sum() * voxel_mm3 / 1000.0:.0f} mL airway: the airway took the lungs; rebuilding it at [-1000, -950]"
        print("auto: " + note)
        airway, anotes, airway_bad = grow_airway(hu, -1000, -950, extra_notes=[note])
        out(airway, "airway", "气道", "#f2e394", anotes, expect_ml=expect(10, 250), unreliable=airway_bad)
        lungs, right, left, notes = build_lungs(hu, body, airway, axes, lung_hu, gap)
    out(lungs, "lungs", "双肺", "#4a90d9", notes, opacity=0.35, hidden=True, expect_ml=expect(1500, 9000))
    lungs_closed = closed(lungs, 5.0, sp)
    out(lungs_closed, "lungs_closed", "双肺（含血管）", "#4a90d9", hidden=True)
    out(right, "lung_right", "右肺", "#4a90d9", opacity=0.35, expect_ml=expect(700, 5000))
    out(left, "lung_left", "左肺", "#5aa9e6", opacity=0.35, expect_ml=expect(600, 4500))

    if "vessels" not in skip:
        vessels = (hu >= float(args.get("vessel_hu", -300))) & lungs_closed
        vessels = drop_small(vessels, float(args.get("vessel_min_mm3", 20)) / voxel_mm3)
        out(vessels, "vessels", "肺血管", "#e0607a")

    if "bones" not in skip:
        # Inside the body: the table and anything else lying outside the skin is not bone.
        bones = (hu >= float(args.get("bone_hu", 200))) & body & ~within(lungs, 1.0, sp)
        bones = drop_small(bones, float(args.get("bone_min_mm3", 500)) / voxel_mm3)
        keep = int(args.get("bone_keep_largest", 0))
        notes = []
        if keep > 0:
            parts = largest(bones, keep)
            bones = np.logical_or.reduce(parts) if parts else bones
            notes.append(f"kept the {keep} largest pieces")
        out(bones, "bones", "骨骼", "#e8e4d8", notes, opacity=0.6, expect_ml=expect(200, 4000))


if __name__ == "__main__":
    main()
