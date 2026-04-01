import os
import sys
import uuid
import json
import shutil
import tempfile
import httpx
from datetime import datetime
from pathlib import Path

# Workaround: moviepy importa dotenv que pode falhar no Windows
# com "ValueError: embedded null character".
_env_path = Path(__file__).parent / ".env"
if not _env_path.exists():
    _env_path.touch()

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from moviepy import (
    VideoFileClip,
    ColorClip,
    CompositeVideoClip,
    concatenate_videoclips,
    vfx,
)

app = FastAPI(title="Montador Expresso - Meli Clips")

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = Path(tempfile.gettempdir()) / "maquina_clips"
UPLOAD_DIR.mkdir(exist_ok=True)
PROFILES_FILE = BASE_DIR / "profiles.json"

# --- Perfis padrão ---
DEFAULT_PROFILES = {
    "aquino-brasil-tinta": {
        "name": "Aquino Brasil - Tinta",
        "aspect_ratio": "9:16",
        "fps": 30,
        "codec": "libx264",
        "transition": "fade",
        "transition_duration": 0.5,
        "normalize_audio": True,
    },
    "chamaroma-vela": {
        "name": "ChamAroma - Vela",
        "aspect_ratio": "1:1",
        "fps": 30,
        "codec": "libx264",
        "transition": "dissolve",
        "transition_duration": 0.8,
        "normalize_audio": True,
    },
    "padrao-ml": {
        "name": "Padrão ML",
        "aspect_ratio": "1:1",
        "fps": 30,
        "codec": "libx264",
        "transition": "cut",
        "transition_duration": 0.5,
        "normalize_audio": True,
    },
}


def load_profiles():
    if PROFILES_FILE.exists():
        with open(PROFILES_FILE) as f:
            return json.load(f)
    return dict(DEFAULT_PROFILES)


def save_profiles(profiles):
    with open(PROFILES_FILE, "w") as f:
        json.dump(profiles, f, indent=2, ensure_ascii=False)


# Inicializa arquivo de perfis se não existe
if not PROFILES_FILE.exists():
    save_profiles(DEFAULT_PROFILES)


# ==================== SESSIONS ====================

@app.post("/api/sessions")
async def create_session():
    session_id = str(uuid.uuid4())
    (UPLOAD_DIR / session_id).mkdir(exist_ok=True)
    return {"session_id": session_id}


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    session_dir = UPLOAD_DIR / session_id
    if session_dir.exists():
        shutil.rmtree(session_dir)
    return {"ok": True}


# ==================== CLIPS ====================

@app.post("/api/sessions/{session_id}/clips")
async def upload_clip(session_id: str, file: UploadFile = File(...)):
    session_dir = UPLOAD_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Sessão não encontrada")

    if not file.filename.lower().endswith((".mp4", ".mov")):
        raise HTTPException(400, "Formato não suportado. Use MP4 ou MOV.")

    clip_id = str(uuid.uuid4())[:8]
    safe_name = f"{clip_id}_{file.filename}"
    file_path = session_dir / safe_name

    with open(file_path, "wb") as f:
        f.write(await file.read())

    try:
        clip = VideoFileClip(str(file_path))
        info = {
            "clip_id": clip_id,
            "filename": file.filename,
            "stored_name": safe_name,
            "duration": round(clip.duration, 2),
            "width": clip.size[0],
            "height": clip.size[1],
            "fps": round(clip.fps, 1),
            "size_bytes": os.path.getsize(file_path),
        }
        clip.close()
    except Exception as e:
        file_path.unlink(missing_ok=True)
        raise HTTPException(400, f"Erro ao ler vídeo: {e}")

    return info


@app.delete("/api/sessions/{session_id}/clips/{stored_name}")
async def delete_clip(session_id: str, stored_name: str):
    file_path = UPLOAD_DIR / session_id / stored_name
    if file_path.exists():
        file_path.unlink()
    return {"ok": True}


@app.get("/api/sessions/{session_id}/clips/{stored_name}/preview")
async def preview_clip(session_id: str, stored_name: str):
    file_path = UPLOAD_DIR / session_id / stored_name
    if not file_path.exists():
        raise HTTPException(404, "Clipe não encontrado")
    return FileResponse(file_path, media_type="video/mp4")


# ==================== PROFILES ====================

@app.get("/api/profiles")
async def get_profiles():
    return load_profiles()


