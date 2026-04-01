import os
import sys
import uuid
import json
import shutil
import tempfile
import httpx
import numpy as np
from datetime import datetime
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# Workaround: moviepy importa dotenv que pode falhar no Windows
_env_path = Path(__file__).parent / ".env"
if not _env_path.exists():
    _env_path.touch()

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from moviepy import (
    VideoFileClip,
    VideoClip,
    AudioFileClip,
    ImageClip,
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

# Modelo Whisper (lazy load)
_whisper_model = None


def get_whisper_model():
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel
        _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


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


# ==================== TRANSCRIPTION ====================

@app.post("/api/sessions/{session_id}/transcribe")
async def transcribe_clips(session_id: str, payload: dict):
    """Transcreve os clipes usando Whisper e retorna palavras com timestamps."""
    session_dir = UPLOAD_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(404, "Sessão não encontrada")

    clip_entries = payload.get("clips", [])
    language = payload.get("language", "pt")

    model = get_whisper_model()
    all_words = []
    time_offset = 0.0

    for entry in clip_entries:
        stored_name = entry["stored_name"]
        trim_start = entry.get("trim_start", 0)
        trim_end = entry.get("trim_end")

        path = session_dir / stored_name
        if not path.exists():
            continue

        # Extrai áudio temporário
        audio_path = session_dir / f"_audio_{stored_name}.wav"
        try:
            clip = VideoFileClip(str(path))
            if trim_end and trim_end < clip.duration:
                clip = clip.subclipped(trim_start, trim_end)
            elif trim_start > 0:
                clip = clip.subclipped(trim_start)

            if clip.audio is None:
                time_offset += clip.duration
                clip.close()
                continue

            clip.audio.write_audiofile(str(audio_path), fps=16000, logger=None)
            clip_duration = clip.duration
            clip.close()
        except Exception:
            time_offset += entry.get("duration", 0)
            continue

        # Transcreve com Whisper
        try:
            segments, _ = model.transcribe(
                str(audio_path),
                language=language,
                word_timestamps=True,
            )

            for segment in segments:
                if segment.words:
                    for word in segment.words:
                        all_words.append({
                            "word": word.word.strip(),
                            "start": round(word.start + time_offset, 3),
                            "end": round(word.end + time_offset, 3),
                        })
        except Exception:
            pass
        finally:
            audio_path.unlink(missing_ok=True)

        time_offset += clip_duration

    return {"words": all_words, "language": language}


# ==================== TELEGRAM ====================

@app.post("/api/telegram/connect")
async def telegram_connect(payload: dict):
    """Detecta o chat ID do bot Telegram usando getUpdates."""
    token = payload.get("token", "").strip()
    if not token:
        raise HTTPException(400, "Token é obrigatório")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            res = await client.get(f"https://api.telegram.org/bot{token}/getUpdates")
            data = res.json()

            if not data.get("ok"):
                raise HTTPException(400, "Token inválido. Verifique e tente novamente.")

            results = data.get("result", [])
            if not results:
                raise HTTPException(400, "Nenhuma mensagem encontrada. Mande qualquer mensagem para o bot primeiro!")

            # Pega o chat mais recente
            last = results[-1]
            chat = last.get("message", {}).get("chat", {})
            chat_id = chat.get("id")
            chat_name = chat.get("first_name", "") or chat.get("title", "") or str(chat_id)

            if not chat_id:
                raise HTTPException(400, "Não foi possível detectar o chat. Mande uma mensagem para o bot e tente novamente.")

            return {"chat_id": chat_id, "chat_name": chat_name}

    except httpx.HTTPError:
        raise HTTPException(500, "Erro ao conectar com o Telegram. Verifique sua conexão.")


async def send_telegram_notification(token, chat_id, result):
    """Envia notificação no Telegram quando o vídeo fica pronto."""
    duration_min = int(result["duration"]) // 60
    duration_sec = int(result["duration"]) % 60
    size_mb = round(result["size_bytes"] / 1048576, 1)

    text = (
        f"✅ *Vídeo pronto!*\n\n"
        f"📄 `{result['filename']}`\n"
        f"⏱ Duração: {duration_min}:{duration_sec:02d}\n"
        f"📐 Resolução: {result['resolution']}\n"
        f"📦 Tamanho: {size_mb} MB\n"
        f"🎬 Perfil: {result['profile']}"
    )

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": text,
                    "parse_mode": "Markdown",
                },
            )
    except Exception:
        pass  # Best-effort


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
        "fit_mode": payload.get("fit_mode", "letterbox"),
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


