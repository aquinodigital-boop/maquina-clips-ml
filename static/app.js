// === Estado da aplicação ===
let sessionId = null;
let clips = []; // { clip_id, filename, stored_name, duration, width, height, fps, size_bytes }

// === Elementos ===
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const clipList = document.getElementById('clipList');
const clipsSection = document.getElementById('clipsSection');
const settingsSection = document.getElementById('settingsSection');
const statsBar = document.getElementById('statsBar');
const renderBtn = document.getElementById('renderBtn');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const downloadSection = document.getElementById('downloadSection');
const downloadBtn = document.getElementById('downloadBtn');

// === Inicialização ===
async function init() {
    const res = await fetch('/api/sessions', { method: 'POST' });
    const data = await res.json();
    sessionId = data.session_id;

    setupDropZone();
    setupSortable();
}

function setupDropZone() {
    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', () => {
        handleFiles(fileInput.files);
        fileInput.value = '';
    });
}

function setupSortable() {
    new Sortable(clipList, {
        animation: 200,
        handle: '.clip-handle',
        ghostClass: 'sortable-ghost',
        dragClass: 'sortable-drag',
        onEnd: (evt) => {
            const [moved] = clips.splice(evt.oldIndex, 1);
            clips.splice(evt.newIndex, 0, moved);
            renderClipList();
        }
    });
}

// === Upload ===
async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f =>
        f.name.toLowerCase().endsWith('.mp4') || f.name.toLowerCase().endsWith('.mov')
    );

    if (files.length === 0) return;

    for (const file of files) {
        await uploadFile(file);
    }
}

