//! CT segmentation evaluation (docs/desktop/ct-segmentation-plan.md §5): runs the skill's chest
//! script over the phantom family (truth known, Dice) and over real studies listed in a cases file
//! (volume ranges), writes the metrics as JSON, and diffs two runs: any regression fails.
//!
//! The script is run as `spatial_script` runs it: a work directory with `volume.npy` and
//! `meta.json`, the `finx_spatial` module on PYTHONPATH, and `out/submit.jsonl` read back. The
//! interpreter is `CT_EVAL_PYTHON`, else the skill's environment under `~/.finx/cache/uv`.
//!
//! cargo run -p finx-spatial --release --example ct_eval -- run [--only NAME] [--cases FILE] [--out FILE] [--script FILE] [--args JSON]
//! cargo run -p finx-spatial --release --example ct_eval -- diff BASE.json HEAD.json
//!
//! Defaults: cases `~/ct-eval/cases.json` (missing = phantoms only), results
//! `~/ct-eval/results/<git short hash>[-dirty].json`. A cases file:
//! `[{"name": "47083958", "path": "~/Downloads/47083958.zip", "expect": {"airway": [20, 250]}}]`,
//! ranges in mL, merged over the defaults below. Real studies stay local: only metrics are kept.
#![allow(clippy::print_stdout, clippy::print_stderr)]

#[path = "../tests/common/phantom.rs"]
mod phantom;

use finx_spatial::algo::Mask;
use finx_spatial::volume::Volume;
use finx_spatial::{algo, dicom, mesh, zipsrc};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::time::Instant;

const SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../finx-core/src/skills/system/chest-ct/scripts/chest_structures.py");
const MODULE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/python");

/// What the script is run with: the interpreter, the script and its argument.
struct Runner {
    python: PathBuf,
    script: PathBuf,
    arg: String,
}

/// One structure the script submitted.
struct Built {
    id: String,
    hidden: bool,
    expect_ml: Option<(f64, f64)>,
    notes: Vec<String>,
    unreliable: Option<String>,
    mask: Mask,
}

fn npy_header(descr: &str, shape: [u32; 3]) -> Vec<u8> {
    let mut dict = format!("{{'descr': '{descr}', 'fortran_order': False, 'shape': ({}, {}, {}), }}", shape[0], shape[1], shape[2]);
    while (10 + dict.len() + 1) % 64 != 0 {
        dict.push(' ');
    }
    dict.push('\n');
    let mut out = b"\x93NUMPY\x01\x00".to_vec();
    out.extend((dict.len() as u16).to_le_bytes());
    out.extend(dict.as_bytes());
    out
}

struct Work(PathBuf);

impl Work {
    fn path(&self) -> &Path {
        &self.0
    }
}

