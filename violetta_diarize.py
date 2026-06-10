"""Диаризация violetta_sales.wav + сборка TXT с диалогами."""
import json
import os
import sys
import time
from pathlib import Path

import torch

_orig_torch_load = torch.load
def _patched_load(*args, **kwargs):
    kwargs["weights_only"] = False
    return _orig_torch_load(*args, **kwargs)
torch.load = _patched_load

from pyannote.audio import Pipeline

token = os.environ.get("HF_TOKEN")
if not token:
    print("ERROR: HF_TOKEN env variable is required", file=sys.stderr)
    sys.exit(2)

wav_path = Path("violetta_sales.wav")
whisper_json = Path("violetta_sales.whisper.json")
out_txt = Path("violetta_sales_dialogue.txt")

print("[diarize] loading pipeline ...", flush=True)
t0 = time.time()
pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=token)
if torch.backends.mps.is_available():
    pipeline.to(torch.device("mps"))
    print("[diarize] using MPS", flush=True)
else:
    print("[diarize] using CPU", flush=True)
print(f"[diarize] loaded in {time.time()-t0:.1f}s", flush=True)

print(f"[diarize] processing {wav_path.name} ...", flush=True)
t0 = time.time()
diarization = pipeline(str(wav_path))
print(f"[diarize] done in {time.time()-t0:.1f}s", flush=True)

turns = []
for turn, _, speaker in diarization.itertracks(yield_label=True):
    turns.append({"start": float(turn.start), "end": float(turn.end), "speaker": speaker})

Path("violetta_sales.diarize.json").write_text(json.dumps({"turns": turns}, ensure_ascii=False, indent=2))
print(f"[diarize] {len(turns)} turns", flush=True)

# ───── собираем TXT с диалогами ─────
wh = json.loads(whisper_json.read_text())
segments = wh["segments"]


def speaker_for_segment(seg_start: float, seg_end: float) -> str:
    overlaps: dict[str, float] = {}
    for turn in turns:
        overlap = max(0.0, min(turn["end"], seg_end) - max(turn["start"], seg_start))
        if overlap > 0:
            overlaps[turn["speaker"]] = overlaps.get(turn["speaker"], 0.0) + overlap
    if overlaps:
        return max(overlaps.items(), key=lambda kv: kv[1])[0]
    # fallback — ближайший turn
    best, best_dist = "UNKNOWN", float("inf")
    mid = (seg_start + seg_end) / 2
    for turn in turns:
        if turn["start"] <= mid <= turn["end"]:
            return turn["speaker"]
        dist = min(abs(mid - turn["start"]), abs(mid - turn["end"]))
        if dist < best_dist:
            best, best_dist = turn["speaker"], dist
    return best


def fmt_time(sec: float) -> str:
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = int(sec - h * 3600 - m * 60)
    return f"{h:02d}:{m:02d}:{s:02d}"


# Метки SPEAKER_00/SPEAKER_01 → «Спикер 1»/«Спикер 2» по порядку появления
mapping: dict[str, str] = {}
counter = 1
for seg in segments:
    sp = speaker_for_segment(seg["start"], seg["end"])
    if sp not in mapping:
        mapping[sp] = f"Спикер {counter}"
        counter += 1
    seg["speaker_label"] = mapping[sp]

lines = []
current_speaker = None
current_start = None
current_text = []


def flush():
    if current_speaker and current_text:
        lines.append(f"[{fmt_time(current_start)}] {current_speaker}:")
        lines.append(" ".join(current_text).strip())
        lines.append("")


for seg in segments:
    lbl = seg["speaker_label"]
    if lbl != current_speaker:
        flush()
        current_speaker = lbl
        current_start = seg["start"]
        current_text = [seg["text"]]
    else:
        current_text.append(seg["text"])
flush()

out_txt.write_text("\n".join(lines))
print(f"[diarize] wrote {out_txt}", flush=True)