# ==================== SUBTITLE RENDERING ====================

def _get_font(size):
    """Tenta carregar uma fonte bold do sistema."""
    font_paths = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for fp in font_paths:
        if os.path.exists(fp):
            return ImageFont.truetype(fp, size)
    return ImageFont.load_default()


def create_subtitle_frame(
    text,
    highlight_word,
    video_size,
    style,
):
    """Cria um frame RGBA com a legenda renderizada via Pillow."""
    w, h = video_size
    font_size = style.get("font_size", max(28, int(h * 0.055)))
    color = style.get("color", "#FFFFFF")
    highlight_color = style.get("highlight_color", "#FF6B35")
    bg_color = style.get("bg_color", None)
    position = style.get("position", "bottom")  # top, center, bottom
    outline = style.get("outline", True)

    font = _get_font(font_size)
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    words = text.split()
    if not words:
        return np.array(img)

    # Quebra o texto em linhas que cabem na largura do vídeo
    pad_x = 20
    max_width = w - pad_x * 2
    lines = []
    current_line_words = []

    for word in words:
        test_line = " ".join(current_line_words + [word])
        bbox = draw.textbbox((0, 0), test_line, font=font)
        if bbox[2] - bbox[0] <= max_width or not current_line_words:
            current_line_words.append(word)
        else:
            lines.append(current_line_words)
            current_line_words = [word]
    if current_line_words:
        lines.append(current_line_words)

    # Calcula altura total
    line_bbox = draw.textbbox((0, 0), "Ay", font=font)
    line_h = line_bbox[3] - line_bbox[1]
    line_spacing = int(line_h * 0.3)
    total_h = len(lines) * line_h + (len(lines) - 1) * line_spacing

    pad_y = 10

    # Posição Y
    if position == "top":
        y_start = int(h * 0.06)
    elif position == "center":
        y_start = (h - total_h) // 2
    else:
        y_start = int(h * 0.85) - total_h

    # Fundo semi-transparente (cobre todas as linhas)
    if bg_color:
        # Largura máxima entre as linhas
        max_line_w = 0
        for line_words in lines:
            lt = " ".join(line_words)
            lb = draw.textbbox((0, 0), lt, font=font)
            max_line_w = max(max_line_w, lb[2] - lb[0])

        bg_x = (w - max_line_w) // 2
        bg_rect = [
            bg_x - pad_x,
            y_start - pad_y,
            bg_x + max_line_w + pad_x,
            y_start + total_h + pad_y,
        ]
        bg_r, bg_g, bg_b = _hex_to_rgb(bg_color)
        draw.rounded_rectangle(bg_rect, radius=8, fill=(bg_r, bg_g, bg_b, 180))

    # Desenha cada linha
    current_y = y_start
    for line_words in lines:
        line_text = " ".join(line_words)
        lb = draw.textbbox((0, 0), line_text, font=font)
        line_w = lb[2] - lb[0]
        current_x = (w - line_w) // 2

        for word in line_words:
            is_highlighted = (word == highlight_word)
            word_color = highlight_color if is_highlighted else color

            if outline:
                for dx in [-2, -1, 0, 1, 2]:
                    for dy in [-2, -1, 0, 1, 2]:
                        if dx != 0 or dy != 0:
                            draw.text(
                                (current_x + dx, current_y + dy),
                                word, font=font, fill="#000000",
                            )

            draw.text((current_x, current_y), word, font=font, fill=word_color)

            word_bbox = draw.textbbox((0, 0), word + " ", font=font)
            current_x += word_bbox[2] - word_bbox[0]

        current_y += line_h + line_spacing

    return np.array(img)