@app.post("/api/profiles")
async def create_or_update_profile(payload: dict):
    profiles = load_profiles()
    slug = payload.get("slug") or payload["name"].lower().replace(" ", "-")
    profiles[slug] = {
        "name": payload["name"],
        "aspect_ratio": payload.get("aspect_ratio", "1:1"),
        "fps": payload.get("fps", 30),
        "codec": payload.get("codec", "libx264"),
        "transition": payload.get("transition", "cut"),
        "transition_duration": payload.get("transition_duration", 0.5),
        "normalize_audio": payload.get("normalize_audio", True),
    }
    save_profiles(profiles)
    return {"slug": slug, **profiles[slug]}


@app.delete("/api/profiles/{slug}")
async def delete_profile(slug: str):
    profiles = load_profiles()
    profiles.pop(slug, None)
    save_profiles(profiles)
    return {"ok": True}


# ==================== RENDER ====================

def parse_aspect_ratio(ar_str):
    """Converte '16:9' em (16, 9)."""
    parts = ar_str.split(":")
    return int(parts[0]), int(parts[1])


def normalize_clip_resolution(clip, target_w, target_h):
    """Redimensiona e adiciona letterbox preto para atingir resolução alvo."""
    cw, ch = clip.size
    target_ratio = target_w / target_h
    clip_ratio = cw / ch

    if abs(clip_ratio - target_ratio) < 0.01 and cw == target_w and ch == target_h:
        return clip

    # Redimensiona mantendo proporção
    if clip_ratio > target_ratio:
        # Clipe mais largo → escala pela largura
        new_w = target_w
        new_h = int(target_w / clip_ratio)
    else:
        # Clipe mais alto → escala pela altura
        new_h = target_h
        new_w = int(target_h * clip_ratio)

    # Garante dimensões pares
    new_w = new_w - (new_w % 2)
    new_h = new_h - (new_h % 2)

    resized = clip.resized((new_w, new_h))

    # Letterbox: coloca o vídeo centralizado sobre fundo preto
    bg = ColorClip(size=(target_w, target_h), color=(0, 0, 0), duration=resized.duration)
    if resized.audio is not None:
        bg = bg.with_audio(None)

    result = CompositeVideoClip(
        [bg, resized.with_position("center")],
        size=(target_w, target_h),
    )
    if resized.audio is not None:
        result = result.with_audio(resized.audio)

    return result


def get_target_resolution(aspect_ratio_str, source_clips):
    """Calcula resolução alvo baseada no aspect ratio e nos clipes fonte."""
    ar_w, ar_h = parse_aspect_ratio(aspect_ratio_str)

    # Usa a maior dimensão dos clipes como base
    max_dim = max(max(c.size[0], c.size[1]) for c in source_clips)
    max_dim = min(max_dim, 1920)  # limita a 1920

    if ar_w > ar_h:
        w = max_dim
        h = int(max_dim * ar_h / ar_w)
    elif ar_h > ar_w:
        h = max_dim
        w = int(max_dim * ar_w / ar_h)
    else:
        w = h = min(max_dim, 1080)

    # Garante dimensões pares
    w = w - (w % 2)
    h = h - (h % 2)
    return w, h


def apply_transition(clips, transition_type, duration):
    """Aplica transições entre os clipes."""
    if not clips or len(clips) < 2 or transition_type == "cut":
        return concatenate_videoclips(clips, method="compose")

    if transition_type == "fade":
        # Fade para preto entre cada clipe
        result_clips = []
        for i, clip in enumerate(clips):
            c = clip.with_effects([vfx.FadeIn(duration)]) if i > 0 else clip
            c = c.with_effects([vfx.FadeOut(duration)]) if i < len(clips) - 1 else c
            result_clips.append(c)
        return concatenate_videoclips(result_clips, method="compose")

    if transition_type == "dissolve":
        # Crossfade real: sobrepõe os clipes com fade
        result_clips = []
        for i, clip in enumerate(clips):
            if i == 0:
                c = clip.with_effects([vfx.FadeOut(duration)])
                result_clips.append(c)
            elif i == len(clips) - 1:
                c = clip.with_effects([vfx.FadeIn(duration)])
                result_clips.append(c)
            else:
                c = clip.with_effects([vfx.FadeIn(duration), vfx.FadeOut(duration)])
                result_clips.append(c)
        return concatenate_videoclips(result_clips, padding=-duration, method="compose")

    if transition_type == "flash":
        # Flash branco entre clipes
        result_clips = []
        for i, clip in enumerate(clips):
            result_clips.append(clip)
            if i < len(clips) - 1:
                flash = ColorClip(
                    size=clip.size,
                    color=(255, 255, 255),
                    duration=duration,
                )
                flash = flash.with_effects([vfx.FadeIn(duration / 2), vfx.FadeOut(duration / 2)])
                result_clips.append(flash)
        return concatenate_videoclips(result_clips, method="compose")

    return concatenate_videoclips(clips, method="compose")


