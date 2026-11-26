# Building structures that fit the scan (v2)

`scripts/chest_structures.py` fits an ordinary adult chest CT. Scans differ; this is how to notice and what to change. Everything about the chest lives in that script: the kernel only stores, measures and shows the masks it submits, and guards the run (time limit, no network). **You** decide what to change, through the script's input. If the input cannot express what a scan needs, write your own script from a copy of it and run that through `spatial_script` (the user approves a script you wrote); never edit the skill's file.

## What v2 does by itself

- **The expected ranges take part in the decision.** An airway above its cap (250 mL × scale) or flagged unreliable triggers an automatic retry with a tighter range, down to trachea-and-main-bronchi only (−1000..−950), at most 2 extra builds. Every retry is printed as an `auto:` note.
- **The lungs are guarded against the airway's mistakes.** If the lungs come out under 1500 mL × scale while the airway is over cap, the airway is rebuilt conservatively and the lungs regrown, automatically.
- **`"auto"` inputs.** `lung_hu: "auto"` places the air/tissue limit in the histogram valley between the air peak and the tissue rise. `airway_range: "auto"` starts conservative (−1000..−950) when the scan is deep-inspiration (over 35% of body voxels below −950 HU) or noisy (background sigma over 35 HU), and normally (−950..−850) otherwise. The survey facts are printed.
- Set `auto_retry: false` to get the original one-shot behaviour (for comparing).

**Prefer `{"lung_hu": "auto", "airway_range": "auto"}` for a first build on an unknown scan.** Explicit numbers still work exactly as before.

## The loop (for what auto did not solve)

1. **Look first** when anything seems unusual: `spatial_info` with `survey: true` gives the scanned extent, which way the axes run, a histogram (mL per 50 HU) and the background noise. The series list gives slice spacing and descriptions.
2. **Build**, then read each structure's line: volume, `UNRELIABLE`, the `auto:` notes, "runs into the … end of the scan", and the script's notes.
3. **Something still flagged** → find the cause below, change the input, run again. Change one thing at a time.
4. **Three manual tries at most** (automatic retries do not count). After that keep what is right, and tell the user which structure is unreliable and why ("the airway could not be separated from the lung in this scan"). An honest "could not" is a correct result.
5. "Runs into the end of the scan" is not an error: the structure goes on past the scanned range. Say the scan does not include all of it, and do not give its volume as the organ's volume.
6. **After a rebuild, old findings and markers may point at wrong places** (they were located on the old masks or another series). Re-verify any finding you rely on before showing it; say plainly when an old location does not survive the check.

Never invent numbers. Volumes come from the kernel's measurement; whether a volume is plausible is your judgement from the table below.

## The script's input

One JSON object (a JSON-encoded string is also accepted), every field optional:

| Field | Default | What it does |
|---|---|---|
| `lung_hu` | -400 | The limit between air and tissue, for the body's outline and the lungs. `"auto"`: histogram valley. |
| `airway_range` | [-950, -850] | The airway grows from the first limit towards the second and stops before the level where its volume jumps (a leak into the lung). `"auto"`: conservative on deep-inspiration/noisy scans. |
| `airway_step`, `leak_ratio`, `airway_max_ml` | 10, 1.6, 250 | The step between levels, the jump that counts as a leak, and the most an airway can be. |
| `airway_gap_mm` | 1 | How far around the airway is kept out of the lungs. |
| `vessel_hu`, `vessel_min_mm3` | -300, 20 | What counts as a vessel inside the lungs, and the smallest piece kept. |
| `bone_hu`, `bone_min_mm3`, `bone_keep_largest` | 200, 500, 0 | What counts as bone, the smallest piece kept, and (when above 0) how many of the largest pieces to keep. |
| `skip` | [] | Structures not to build: `airway`, `vessels`, `bones`. |
| `expect_scale` | 1.0 | Scales every expected volume. |
| `auto_retry` | true | Automatic tighter retries when a result is outside its expected range. |

## What kind of scan is it