def _hex_to_rgb(hex_color):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i+2], 16) for i in (0, 2, 4))


def build_subtitle_clip(words, video_duration, video_size, style):
    """Cria um clip que renderiza legendas diretamente sobre o vídeo."""
    if not words:
        return None

    sub_style = style.get("subtitle_style", "word_by_word")
    group_size = style.get("words_per_group", 5 if sub_style == "highlight" else 8)

    # Pré-computa os segmentos
    if sub_style == "word_by_word":
        segments = [{"text": w["word"], "highlight": w["word"],
                     "start": w["start"], "end": w["end"]} for w in words]
    elif sub_style == "highlight":
        segments = []
        for i in range(0, len(words), group_size):
            group = words[i:i + group_size]
            phrase = " ".join(gw["word"] for gw in group)
            for gw in group:
                segments.append({"text": phrase, "highlight": gw["word"],
                                 "start": gw["start"], "end": gw["end"]})
    else:  # classic
        segments = []
        for i in range(0, len(words), group_size):
            group = words[i:i + group_size]
            phrase = " ".join(gw["word"] for gw in group)
            segments.append({"text": phrase, "highlight": None,
                             "start": group[0]["start"], "end": group[-1]["end"]})

    return {"segments": segments, "style": style, "video_size": video_size}


def burn_subtitles_into_clip(final_clip, sub_data):
    """Queima as legendas diretamente nos frames do vídeo (burn-in)."""
    if not sub_data:
        return final_clip

    segments = sub_data["segments"]
    style = sub_data["style"]
    video_size = sub_data["video_size"]

    # Cache de frames de legenda
    frame_cache = {}

    def make_frame(t):
        base_frame = final_clip.get_frame(t)

        # Encontra o segmento ativo
        for idx, seg in enumerate(segments):
            if seg["start"] <= t < seg["end"]:
                cache_key = (idx, seg["text"], seg["highlight"])
                if cache_key not in frame_cache:
                    frame_cache[cache_key] = create_subtitle_frame(
                        seg["text"], seg["highlight"], video_size, style
                    )

                sub_frame = frame_cache[cache_key]
                alpha = sub_frame[:, :, 3:4].astype(np.float32) / 255.0
                rgb = sub_frame[:, :, :3].astype(np.float32)
                base = base_frame.astype(np.float32)
                result = base * (1 - alpha) + rgb * alpha
                return result.astype(np.uint8)

        return base_frame

    new_clip = VideoClip(make_frame, duration=final_clip.duration)
    if final_clip.audio is not None:
        new_clip = new_clip.with_audio(final_clip.audio)
    return new_clip


# ==================== RENDER ====================

def parse_aspect_ratio(ar_str):
    parts = ar_str.split(":")
    return int(parts[0]), int(parts[1])


def normalize_clip_resolution(clip, target_w, target_h):
    """Redimensiona com letterbox (barras pretas) para atingir resolução alvo."""
    cw, ch = clip.size
    target_ratio = target_w / target_h
    clip_ratio = cw / ch

    if abs(clip_ratio - target_ratio) < 0.01 and cw == target_w and ch == target_h:
        return clip

    if clip_ratio > target_ratio:
        new_w = target_w
        new_h = int(target_w / clip_ratio)
    else:
        new_h = target_h
        new_w = int(target_h * clip_ratio)

    new_w = new_w - (new_w % 2)
    new_h = new_h - (new_h % 2)

    resized = clip.resized((new_w, new_h))
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
    ar_w, ar_h = parse_aspect_ratio(aspect_ratio_str)
    max_dim = max(max(c.size[0], c.size[1]) for c in source_clips)
    max_dim = min(max_dim, 1920)

    if ar_w > ar_h:
        w = max_dim
        h = int(max_dim * ar_h / ar_w)
    elif ar_h > ar_w:
        h = max_dim
        w = int(max_dim * ar_w / ar_h)
    else:
        w = h = min(max_dim, 1080)

    w = w - (w % 2)
    h = h - (h % 2)
    return w, h