async function uploadFile(file) {
    // Placeholder temporário na lista
    const tempId = 'temp_' + Math.random().toString(36).slice(2, 8);
    const placeholder = {
        clip_id: tempId,
        filename: file.name,
        stored_name: null,
        duration: 0,
        width: 0,
        height: 0,
        fps: 0,
        size_bytes: file.size,
        uploading: true,
    };
    clips.push(placeholder);
    renderClipList();
    updateUI();

    try {
        const formData = new FormData();
        formData.append('file', file);

        const res = await fetch(`/api/sessions/${sessionId}/clips`, {
            method: 'POST',
            body: formData,
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Erro no upload');
        }

        const clipInfo = await res.json();

        // Substitui o placeholder
        const idx = clips.findIndex(c => c.clip_id === tempId);
        if (idx >= 0) {
            clips[idx] = { ...clipInfo, uploading: false };
        }
    } catch (err) {
        // Remove o placeholder
        clips = clips.filter(c => c.clip_id !== tempId);
        alert(`Erro ao enviar "${file.name}": ${err.message}`);
    }

    renderClipList();
    updateUI();
}

// === Renderização da lista ===
function renderClipList() {
    clipList.innerHTML = '';

    clips.forEach((clip, index) => {
        const el = document.createElement('div');
        el.className = 'clip-item' + (clip.uploading ? ' uploading' : '');
        el.dataset.id = clip.clip_id;

        el.innerHTML = `
            <div class="clip-handle">⠿</div>
            <div class="clip-number">${index + 1}</div>
            <div class="clip-info">
                <div class="clip-name">${clip.filename}</div>
                ${clip.uploading
                    ? '<div class="clip-meta">Enviando...</div>'
                    : `<div class="clip-meta">
                        ${formatDuration(clip.duration)} · ${clip.width}×${clip.height} · ${clip.fps}fps · ${formatSize(clip.size_bytes)}
                      </div>`
                }
            </div>
            <div class="clip-actions">
                ${clip.uploading
                    ? '<div class="upload-spinner"></div>'
                    : `<button class="clip-btn" onclick="previewClip('${clip.stored_name}')" title="Preview">▶</button>
                       <button class="clip-btn delete" onclick="removeClip('${clip.clip_id}', '${clip.stored_name}')" title="Remover">✕</button>`
                }
            </div>
        `;

        clipList.appendChild(el);
    });
}

function updateUI() {
    const activeClips = clips.filter(c => !c.uploading);
    const hasClips = activeClips.length > 0;

    clipsSection.style.display = hasClips ? '' : 'none';
    settingsSection.style.display = hasClips ? '' : 'none';
    statsBar.style.display = hasClips ? '' : 'none';
    renderBtn.style.display = hasClips ? '' : 'none';

    if (hasClips) {
        document.getElementById('statClips').textContent = activeClips.length;
        document.getElementById('statDuration').textContent = formatDuration(
            activeClips.reduce((sum, c) => sum + c.duration, 0)
        );
        document.getElementById('statSize').textContent = formatSize(
            activeClips.reduce((sum, c) => sum + c.size_bytes, 0)
        );
        const first = activeClips[0];
        document.getElementById('statResolution').textContent =
            first.width ? `${first.width}×${first.height}` : '—';
    }
}

// === Ações ===
async function removeClip(clipId, storedName) {
    clips = clips.filter(c => c.clip_id !== clipId);
    renderClipList();
    updateUI();

    if (storedName) {
        fetch(`/api/sessions/${sessionId}/clips/${storedName}`, { method: 'DELETE' });
    }
}

function previewClip(storedName) {
    const modal = document.getElementById('previewModal');
    const video = document.getElementById('previewVideo');
    video.src = `/api/sessions/${sessionId}/clips/${storedName}/preview`;
    modal.style.display = 'flex';
}

function closePreview(event) {
    if (event && event.target !== event.currentTarget) return;
    const modal = document.getElementById('previewModal');
    const video = document.getElementById('previewVideo');
    video.pause();
    video.src = '';
    modal.style.display = 'none';
}

// === Renderização do vídeo ===
async function renderVideo() {
    const activeClips = clips.filter(c => !c.uploading);
    if (activeClips.length === 0) return;

    renderBtn.disabled = true;
    progressSection.style.display = '';
    downloadSection.style.display = 'none';

    setProgress(10, 'Enviando para renderização...');

    const fps = parseInt(document.getElementById('fpsSelect').value);
    const codec = document.getElementById('codecSelect').value;

    try {
        setProgress(20, 'Costurando os cortes (a mágica acontece aqui)...');

        const res = await fetch(`/api/sessions/${sessionId}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clip_order: activeClips.map(c => c.stored_name),
                fps,
                codec,
            }),
        });

        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Erro na renderização');
        }

        setProgress(100, 'Vídeo finalizado!');

        const result = await res.json();
        const fileName = document.getElementById('fileNameInput').value || 'video_montado.mp4';

        // Mostra seção de download
        downloadBtn.href = result.download_url;
        downloadBtn.download = fileName;
        document.getElementById('successDetail').textContent =
            `Duração: ${formatDuration(result.duration)} · Tamanho: ${formatSize(result.size_bytes)}`;

        progressSection.style.display = 'none';
        downloadSection.style.display = '';

    } catch (err) {
        setProgress(0, '');
        progressSection.style.display = 'none';
        alert(`Erro: ${err.message}`);
    }

    renderBtn.disabled = false;
}

function setProgress(pct, text) {
    progressFill.style.width = pct + '%';
    progressText.textContent = text;
}

// === Reset ===
function resetApp() {
    clips = [];
    renderClipList();
    updateUI();
    downloadSection.style.display = 'none';
    progressSection.style.display = 'none';

    // Nova sessão
    fetch(`/api/sessions/${sessionId}`, { method: 'DELETE' });
    fetch('/api/sessions', { method: 'POST' })
        .then(r => r.json())
        .then(data => { sessionId = data.session_id; });
}

// === Helpers ===
function formatDuration(seconds) {
    seconds = Math.round(seconds);
    if (seconds >= 3600) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}

function pad(n) { return n.toString().padStart(2, '0'); }

function formatSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
}

// Keyboard: ESC fecha o modal
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePreview();
});

// === Start ===
init();
