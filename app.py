import streamlit as st
import tempfile
import os
from moviepy import VideoFileClip, concatenate_videoclips

# --- CONFIGURAÇÃO DA PÁGINA ---
st.set_page_config(page_title="Máquina de Clips - ML", page_icon="🎬", layout="wide")

# --- CSS CUSTOMIZADO ---
st.markdown("""
<style>
    .main-header {
        text-align: center;
        padding: 1rem 0;
    }
    .clip-card {
        background-color: #1A1D24;
        border: 1px solid #2D3139;
        border-radius: 10px;
        padding: 1rem;
        margin-bottom: 0.5rem;
    }
    .clip-info {
        color: #FAFAFA;
        font-size: 0.9rem;
    }
    .stats-box {
        background: linear-gradient(135deg, #FF6B35 0%, #FF8F65 100%);
        border-radius: 10px;
        padding: 1.2rem;
        text-align: center;
        color: white;
    }
    .stats-number {
        font-size: 2rem;
        font-weight: bold;
    }
    .stats-label {
        font-size: 0.85rem;
        opacity: 0.9;
    }
    div[data-testid="stFileUploader"] {
        border: 2px dashed #FF6B35;
        border-radius: 10px;
        padding: 1rem;
    }
    .stDownloadButton > button {
        background: linear-gradient(135deg, #FF6B35 0%, #FF8F65 100%) !important;
        font-size: 1.1rem !important;
        padding: 0.8rem !important;
    }
</style>
""", unsafe_allow_html=True)


def format_duration(seconds):
    """Formata segundos em MM:SS ou HH:MM:SS."""
    seconds = int(seconds)
    if seconds >= 3600:
        h = seconds // 3600
        m = (seconds % 3600) // 60
        s = seconds % 60
        return f"{h:02d}:{m:02d}:{s:02d}"
    m = seconds // 60
    s = seconds % 60
    return f"{m:02d}:{s:02d}"


def format_size(size_bytes):
    """Formata bytes em tamanho legível."""
    if size_bytes >= 1_073_741_824:
        return f"{size_bytes / 1_073_741_824:.1f} GB"
    if size_bytes >= 1_048_576:
        return f"{size_bytes / 1_048_576:.1f} MB"
    return f"{size_bytes / 1024:.1f} KB"


def load_clip_info(file_path):
    """Carrega informações de um clipe sem manter na memória."""
    clip = VideoFileClip(file_path)
    info = {
        "duration": clip.duration,
        "size": (clip.size[0], clip.size[1]),
        "fps": clip.fps,
    }
    clip.close()
    return info


# --- HEADER ---
st.markdown('<div class="main-header">', unsafe_allow_html=True)
st.title("🎬 Montador Expresso - Meli Clips")
st.markdown("Arraste os cortes curtos aqui e monte seu vídeo longo pronto para narrar.")
st.markdown('</div>', unsafe_allow_html=True)

# --- INICIALIZA SESSION STATE ---
if "clip_order" not in st.session_state:
    st.session_state.clip_order = []
if "removed_clips" not in st.session_state:
    st.session_state.removed_clips = set()

# --- INTERFACE DE UPLOAD ---
uploaded_files = st.file_uploader(
    "Suba os vídeos curtos (MP4/MOV) na ordem que deseja:",
    type=["mp4", "mov"],
    accept_multiple_files=True,
)

if not uploaded_files:
    st.info("Arraste seus vídeos acima para começar. Formatos aceitos: MP4 e MOV.")
    st.session_state.clip_order = []
    st.session_state.removed_clips = set()
    st.stop()

# --- SINCRONIZA ORDEM DOS CLIPES ---
current_names = [f.name for f in uploaded_files]
# Limpa removidos que não existem mais
st.session_state.removed_clips = st.session_state.removed_clips & set(current_names)
# Adiciona novos clipes mantendo a ordem existente
existing_order = [n for n in st.session_state.clip_order if n in current_names]
new_names = [n for n in current_names if n not in existing_order]
st.session_state.clip_order = existing_order + new_names

# Filtra os removidos
active_names = [n for n in st.session_state.clip_order if n not in st.session_state.removed_clips]
file_map = {f.name: f for f in uploaded_files}

if not active_names:
    st.warning("Todos os clipes foram removidos. Adicione novos vídeos.")
    st.stop()

