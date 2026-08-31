"""AI feature endpoints (profil Netra): STT token, TTS, Vision OCR, Gemini nav."""

from __future__ import annotations

import json
import logging
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from ..deps import get_settings
from ..utils import extract_ocr_text

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["ai"])

_NAV_SYSTEM_INSTRUCTION = (
    "Kamu adalah asisten navigasi untuk penyandang tunanetra di stasiun kereta Indonesia.\n"
    "Tugasmu: analisis gambar dari kamera ponsel pengguna dan berikan SATU instruksi navigasi berikutnya.\n"
    "ATURAN KETAT:\n"
    "1. Jawab HANYA dalam Bahasa Indonesia percakapan yang natural saat dibacakan TTS.\n"
    "2. Maksimal 2 kalimat pendek, total maksimal 20 kata.\n"
    "3. Selalu mulai dengan arah: \"Ke kiri\", \"Ke kanan\", \"Lurus ke depan\", atau \"Berhenti\".\n"
    "4. Sebutkan landmark yang bisa didengar/dirasakan bila terlihat: pintu, lift, eskalator, tangga, "
    "garis kuning peron, loket, palang tiket.\n"
    "5. KESELAMATAN DULU: jika terlihat garis peron, celah, atau kereta, instruksi pertama harus "
    "peringatan berhenti/menjauh.\n"
    "6. Jika gambar gelap, kabur, atau bukan area stasiun: arah = \"tidak_jelas\", minta pengguna "
    "foto ulang dengan singkat.\n"
    "7. DILARANG: berpikir keras di jawaban, bertanya balik, markdown, emoji, angka desimal, istilah teknis."
)

_NAV_FALLBACK_TEXT = (
    "Fitur navigasi kamera tidak tersedia. Gunakan tombol bantuan atau tanya petugas stasiun."
)

_NAV_INSTRUCTION_FIELDS = ("arah", "instruksi", "landmark", "percaya_diri")


def _build_nav_prompt(station_context: str, destination: str) -> str:
    """Deterministic Bahasa Indonesia prompt for the Gemini station nav call."""
    return (
        f"Konteks: pengguna tunanetra berdiri di {station_context}, menuju {destination}. "
        "Analisis gambar ini dan berikan satu instruksi navigasi berikutnya."
    )


def _extract_nav_instruction(body: Any) -> dict[str, Any] | None:
    """Best-effort extraction of the nav instruction JSON from a Gemini response."""
    try:
        candidates = body.get("candidates") or []
        first = candidates[0] if candidates else {}
        parts = (first.get("content") or {}).get("parts") or []
        text = parts[0].get("text") if parts else None
        if not isinstance(text, str) or not text.strip():
            return None
        parsed = json.loads(text)
        if not isinstance(parsed, dict):
            return None
        instruction = {field: parsed.get(field) for field in _NAV_INSTRUCTION_FIELDS}
        if not isinstance(instruction["arah"], str) or not isinstance(instruction["instruksi"], str):
            return None
        return instruction
    except (AttributeError, IndexError, KeyError, TypeError, ValueError):
        return None


@router.get("/scribe-token", response_model=None)
async def scribe_token(request: Request) -> dict[str, Any]:
    settings = get_settings(request)
    if not settings.elevenlabs_api_key:
        raise HTTPException(status_code=503, detail="ElevenLabs API key not configured")
    try:
        from elevenlabs import ElevenLabs
        client = ElevenLabs(api_key=settings.elevenlabs_api_key)
        token = client.tokens.single_use.create("realtime_scribe")
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"ElevenLabs token creation failed: {error}")
    return {"token": getattr(token, "token", str(token))}


@router.post("/tts", response_model=None)
async def tts(request: Request, payload: dict[str, Any]) -> Response:
    settings = get_settings(request)
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=422, detail="text must be a non-empty string")
    if len(text) > 5000:
        raise HTTPException(status_code=422, detail="text must be at most 5000 characters")
    if not settings.elevenlabs_api_key or not settings.elevenlabs_tts_voice_id:
        raise HTTPException(status_code=503, detail="ElevenLabs TTS not configured")
    model_id = payload.get("model_id") or "eleven_multilingual_v2"
    try:
        from elevenlabs import ElevenLabs
        client = ElevenLabs(api_key=settings.elevenlabs_api_key)
        chunks = client.text_to_speech.convert(
            voice_id=settings.elevenlabs_tts_voice_id,
            text=text,
            model_id=str(model_id),
            output_format="mp3_44100_128",
        )
        audio = b"".join(chunks)
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"ElevenLabs TTS failed: {error}")
    return Response(content=audio, media_type="audio/mpeg")


@router.post("/vision/ocr", response_model=None)
async def vision_ocr(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    """Google Cloud Vision OCR proxy for the Netra camera scan."""
    settings = get_settings(request)
    image_base64 = payload.get("image_base64")
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise HTTPException(status_code=422, detail="image_base64 must be a non-empty string")
    if len(image_base64) > 5_000_000:
        raise HTTPException(status_code=422, detail="image_base64 must be at most 5,000,000 characters")
    if not settings.google_vision_api_key:
        raise HTTPException(status_code=503, detail="Google Cloud Vision not configured")
    try:
        response = httpx.post(
            "https://vision.googleapis.com/v1/images:annotate",
            params={"key": settings.google_vision_api_key},
            json={
                "requests": [
                    {
                        "features": [{"type": "TEXT_DETECTION"}],
                        "image": {"content": image_base64},
                    }
                ]
            },
            timeout=15.0,
        )
        response.raise_for_status()
    except Exception as error:
        raise HTTPException(status_code=502, detail=f"Google Cloud Vision failed: {error}")
    return {"text": extract_ocr_text(response.json()), "source": "google-cloud-vision"}


@router.post("/vision/nav", response_model=None)
async def vision_nav(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
    """Gemini multimodal station navigation proxy for the Netra profile."""
    settings = get_settings(request)
    image_base64 = payload.get("image_base64")
    if not isinstance(image_base64, str) or not image_base64.strip():
        raise HTTPException(status_code=422, detail="image_base64 must be a non-empty string")
    if len(image_base64) > 5_000_000:
        raise HTTPException(status_code=422, detail="image_base64 must be at most 5,000,000 characters")
    if not settings.gemini_api_key:
        raise HTTPException(status_code=503, detail="Gemini vision not configured")
    station_context = payload.get("station_context")
    if not isinstance(station_context, str) or not station_context.strip():
        station_context = "stasiun"
    destination = payload.get("destination")
    if not isinstance(destination, str) or not destination.strip():
        destination = "peron"
    try:
        response = httpx.post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{settings.vision_nav_model}:generateContent",
            params={"key": settings.gemini_api_key},
            json={
                "contents": [
                    {
                        "parts": [
                            {"inline_data": {"mime_type": "image/jpeg", "data": image_base64}},
                            {"text": _build_nav_prompt(station_context, destination)},
                        ]
                    }
                ],
                "system_instruction": {"parts": [{"text": _NAV_SYSTEM_INSTRUCTION}]},
                "generationConfig": {
                    "maxOutputTokens": 150,
                    "temperature": 0.1,
                    "responseMimeType": "application/json",
                },
            },
            timeout=12.0,
        )
        response.raise_for_status()
        instruction = _extract_nav_instruction(response.json())
    except Exception as error:
        logger.warning("Gemini vision nav failed: %s", error)
        instruction = None
    if instruction is None:
        return {"source": "unavailable", "fallback_text": _NAV_FALLBACK_TEXT}
    return {
        "source": "gemini",
        "model": settings.vision_nav_model,
        "instruction": instruction,
    }