| Sign | Means | Do |
|---|---|---|
| Series description or contrast fields say C+, CTA, 增强, arterial/venous; `bones` far over 2 L in an adult | Contrast-enhanced | `bone_hu: 350` and `bone_keep_largest: 3`, or say bones include contrast-filled vessels. Vessels inside the lung are fine as they are. |
| Background sigma above ~40; description says low dose, LDCT, 低剂量 | Low dose, noisy | `"auto"` already starts conservative. Expect ragged small vessels and bronchi. `vessel_min_mm3: 60`. Tell the user fine detail is limited. |
| Slice spacing 3 mm or more | Thick slices | Only trachea and main bronchi can be expected; small vessels break up. A small airway is expected: say detail is limited. If a thinner series exists, it should have been picked: check the series list. |
| Small extents, body volume a fraction of an adult's, age in the description | Child | `expect_scale` about the body volume ratio to an adult's (often 0.2–0.4). A child's airway is a few mL. |
| Much volume below −950 HU inside the body (the survey prints the share) | Emphysema or deep inspiration | `"auto"` starts conservative here. Large lungs are expected, not an error. If the airway is still flagged, `airway_range: [-1000, -950]` explicitly. |
| Lungs or airway run into the +z (superior) or -z (inferior) end of the volume; extent along S/I under ~250 mm | Partial scan | Normal for a targeted scan. No whole-organ volumes. |
| The airway note says no enclosed air was found at the top | The scan starts below the trachea | `skip: ["airway"]`, and say the trachea is not in the scan. |
| Values above 2500 HU in the histogram | Metal (pacemaker, wires, implant) | Structures near it are distorted by streaks: say so. |
| The lungs together well under expectation, or one lung clearly smaller than the other while still holding hundreds of mL, with everything else plausible | May be real: fluid, collapse, surgery | Do **not** tune the input until the numbers look normal. Report what was measured and that the doctor's report explains it. (The auto-guard only fires when the airway is ALSO over cap — a genuinely small lung with a normal airway is left alone.) |
| Not a chest (head, abdomen, limb) | This script does not fit | Do not run it. Say the detailed model exists for the chest only; slices and the report still work. |

Prone or feet-first scans need nothing: sides come from the scan's own orientation.

## When something is still flagged

- **airway too large after the auto retries** → it is at the tightest range already; accept the trachea-and-main-bronchi airway and say fine bronchi are not modelled. Do not loosen back.
- **airway too small** (a few mL in an adult) → raise the top of `airway_range` (−850 → −800) only if the lungs are healthy in size. On thick slices accept it.
- **lungs empty** → look at the survey: `lung_hu` should sit in the valley between the air peak and the soft-tissue peak of the histogram, usually −700 to −350; try `"auto"`.
- **the lungs' note says "the two lungs touch"** → the script already cut them apart where the join is narrowest; the two volumes are sound, the exact line between them in front of the heart is approximate. If the note says "cut at the middle of its width", the sides are a guess: say so, and do not compare left with right.
- **the lungs together have a normal volume, but one side holds nearly all of it and the other under ~100 mL** → a separation failure, not a finding (a lung that really lost its air would take the total down with it). Never report it as a collapsed or airless lung. Try `airway_gap_mm: 3`; if it stays, say the two lungs could not be told apart in this scan and give only the total.
- **bones too large** → contrast (above).

## Searching for a report finding (v2)

`scripts/locate_report_item.py` searches the **closed** lung mask (air + vessels + nodules), splits sides by the nearest air-lung mask, grows the region 3 mm outwards (nodules fused with pleura/diaphragm/heart), tolerates 4 mm for "near pleura", tries solid → ground-glass → faint densities, and matches "长径" against the longest bounding-box edge. Relaxations are printed as notes.

- If it returns candidates, **check them on the slices** before presenting; a candidate is a place to look, not a finding.
- If it returns `[]` after its own relaxations, say what was searched and ask for the report's image number and series; do not guess a place.
- If the script itself fails (a crash, or a result that contradicts the masks — e.g. the region has no voxels above −700 HU yet solid candidates are claimed), you may write your own search script from a copy; this does not count against the three-retry budget for structure builds. Say what you changed and why.
- **Image numbers belong to a series.** When the report names one (Se4/Im208), confirm the shown series is that one; `image_number` input now checks the mapped slice against the named lobe and warns on mismatch. A marker placed by number alone is "where the number points", not the finding's place.