def apply_transition(clips, transition_type, duration):
    if not clips or len(clips) < 2 or transition_type == "cut":
        return concatenate_videoclips(clips, method="compose")

    if transition_type == "fade":
        result_clips = []
        for i, clip in enumerate(clips):
            c = clip.with_effects([vfx.FadeIn(duration)]) if i > 0 else clip
            c = c.with_effects([vfx.FadeOut(duration)]) if i < len(clips) - 1 else c
            result_clips.append(c)
        return concatenate_videoclips(result_clips, method="compose")

    if transition_type == "dissolve":
        result_clips = []
        for i, clip in enumerate(clips):
            if i == 0:
                c = clip.with_effects([vfx.FadeOut(duration)])
            elif i == len(clips) - 1:
                c = clip.with_effects([vfx.FadeIn(duration)])
            else:
                c = clip.with_effects([vfx.FadeIn(duration), vfx.FadeOut(duration)])
            result_clips.append(c)
        return concatenate_videoclips(result_clips, padding=-duration, method="compose")

    if transition_type == "flash":
        result_clips = []
        for i, clip in enumerate(clips):
            result_clips.append(clip)
            if i < len(clips) - 1:
                flash = ColorClip(size=clip.size, color=(255, 255, 255), duration=duration)
                flash = flash.with_effects([vfx.FadeIn(duration / 2), vfx.FadeOut(duration / 2)])
                result_clips.append(flash)
        return concatenate_videoclips(result_clips, method="compose")

    return concatenate_videoclips(clips, method="compose")


def generate_output_name(profile_name, session_dir):
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

    # Subtitles config
    subtitles_config = payload.get("subtitles")

    raw_clips = []
    try:
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

            # Aplica crop visual se definido
            crop_data = entry.get("crop")
            if crop_data:
                cw, ch = clip.size
                cx = int(crop_data["x"] * cw)
                cy = int(crop_data["y"] * ch)
                cw2 = int(crop_data["w"] * cw)
                ch2 = int(crop_data["h"] * ch)
                # Garante que não saia dos limites
                cx = max(0, cx)
                cy = max(0, cy)
                cw2 = min(cw2, cw - cx)
                ch2 = min(ch2, ch - cy)
                if cw2 > 0 and ch2 > 0:
                    clip = clip.cropped(x1=cx, y1=cy, x2=cx + cw2, y2=cy + ch2)

            raw_clips.append(clip)

        target_w, target_h = get_target_resolution(aspect_ratio, raw_clips)
        normalized_clips = [
            normalize_clip_resolution(c, target_w, target_h)
            for c in raw_clips
        ]

        final = apply_transition(normalized_clips, transition, transition_duration)

        # Burn subtitles diretamente nos frames se ativado
        if subtitles_config and subtitles_config.get("enabled"):
            words = subtitles_config.get("words", [])
            style = subtitles_config.get("style", {})

            if words:
                sub_data = build_subtitle_clip(
                    words, final.duration, (target_w, target_h), style
                )
                if sub_data:
                    final = burn_subtitles_into_clip(final, sub_data)

        output_name = generate_output_name(profile_name, session_dir)
        output_path = session_dir / output_name

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

        # Telegram notification
        telegram = payload.get("telegram")
        if telegram and telegram.get("token") and telegram.get("chat_id"):
            await send_telegram_notification(
                telegram["token"], telegram["chat_id"], result
            )

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