# --- ANÁLISE DOS CLIPES ---
with tempfile.TemporaryDirectory() as tmp_dir:
    clip_infos = {}
    clip_paths = {}

    for name in active_names:
        file = file_map[name]
        temp_path = os.path.join(tmp_dir, name)
        with open(temp_path, "wb") as f:
            f.write(file.read())
        clip_paths[name] = temp_path
        try:
            clip_infos[name] = load_clip_info(temp_path)
        except Exception:
            clip_infos[name] = None

    # --- ESTATÍSTICAS ---
    valid_infos = {k: v for k, v in clip_infos.items() if v is not None}
    total_duration = sum(info["duration"] for info in valid_infos.values())
    total_size = sum(file_map[name].size for name in active_names)

    st.divider()
    col1, col2, col3, col4 = st.columns(4)
    with col1:
        st.markdown(f"""<div class="stats-box">
            <div class="stats-number">{len(active_names)}</div>
            <div class="stats-label">Clipes</div>
        </div>""", unsafe_allow_html=True)
    with col2:
        st.markdown(f"""<div class="stats-box">
            <div class="stats-number">{format_duration(total_duration)}</div>
            <div class="stats-label">Duração Total</div>
        </div>""", unsafe_allow_html=True)
    with col3:
        st.markdown(f"""<div class="stats-box">
            <div class="stats-number">{format_size(total_size)}</div>
            <div class="stats-label">Tamanho Total</div>
        </div>""", unsafe_allow_html=True)
    with col4:
        if valid_infos:
            first_info = next(iter(valid_infos.values()))
            res = f"{first_info['size'][0]}x{first_info['size'][1]}"
        else:
            res = "N/A"
        st.markdown(f"""<div class="stats-box">
            <div class="stats-number">{res}</div>
            <div class="stats-label">Resolução</div>
        </div>""", unsafe_allow_html=True)

    st.divider()

    # --- LISTA DE CLIPES COM REORDENAÇÃO ---
    st.subheader("Ordem dos Clipes")
    st.caption("Use os botões para reordenar ou remover clipes da montagem.")

    for idx, name in enumerate(active_names):
        info = clip_infos.get(name)
        cols = st.columns([0.5, 4, 1.5, 1, 1, 1])

        with cols[0]:
            st.markdown(f"**{idx + 1}.**")

        with cols[1]:
            st.markdown(f"**{name}**")

        with cols[2]:
            if info:
                st.caption(f"{format_duration(info['duration'])} | {info['size'][0]}x{info['size'][1]} | {info['fps']:.0f}fps")
            else:
                st.caption("Erro ao ler clipe")

        with cols[3]:
            if idx > 0 and st.button("⬆️", key=f"up_{name}", help="Mover para cima"):
                order = st.session_state.clip_order
                full_idx = order.index(name)
                # Encontra o anterior ativo
                prev_active = None
                for i in range(full_idx - 1, -1, -1):
                    if order[i] not in st.session_state.removed_clips:
                        prev_active = i
                        break
                if prev_active is not None:
                    order[full_idx], order[prev_active] = order[prev_active], order[full_idx]
                st.rerun()

        with cols[4]:
            if idx < len(active_names) - 1 and st.button("⬇️", key=f"down_{name}", help="Mover para baixo"):
                order = st.session_state.clip_order
                full_idx = order.index(name)
                # Encontra o próximo ativo
                next_active = None
                for i in range(full_idx + 1, len(order)):
                    if order[i] not in st.session_state.removed_clips:
                        next_active = i
                        break
                if next_active is not None:
                    order[full_idx], order[next_active] = order[next_active], order[full_idx]
                st.rerun()

        with cols[5]:
            if st.button("🗑️", key=f"del_{name}", help="Remover clipe"):
                st.session_state.removed_clips.add(name)
                st.rerun()

    # --- CONFIGURAÇÕES DE SAÍDA ---
    st.divider()
    st.subheader("Configurações de Saída")

    cfg_col1, cfg_col2, cfg_col3 = st.columns(3)
    with cfg_col1:
        output_fps = st.selectbox("FPS", [24, 30, 60], index=1)
    with cfg_col2:
        output_name = st.text_input("Nome do arquivo", value="video_montado.mp4")
        if not output_name.endswith(".mp4"):
            output_name += ".mp4"
    with cfg_col3:
        codec_option = st.selectbox("Codec", ["libx264 (compatível)", "libx265 (menor)"], index=0)
        codec = "libx264" if "264" in codec_option else "libx265"

    # --- BOTÃO DE GERAR ---
    st.divider()

    if st.button("🚀 Gerar Vídeo Longo", use_container_width=True, type="primary"):
        progress_bar = st.progress(0)
        status_text = st.empty()
        clipes = []

        try:
            # 1. Carrega os clipes na ordem definida
            status_text.text("Carregando clipes na ordem definida...")
            for i, name in enumerate(active_names):
                clipes.append(VideoFileClip(clip_paths[name]))
                progress_bar.progress(int((i + 1) / len(active_names) * 30))

            # 2. Concatena
            status_text.text("Costurando os cortes (a mágica acontece aqui)...")
            video_final = concatenate_videoclips(clipes, method="compose")
            progress_bar.progress(50)

            # 3. Renderiza
            status_text.text("Renderizando o arquivo final (isso pode levar alguns segundos)...")
            output_path = os.path.join(tmp_dir, "output_final.mp4")

            video_final.write_videofile(
                output_path,
                fps=output_fps,
                codec=codec,
                audio_codec="aac",
                threads=4,
                logger=None,
            )
            progress_bar.progress(100)
            status_text.text("✅ Vídeo finalizado com sucesso!")

            # 4. Libera memória
            for clip in clipes:
                clip.close()
            video_final.close()

            # 5. Botão de download
            with open(output_path, "rb") as file_to_download:
                st.download_button(
                    label="⬇️ Baixar Vídeo Pronto",
                    data=file_to_download,
                    file_name=output_name,
                    mime="video/mp4",
                    type="primary",
                    use_container_width=True,
                )

        except Exception as e:
            # Libera memória em caso de erro
            for clip in clipes:
                try:
                    clip.close()
                except Exception:
                    pass
            st.error(f"Ocorreu um erro na montagem: {e}")