/// Writes the work directory, runs the script and reads its structures back.
fn segment(r: &Runner, name: &str, vol: &Volume) -> Result<Vec<Built>, String> {
    // CT_EVAL_WORK=DIR keeps each case's work directory there (to run a script over it by hand).
    let temp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let kept = std::env::var("CT_EVAL_WORK").ok().map(|d| expand(&d).join(name.replace('/', "_")));
    if let Some(dir) = &kept {
        let _ = std::fs::remove_dir_all(dir.join("out"));
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let work = Work(kept.unwrap_or_else(|| temp.path().to_path_buf()));
    let i = &vol.info;
    let [ni, nj, nk] = i.dims;
    let mut bytes = npy_header("<i2", [nk, nj, ni]);
    bytes.extend(vol.values.iter().flat_map(|v| v.to_le_bytes()));
    std::fs::write(work.path().join("volume.npy"), bytes).map_err(|e| e.to_string())?;
    let meta = json!({
        "spacing": [i.spacing[2], i.spacing[1], i.spacing[0]],
        "origin": i.origin,
        "direction": i.direction.iter().flatten().collect::<Vec<_>>(),
        "unit": "HU",
        "image_numbers": (1..=nk).collect::<Vec<_>>(),
        "k_towards_head": i.direction[2][2] > 0.0,
        "masks": {},
    });
    std::fs::write(work.path().join("meta.json"), meta.to_string()).map_err(|e| e.to_string())?;
    let out = std::process::Command::new(&r.python)
        .arg(&r.script)
        .arg(&r.arg)
        .current_dir(work.path())
        .env("FINX_SPATIAL_DIR", work.path())
        .env("PYTHONPATH", MODULE)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .output()
        .map_err(|e| format!("{}: {e}", r.python.display()))?;
    print!("{}", String::from_utf8_lossy(&out.stderr).lines().filter(|l| l.starts_with("time ")).map(|l| format!("     {l}\n")).collect::<String>());
    if !out.status.success() {
        return Err(format!("the script failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    let lines = std::fs::read_to_string(work.path().join("out/submit.jsonl")).map_err(|e| format!("no submissions: {e}"))?;
    let grid = algo::Grid::of(i);
    let mut built = Vec::new();
    for line in lines.lines() {
        let v: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if v["type"] != "structure" {
            continue;
        }
        let id = v["id"].as_str().ok_or("structure without id")?.to_string();
        let raw = std::fs::read(work.path().join("out").join(v["mask"].as_str().ok_or("structure without mask")?)).map_err(|e| e.to_string())?;
        let start = 10 + u16::from_le_bytes([raw[8], raw[9]]) as usize;
        if raw.len() - start != grid.len() {
            return Err(format!("{id}: the mask has {} voxels, the volume {}", raw.len() - start, grid.len()));
        }
        built.push(Built {
            id,
            hidden: v["hidden"] == true,
            expect_ml: v["expect_ml"].as_array().and_then(|a| Some((a.first()?.as_f64()?, a.get(1)?.as_f64()?))),
            notes: v["notes"].as_array().into_iter().flatten().filter_map(|n| n.as_str().map(String::from)).collect(),
            unreliable: v["unreliable"].as_str().map(String::from),
            mask: Mask { grid: grid.clone(), data: raw[start..].iter().map(|b| *b != 0).collect() },
        });
    }
    Ok(built)
}

/// Hard ceiling for one case's recipe, ms (plan §6).
const LIMIT_MS: u64 = 120_000;

/// Plausible adult volumes, mL, for studies without truth.
fn default_ranges() -> Map<String, Value> {
    let r = |lo: f64, hi: f64| json!([lo, hi]);
    let mut m = Map::new();
    m.insert("lungs".into(), r(2000.0, 9000.0));
    m.insert("lung_right".into(), r(1000.0, 5000.0));
    m.insert("lung_left".into(), r(800.0, 4500.0));
    m.insert("airway".into(), r(20.0, 250.0));
    m.insert("bones".into(), r(200.0, 4000.0));
    m
}

/// Dice a phantom structure should reach to be called right (the summary's ✓; the diff is relative).
fn dice_floor(id: &str) -> f64 {
    match id {
        "body" | "lungs" | "lung_right" | "lung_left" => 0.9,
        _ => 0.7,
    }
}

fn home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

fn expand(p: &str) -> PathBuf {
    p.strip_prefix("~/").map_or_else(|| PathBuf::from(p), |rest| home().join(rest))
}

fn arg(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("run") => run(&args),
        Some("diff") if args.len() == 3 => diff(Path::new(&args[1]), Path::new(&args[2])),
        _ => {
            eprintln!("usage: ct_eval run [--only NAME] [--cases FILE] [--out FILE] [--script FILE] [--args JSON] | ct_eval diff BASE.json HEAD.json");
            2
        }
    };
    std::process::exit(code);
}

fn label() -> String {
    let git = |a: &[&str]| std::process::Command::new("git").args(a).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    let hash = git(&["rev-parse", "--short", "HEAD"]).filter(|h| !h.is_empty()).unwrap_or_else(|| "nogit".into());
    let dirty = git(&["status", "--porcelain"]).is_some_and(|s| !s.is_empty());
    if dirty { format!("{hash}-dirty") } else { hash }
}

fn run(args: &[String]) -> i32 {
    let only = arg(args, "--only");
    let runner = Runner {
        python: std::env::var("CT_EVAL_PYTHON").map_or_else(|_| home().join(".finx/cache/uv/envs/chest-ct/bin/python"), |p| expand(&p)),
        script: arg(args, "--script").map_or_else(|| PathBuf::from(SCRIPT), |p| expand(&p)),
        arg: arg(args, "--args").unwrap_or_default(),
    };
    let recipe = &runner;
    let json = std::fs::read_to_string(&runner.script).expect("script file");
    let want = |name: &str| only.as_deref().is_none_or(|o| name.contains(o));
    let mut cases = Vec::new();

    for v in phantom::family().into_iter().filter(|v| want(&format!("phantom/{}", v.name))) {
        let name = format!("phantom/{}", v.name);
        let t = Instant::now();
        let vol = phantom::volume(&v);
        let load_ms = t.elapsed().as_millis() as u64;
        let p = phantom::Phantom::with(v.clone());
        let truth = |id: &str, x: [f64; 3]| -> Option<bool> {
            let lung = p.in_lung(x) && !p.in_vessel(x);
            Some(match id {
                "body" => p.in_body(x),
                "lungs" => lung,
                "lung_right" => lung && x[0] < 0.0,
                "lung_left" => lung && x[0] > 0.0,
                "airway" => p.in_airway(x),
                "vessels" => p.in_lung(x) && p.in_vessel(x),
                "bones" => p.in_bone(x),
                _ => return None,
            })
        };
        cases.push(evaluate(&name, recipe, &vol, load_ms, &Map::new(), Some(&truth)));
    }

    let cases_file = arg(args, "--cases").map_or_else(|| home().join("ct-eval/cases.json"), |p| expand(&p));
    if let Ok(text) = std::fs::read_to_string(&cases_file) {
        let list: Vec<Value> = serde_json::from_str(&text).expect("cases file is a JSON array");
        for c in list {
            let name = c["name"].as_str().expect("case name").to_string();
            if !want(&name) {
                continue;
            }
            let path = expand(c["path"].as_str().expect("case path"));
            let mut ranges = default_ranges();
            if let Some(e) = c["expect"].as_object() {
                ranges.extend(e.clone());
            }
            let t = Instant::now();
            match load(&path) {
                Ok(vol) => cases.push(evaluate(&name, recipe, &vol, t.elapsed().as_millis() as u64, &ranges, None)),
                Err(e) => {
                    println!("{name}: cannot load {}: {e}", path.display());
                    cases.push(json!({"name": name, "error": format!("load: {e}")}));
                }
            }
        }
    } else {
        println!("(no cases file at {}: phantoms only)", cases_file.display());
    }

    let out = arg(args, "--out").map_or_else(|| home().join(format!("ct-eval/results/{}.json", label())), |p| expand(&p));
    std::fs::create_dir_all(out.parent().expect("parent")).expect("results dir");
    let doc = json!({"label": label(), "script_sha": finx_spatial::content_id(json.as_bytes()), "cases": cases});
    std::fs::write(&out, serde_json::to_string_pretty(&doc).expect("json")).expect("write results");
    println!("\nwrote {}", out.display());
    0
}

fn load(path: &Path) -> Result<Volume, Box<dyn std::error::Error>> {
    let source = finx_spatial::open_source(path, &zipsrc::Limits::default())?;
    let series = dicom::scan(source.as_ref())?;
    let (best, _) = dicom::pick(&series).ok_or("no usable series")?;
    let cache = tempfile::tempdir()?;
    let store = finx_spatial::build_cache(source.as_ref(), best, &cache.path().join("bricks"))?;
    Ok(Volume::from_store(&store)?)
}

type Truth<'a> = &'a dyn Fn(&str, [f64; 3]) -> Option<bool>;

fn dice(mask: &Mask, id: &str, truth: Truth) -> Option<f64> {
    let g = &mask.grid;
    truth(id, [0.0; 3])?;
    let (mut both, mut a, mut b) = (0u64, 0u64, 0u64);
    for (n, m) in mask.data.iter().enumerate() {
        let ijk = g.ijk(n);
        let t = truth(id, g.to_patient([ijk[0] as f64, ijk[1] as f64, ijk[2] as f64])).unwrap_or(false);
        a += *m as u64;
        b += t as u64;
        both += (*m && t) as u64;
    }
    Some(if a + b == 0 { 1.0 } else { 2.0 * both as f64 / (a + b) as f64 })
}

fn evaluate(name: &str, runner: &Runner, vol: &Volume, load_ms: u64, ranges: &Map<String, Value>, truth: Option<Truth>) -> Value {
    println!("\n== {name}  {:?} × {:.2?} mm  (loaded in {load_ms} ms)", vol.info.dims, vol.info.spacing);
    let t = Instant::now();
    let built = match segment(runner, name, vol) {
        Ok(b) => b,
        Err(e) => {
            println!("   ERROR {e}");
            return json!({"name": name, "error": e});
        }
    };
    let script_ms = t.elapsed().as_millis() as u64;
    // Measured and meshed as the kernel does on applying a script's structures.
    let measured: Vec<(algo::Stats, usize, Vec<&'static str>)> = std::thread::scope(|scope| {
        let jobs: Vec<_> = built
            .iter()
            .map(|b| {
                scope.spawn(move || {
                    let tris = if b.hidden { 0 } else { mesh::lods(&mesh::surface(&b.mask)).first().map_or(0, |m| m.triangles()) };
                    (algo::stats(&b.mask, None), tris, algo::cut_off(&b.mask))
                })
            })
            .collect();
        jobs.into_iter().map(|j| j.join().expect("measuring")).collect()
    });
    let total_ms = t.elapsed().as_millis() as u64;
    // CT_EVAL_DUMP=DIR: the volume (i16 LE, i fastest) and each mask (one byte a voxel) with the
    // grid in info.json, for comparing against a model outside (tools in ~/ct-eval).
    if let Ok(dir) = std::env::var("CT_EVAL_DUMP") {
        let dir = expand(&dir).join(name.replace('/', "_"));
        std::fs::create_dir_all(&dir).expect("dump dir");
        let bytes: Vec<u8> = vol.values.iter().flat_map(|v| v.to_le_bytes()).collect();
        std::fs::write(dir.join("volume.i16"), bytes).expect("dump volume");
        std::fs::write(dir.join("info.json"), serde_json::to_string(&vol.info).expect("info")).expect("dump info");
        for b in &built {
            let m: Vec<u8> = b.mask.data.iter().map(|x| *x as u8).collect();
            std::fs::write(dir.join(format!("{}.u8", b.id)), m).expect("dump mask");
        }
        println!("   dumped to {}", dir.display());
    }
    let mut structures = Map::new();
    for (b, (stats, triangles, cut_off)) in built.iter().zip(&measured) {
        let ml = stats.volume_mm3 / 1000.0;
        let d = truth.and_then(|t| dice(&b.mask, &b.id, t));
        let range = ranges.get(&b.id).and_then(|r| Some((r[0].as_f64()?, r[1].as_f64()?)));
        let in_range = range.map(|(lo, hi)| ml >= lo && ml <= hi);
        let ok = match (d, in_range) {
            (Some(d), _) => Some(d >= dice_floor(&b.id)),
            (None, Some(r)) => Some(r),
            _ => None,
        };
        // The kernel's verdict on a submitted structure. Wrong and not flagged is the worst outcome.
        let mut checks = Vec::new();
        if stats.volume_mm3 == 0.0 {
            checks.push(json!({"check": "not_empty", "ok": false, "detail": "nothing was found"}));
        } else if let Some((lo, hi)) = b.expect_ml.filter(|(lo, hi)| ml < *lo || ml > *hi) {
            checks.push(json!({"check": "volume_ml", "ok": false, "detail": format!("{ml:.0} mL, expected {lo:.0} to {hi:.0} mL")}));
        }
        if let Some(why) = &b.unreliable {
            checks.push(json!({"check": "script", "ok": false, "detail": why}));
        }
        let reliable = checks.is_empty();
        let silent_wrong = ok == Some(false) && reliable;
        let flags: Vec<String> = checks.iter().map(|c| format!("⚑ {}: {}", c["check"].as_str().unwrap_or(""), c["detail"].as_str().unwrap_or(""))).collect();
        println!(
            "   {}{} {:<13} {:>9.1} mL  {:<12} {:<16} {:>7} tris  {}{}",
            match ok { Some(true) => "✓", Some(false) => "✗", None => " " },
            if silent_wrong { "!" } else if !reliable { "⚑" } else { " " },
            b.id,
            ml,
            d.map_or(String::new(), |d| format!("dice {d:.3}")),
            range.map_or(String::new(), |(lo, hi)| format!("[{lo}, {hi}]")),
            triangles,
            flags.join("; "),
            if flags.is_empty() { b.notes.join("; ") } else { String::new() }
        );
        structures.insert(
            b.id.clone(),
            json!({"ml": ml, "dice": d, "range": range.map(|r| [r.0, r.1]), "in_range": in_range, "ok": ok,
                   "triangles": triangles, "notes": b.notes,
                   "reliable": reliable, "silent_wrong": silent_wrong, "cut_off": cut_off, "checks": checks}),
        );
    }
    println!("   script {script_ms} ms");
    println!("   total {total_ms} ms{}", if total_ms > LIMIT_MS { "  ✗ over the limit" } else { "" });
    json!({"name": name, "dims": vol.info.dims, "spacing": vol.info.spacing, "load_ms": load_ms, "total_ms": total_ms, "structures": structures})
}

/// Base vs head: what got worse. Dice down by more than 0.01, a volume leaving its range, a
/// structure no longer right, a case newly failing, or time over the ceiling or up by half (and 5 s).
fn diff(base: &Path, head: &Path) -> i32 {
    let read = |p: &Path| -> Value { serde_json::from_str(&std::fs::read_to_string(p).expect("results file")).expect("results json") };
    let (a, b) = (read(base), read(head));
    let find = |doc: &Value, name: &str| doc["cases"].as_array().and_then(|c| c.iter().find(|x| x["name"] == name).cloned());
    let mut worse = Vec::new();
    let mut better = Vec::new();
    for hc in b["cases"].as_array().into_iter().flatten() {
        let name = hc["name"].as_str().unwrap_or("?");
        let Some(bc) = find(&a, name) else {
            println!("new case {name}");
            continue;
        };
        if hc.get("error").is_some() && bc.get("error").is_none() {
            worse.push(format!("{name}: now fails: {}", hc["error"]));
            continue;
        }
        let (t0, t1) = (bc["total_ms"].as_u64().unwrap_or(0), hc["total_ms"].as_u64().unwrap_or(0));
        if t1 > LIMIT_MS || (t1 as f64 > t0 as f64 * 1.5 && t1 > t0 + 5000) {
            worse.push(format!("{name}: time {t0} → {t1} ms"));
        }
        for (id, h) in hc["structures"].as_object().into_iter().flatten() {
            let s = &bc["structures"][id];
            if s.is_null() {
                continue;
            }
            if let (Some(d0), Some(d1)) = (s["dice"].as_f64(), h["dice"].as_f64()) {
                if d1 < d0 - 0.01 {
                    worse.push(format!("{name} {id}: dice {d0:.3} → {d1:.3}"));
                } else if d1 > d0 + 0.01 {
                    better.push(format!("{name} {id}: dice {d0:.3} → {d1:.3}"));
                }
            }
            if s["in_range"] == true && h["in_range"] == false {
                worse.push(format!("{name} {id}: {:.1} mL left its range (was {:.1})", h["ml"].as_f64().unwrap_or(0.0), s["ml"].as_f64().unwrap_or(0.0)));
            }
            if h["silent_wrong"] == true && s["silent_wrong"] != true {
                worse.push(format!("{name} {id}: wrong and not flagged unreliable"));
            }
            if s["ok"] == true && h["ok"] == false {
                worse.push(format!("{name} {id}: was right, now wrong"));
            } else if s["ok"] == false && h["ok"] == true {
                better.push(format!("{name} {id}: was wrong, now right"));
            }
        }
    }
    for x in &better {
        println!("  better  {x}");
    }
    for x in &worse {
        println!("  WORSE   {x}");
    }
    println!("{} better, {} worse", better.len(), worse.len());
    i32::from(!worse.is_empty())
}
