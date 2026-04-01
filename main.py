import os
import sys
import uuid
import shutil
import tempfile
from pathlib import Path

# Workaround: moviepy importa dotenv que pode falhar no Windows
# com "ValueError: embedded null character". Garantimos que existe
# um .env válido antes do import.
_env_path = Path(__file__).parent / ".env"
if not _env_path.exists():
    _env_path.touch()

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from moviepy import VideoFileClip, concatenate_videoclips

app = FastAPI(title="Montador Expresso - Meli Clips")

# Diretório para uploads temporários por sessão
UPLOAD_DIR = Path(tempfile.gettempdir()) / "maquina_clips"
UPLOAD_DIR.mkdir(exist_ok=True)


@app.post("/api/sessions")
async def create_session():
    """Cria uma nova sessão de edição."""
    session_id = str(uuid.uuid4())
    session_dir = UPLOAD_DIR / session_id
    session_dir.mkdir(exist_ok=True)
    return {"session_id": session_id}


@app.post("/api/sessions/{session_id}/clips")
async def upload_clip(session_id: str, file: UploadFile = File(...)):
    """Faz upload de um clipe para a sessão."""
    session_dir = UPLOAD_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Sessão não encontrada")

    if not file.filename.lower().endswith((".mp4", ".mov")):
        raise HTTPException(status_code=400, detail="Formato não suportado. Use MP4 ou MOV.")

    clip_id = str(uuid.uuid4())[:8]
    safe_name = f"{clip_id}_{file.filename}"
    file_path = session_dir / safe_name

    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Extrai metadados do clipe
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
        raise HTTPException(status_code=400, detail=f"Erro ao ler vídeo: {e}")

    return info


@app.delete("/api/sessions/{session_id}/clips/{stored_name}")
async def delete_clip(session_id: str, stored_name: str):
    """Remove um clipe da sessão."""
    file_path = UPLOAD_DIR / session_id / stored_name
    if file_path.exists():
        file_path.unlink()
    return {"ok": True}


@app.get("/api/sessions/{session_id}/clips/{stored_name}/preview")
async def preview_clip(session_id: str, stored_name: str):
    """Serve o arquivo de vídeo para preview no navegador."""
    file_path = UPLOAD_DIR / session_id / stored_name
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Clipe não encontrado")
    return FileResponse(file_path, media_type="video/mp4")


@app.post("/api/sessions/{session_id}/render")
async def render_video(session_id: str, payload: dict):
    """Concatena os clipes na ordem especificada e gera o vídeo final."""
    session_dir = UPLOAD_DIR / session_id
    if not session_dir.exists():
        raise HTTPException(status_code=404, detail="Sessão não encontrada")

    clip_order = payload.get("clip_order", [])
    fps = payload.get("fps", 30)
    codec = payload.get("codec", "libx264")

    if not clip_order:
        raise HTTPException(status_code=400, detail="Nenhum clipe selecionado")

    clips = []
    try:
        for stored_name in clip_order:
            path = session_dir / stored_name
            if not path.exists():
                raise HTTPException(status_code=404, detail=f"Clipe {stored_name} não encontrado")
            clips.append(VideoFileClip(str(path)))

        final = concatenate_videoclips(clips, method="compose")
        output_path = session_dir / "output_final.mp4"

        final.write_videofile(
            str(output_path),
            fps=fps,
            codec=codec,
            audio_codec="aac",
            threads=4,
            logger=None,
        )

        final.close()
        for c in clips:
            c.close()

        return {
            "download_url": f"/api/sessions/{session_id}/download",
            "duration": round(final.duration, 2),
            "size_bytes": os.path.getsize(output_path),
        }

    except HTTPException:
        raise
    except Exception as e:
        for c in clips:
            try:
                c.close()
            except Exception:
                pass
        raise HTTPException(status_code=500, detail=f"Erro na renderização: {e}")


@app.get("/api/sessions/{session_id}/download")
async def download_video(session_id: str):
    """Baixa o vídeo renderizado."""
    output_path = UPLOAD_DIR / session_id / "output_final.mp4"
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Vídeo ainda não foi renderizado")
    return FileResponse(
        output_path,
        media_type="video/mp4",
        filename="video_montado.mp4",
    )


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Limpa todos os arquivos da sessão."""
    session_dir = UPLOAD_DIR / session_id
    if session_dir.exists():
        shutil.rmtree(session_dir)
    return {"ok": True}


# Serve o frontend
app.mount("/", StaticFiles(directory="static", html=True), name="static")
