"""Generate the VI voice clips with edge-tts and trim leading/trailing silence with ffmpeg.

Usage:  python tools/make_voice.py
Needs:  pip install edge-tts, ffmpeg on PATH, internet (only while generating).
"""
import asyncio
import pathlib
import subprocess

import edge_tts

VOICE = "en-US-ChristopherNeural"
OUT = pathlib.Path(__file__).resolve().parent.parent / "audio"

LINES = {
    "drill-2body1head": "Two body, one head. Low ready.",
    "shooter-ready": "Shooter ready?",
    "stand-by": "Stand by.",
}

# Remove silence at the start and end so the app controls the pauses exactly.
TRIM = (
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.02,"
    "areverse,"
    "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,"
    "areverse"
)


async def main() -> None:
    OUT.mkdir(exist_ok=True)
    for name, text in LINES.items():
        raw = OUT / f"{name}.raw.mp3"
        for attempt in range(5):  # the free service occasionally returns nothing
            try:
                await edge_tts.Communicate(text, VOICE, rate="-5%").save(str(raw))
                break
            except edge_tts.exceptions.NoAudioReceived:
                if attempt == 4:
                    raise
                await asyncio.sleep(2)
        final = OUT / f"{name}.mp3"
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(raw), "-af", TRIM,
             "-ac", "1", "-ar", "44100", "-b:a", "96k", str(final)],
            check=True,
        )
        raw.unlink()
        print("wrote", final)


asyncio.run(main())
