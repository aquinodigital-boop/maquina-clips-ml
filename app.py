import streamlit as st
import tempfile
import os
from moviepy import VideoFileClip, concatenate_videoclips

# --- CONFIGURAÇÃO DA PÁGINA ---
st.set_page_config(page_title="Máquina de Clips - ML", page_icon="🎬", layout="centered")

st.title("🎬 Montador Expresso - Meli Clips")
st.markdown("Arraste os cortes curtos aqui e baixe o vídeo longo pronto para narrar.")

# --- INTERFACE DE UPLOAD ---
uploaded_files = st.file_uploader(
    "Suba os vídeos curtos (MP4) na ordem que deseja:", 
    type=["mp4", "mov"], 
    accept_multiple_files=True
)

if uploaded_files:
    st.success(f"{len(uploaded_files)} vídeos carregados com sucesso. Pronto para costurar.")
    
    if st.button("🚀 Gerar Vídeo Longo", use_container_width=True):
        
        # Cria uma barra de progresso visual para a equipe não achar que travou
        progress_bar = st.progress(0)
        status_text = st.empty()
        
        # Cria um diretório temporário isolado para não sujar o computador
        with tempfile.TemporaryDirectory() as tmp_dir:
            clipes = []
            
            try:
                # 1. Salva os arquivos upados no diretório temporário
                status_text.text("Lendo arquivos...")
                for i, file in enumerate(uploaded_files):
                    temp_path = os.path.join(tmp_dir, file.name)
                    with open(temp_path, "wb") as f:
                        f.write(file.read())
                    # Carrega na memória do moviepy
                    clipes.append(VideoFileClip(temp_path))
                    progress_bar.progress(int((i+1) / len(uploaded_files) * 30))
                
                # 2. Junta tudo
                status_text.text("Costurando os cortes (A mágica acontecendo)...")
                video_final = concatenate_videoclips(clipes, method="compose")
                progress_bar.progress(60)
                
                # 3. Renderiza o vídeo final dentro da pasta temporária
                status_text.text("Renderizando o arquivo final (Isso leva alguns segundos)...")
                output_path = os.path.join(tmp_dir, "video_longo_pronto.mp4")
                
                video_final.write_videofile(
                    output_path, 
                    fps=30, 
                    codec="libx264", 
                    audio_codec="aac",
                    threads=4,
                    logger=None # Esconde os logs do terminal na web
                )
                progress_bar.progress(100)
                status_text.text("✅ Vídeo finalizado com sucesso!")
                
                # 4. Libera a memória
                for clip in clipes:
                    clip.close()
                video_final.close()
                
                # 5. Disponibiliza o botão de Download na tela
                with open(output_path, "rb") as file_to_download:
                    st.download_button(
                        label="⬇️ Baixar Vídeo Pronto",
                        data=file_to_download,
                        file_name="video_superbowl_montado.mp4",
                        mime="video/mp4",
                        type="primary",
                        use_container_width=True
                    )
                    
            except Exception as e:
                st.error(f"Ocorreu um erro na montagem: {e}")