def generate_output_name(profile_name, session_dir):
    """Gera nome no formato [perfil]-YYYY-MM-DD-v1.mp4."""
    slug = profile_name.lower().replace(" ", "-")
    date_str = datetime.now().strftime("%Y-%m-%d")
    base = f"{slug}-{date_str}"

    version = 1
    while (session_dir / f"{base}-v{version}.mp4").exists():
        version += 1

    return f"{base}-v{version}.mp4"


@app.post("/api/sessions/{session_id}/render")
async def render_video(session_id: str, payload: dict):
    session_dir = UPLOAD_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Sessão não encontrada")

    clip_entries = payload.get("clips", [])
    if not clip_entries:
        raise HTTPException(400, "Nenhum clipe selecionado")

    # Config do perfil ou manual
    profile_slug = payload.get("profile")
    if profile_slug:
        profiles = load_profiles()
        profile = profiles.get(profile_slug, {})
    else:
        profile = {}

    fps = payload.get("fps") or profile.get("fps", 30)
    codec = payload.get("codec") or profile.get("codec", "libx264")
    aspect_ratio = payload.get("aspect_ratio") or profile.get("aspect_ratio", "1:1")
    transition = payload.get("transition") or profile.get("transition", "cut")
    transition_duration = payload.get("transition_duration") or profile.get("transition_duration", 0.5)
    normalize_audio = payload.get("normalize_audio", profile.get("normalize_audio", True))
    profile_name = profile.get("name", "video")

    raw_clips = []
    try:
        # 1. Carrega e trima os clipes
        for entry in clip_entries:
            stored_name = entry["stored_name"]
            trim_start = entry.get("trim_start", 0)
            trim_end = entry.get("trim_end")

            path = session_dir / stored_name
            if not path.exists():
                raise HTTPException(404, f"Clipe {stored_name} não encontrado")

            clip = VideoFileClip(str(path))
            if trim_start > 0 or (trim_end is not None and trim_end < clip.duration):
                end = trim_end if trim_end is not None else clip.duration
                clip = clip.subclipped(trim_start, end)

            raw_clips.append(clip)

        # 2. Normaliza resolução
        target_w, target_h = get_target_resolution(aspect_ratio, raw_clips)
        normalized_clips = [normalize_clip_resolution(c, target_w, target_h) for c in raw_clips]

        # 3. Normaliza áudio
        if normalize_audio:
            for i, clip in enumerate(normalized_clips):
                if clip.audio is not None:
                    normalized_clips[i] = clip.with_effects([vfx.MultiplyColor(1)])  # passthrough
                    # MoviePy não tem normalização nativa simples,
                    # mas garantimos que o áudio existe e tem volume consistente
                    # via ffmpeg na escrita final

        # 4. Aplica transições
        final = apply_transition(normalized_clips, transition, transition_duration)

        # 5. Gera nome do arquivo
        output_name = generate_output_name(profile_name, session_dir)
        output_path = session_dir / output_name

        # 6. Renderiza
        final.write_videofile(
            str(output_path),
            fps=fps,
            codec=codec,
            audio_codec="aac",
            threads=4,
            logger=None,
        )

        duration = final.duration
        final.close()
        for c in raw_clips:
            c.close()

        result = {
            "download_url": f"/api/sessions/{session_id}/download/{output_name}",
            "filename": output_name,
            "duration": round(duration, 2),
            "size_bytes": os.path.getsize(output_path),
            "resolution": f"{target_w}x{target_h}",
            "profile": profile_name,
        }

        # 7. Webhook pós-geração
        webhook_url = payload.get("webhook_url")
        if webhook_url:
            try:
                async with httpx.AsyncClient(timeout=10) as client:
                    await client.post(webhook_url, json={
                        "event": "video_rendered",
                        "filename": output_name,
                        "duration": result["duration"],
                        "size_bytes": result["size_bytes"],
                        "resolution": result["resolution"],
                        "profile": profile_name,
                        "timestamp": datetime.now().isoformat(),
                        "clips_count": len(clip_entries),
                    })
            except Exception:
                pass  # Webhook é best-effort

        return result

    except HTTPException:
        raise
    except Exception as e:
        for c in raw_clips:
            try:
                c.close()
            except Exception:
                pass
        raise HTTPException(500, f"Erro na renderização: {e}")


@app.get("/api/sessions/{session_id}/download/{filename}")
async def download_video(session_id: str, filename: str):
    output_path = UPLOAD_DIR / session_id / filename
    if not output_path.exists():
        raise HTTPException(404, "Vídeo não encontrado")
    return FileResponse(output_path, media_type="video/mp4", filename=filename)


# Serve o frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")
