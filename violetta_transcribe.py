"""Транскрибирует violetta_sales.wav моделью medium, сохраняет plain TXT + JSON."""
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import whisper

print("[transcribe] loading model medium ...", flush=True)
t0 = time.time()
model = whisper.load_model("medium")
print(f"[transcribe] model loaded in {time.time()-t0:.1f}s", flush=True)

wav_path = Path("violetta_sales.wav")
print(f"[transcribe] loading audio {wav_path.name} ...", flush=True)
audio, sr = sf.read(str(wav_path), dtype="float32")
if audio.ndim > 1:
    audio = audio.mean(axis=1)
print(f"[transcribe] audio: {len(audio)/sr:.1f}s @ {sr}Hz", flush=True)

print("[transcribe] transcribing ...", flush=True)
t0 = time.time()
result = model.transcribe(
    audio,
    language="ru",
    task="transcribe",
    verbose=False,
    fp16=False,
    condition_on_previous_text=True,
    temperature=0.0,
)
print(f"[transcribe] done in {time.time()-t0:.1f}s", flush=True)

# Сохраняем JSON-сегменты (для последующей диаризации)
segments = [
    {"start": s["start"], "end": s["end"], "text": s["text"].strip()}
    for s in result["segments"]
]
Path("violetta_sales.whisper.json").write_text(
    json.dumps({"language": result.get("language"), "segments": segments}, ensure_ascii=False, indent=2)
)

# Сохраняем plain TXT
Path("violetta_sales.txt").write_text("\n".join(s["text"] for s in segments))
print(f"[transcribe] wrote violetta_sales.txt ({len(segments)} segments)", flush=True)
