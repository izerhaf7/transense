"""AI feature endpoints (profil Netra): STT token, TTS, Vision OCR."""

from __future__ import annotations

from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request, Response

from ..deps import get_settings
from ..utils import extract_ocr_text

router = APIRouter(prefix="/api", tags=["ai"])


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
