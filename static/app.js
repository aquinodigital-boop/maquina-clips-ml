// === Estado da aplicação ===
let sessionId = null;
let clips = [];
// Cada clip: { clip_id, filename, stored_name, duration, width, height, fps, size_bytes,
//              trim_start, trim_end, uploading, expanded }

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
    const tempId = 'temp_' + Math.random().toString(36).slice(2, 8);
    const placeholder = {
        clip_id: tempId,
        filename: file.name,
        stored_name: null,
        duration: 0, width: 0, height: 0, fps: 0,
        size_bytes: file.size,
        trim_start: 0,
        trim_end: 0,
        uploading: true,
        expanded: false,
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
        const idx = clips.findIndex(c => c.clip_id === tempId);
        if (idx >= 0) {
            clips[idx] = {
                ...clipInfo,
                trim_start: 0,
                trim_end: clipInfo.duration,
                uploading: false,
                expanded: false,
            };
        }
    } catch (err) {
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
        const isTrimmed = !clip.uploading && (clip.trim_start > 0.05 || clip.trim_end < clip.duration - 0.05);
        const trimmedDuration = clip.uploading ? 0 : (clip.trim_end - clip.trim_start);

        el.className = 'clip-item' + (clip.uploading ? ' uploading' : '') + (clip.expanded ? ' expanded' : '');
        el.dataset.id = clip.clip_id;

        // Meta text
        let metaText = '';
        if (clip.uploading) {
            metaText = 'Enviando...';
        } else {
            metaText = `${formatDuration(trimmedDuration)} · ${clip.width}x${clip.height} · ${clip.fps}fps`;
            if (isTrimmed) {
                metaText += ` <span class="trim-badge">CORTADO</span>`;
            }
        }

        el.innerHTML = `
            <div class="clip-header">
                <div class="clip-handle">⠿</div>
                <div class="clip-number">${index + 1}</div>
                <div class="clip-info" onclick="toggleExpand('${clip.clip_id}')">
                    <div class="clip-name">${clip.filename}</div>
                    <div class="clip-meta">${metaText}</div>
                </div>
                <div class="clip-actions">
                    ${clip.uploading
                        ? '<div class="upload-spinner"></div>'
                        : `<button class="clip-btn ${clip.expanded ? 'active' : ''}" onclick="toggleExpand('${clip.clip_id}')" title="Cortar trecho">✂</button>
                           <button class="clip-btn delete" onclick="removeClip('${clip.clip_id}', '${clip.stored_name}')" title="Remover">✕</button>`
                    }
                </div>
            </div>
            ${!clip.uploading ? `
            <div class="trim-editor" id="trim-${clip.clip_id}">
                <video class="trim-preview" id="video-${clip.clip_id}"
                    src="/api/sessions/${sessionId}/clips/${clip.stored_name}/preview"
                    preload="metadata"></video>

                <div class="trim-range-container">
                    <div class="trim-range-track" id="track-${clip.clip_id}"
                        onmousedown="onTrackClick(event, '${clip.clip_id}')"
                        ontouchstart="onTrackClick(event, '${clip.clip_id}')">
                        <div class="trim-range-selected" id="selected-${clip.clip_id}"></div>
                        <div class="trim-range-playhead" id="playhead-${clip.clip_id}"></div>
                        <div class="trim-range-handle start" id="handle-start-${clip.clip_id}"
                            onmousedown="startDragHandle(event, '${clip.clip_id}', 'start')"
                            ontouchstart="startDragHandle(event, '${clip.clip_id}', 'start')"></div>
                        <div class="trim-range-handle end" id="handle-end-${clip.clip_id}"
                            onmousedown="startDragHandle(event, '${clip.clip_id}', 'end')"
                            ontouchstart="startDragHandle(event, '${clip.clip_id}', 'end')"></div>
                    </div>
                </div>

                <div class="trim-controls">
                    <div class="trim-time-group">
                        <label>Início</label>
                        <input class="trim-time-input" id="input-start-${clip.clip_id}"
                            value="${formatTimePrecise(clip.trim_start)}"
                            onchange="onTimeInputChange('${clip.clip_id}', 'start', this.value)">
                    </div>
                    <div class="trim-time-group">
                        <label>Fim</label>
                        <input class="trim-time-input" id="input-end-${clip.clip_id}"
                            value="${formatTimePrecise(clip.trim_end)}"
                            onchange="onTimeInputChange('${clip.clip_id}', 'end', this.value)">
                    </div>
                    <div class="trim-duration-label" id="trim-dur-${clip.clip_id}">
                        Trecho: ${formatDuration(trimmedDuration)}
                    </div>
                    <button class="trim-play-btn" onclick="playTrimmed('${clip.clip_id}')">▶ Preview</button>
                    <button class="trim-reset-btn" onclick="resetTrim('${clip.clip_id}')">Resetar</button>
                </div>
            </div>
            ` : ''}
        `;

        clipList.appendChild(el);

        // Atualiza as posições visuais do range
        if (!clip.uploading) {
            requestAnimationFrame(() => updateTrimVisuals(clip.clip_id));
        }
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
        // Duração final = soma dos trechos cortados
        const totalTrimmed = activeClips.reduce((sum, c) => sum + (c.trim_end - c.trim_start), 0);
        document.getElementById('statDuration').textContent = formatDuration(totalTrimmed);
        document.getElementById('statSize').textContent = formatSize(
            activeClips.reduce((sum, c) => sum + c.size_bytes, 0)
        );
        const first = activeClips[0];
        document.getElementById('statResolution').textContent =
            first.width ? `${first.width}x${first.height}` : '-';
    }
}

// === Trim: expand/collapse ===
function toggleExpand(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip || clip.uploading) return;

    // Fecha todos os outros
    clips.forEach(c => {
        if (c.clip_id !== clipId) c.expanded = false;
    });

    clip.expanded = !clip.expanded;
    renderClipList();

    // Se expandiu, scrollar até o clipe
    if (clip.expanded) {
        requestAnimationFrame(() => {
            const el = document.querySelector(`[data-id="${clipId}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }
}

// === Trim: visual range ===
function updateTrimVisuals(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const selected = document.getElementById(`selected-${clipId}`);
    const handleStart = document.getElementById(`handle-start-${clipId}`);
    const handleEnd = document.getElementById(`handle-end-${clipId}`);

    if (!selected || !handleStart || !handleEnd) return;

    const startPct = (clip.trim_start / clip.duration) * 100;
    const endPct = (clip.trim_end / clip.duration) * 100;

    selected.style.left = startPct + '%';
    selected.style.width = (endPct - startPct) + '%';

    handleStart.style.left = `calc(${startPct}% - 7px)`;
    handleEnd.style.left = `calc(${endPct}% - 7px)`;
}

// === Trim: drag handles ===
function startDragHandle(e, clipId, which) {
    e.preventDefault();
    e.stopPropagation();

    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const track = document.getElementById(`track-${clipId}`);
    const rect = track.getBoundingClientRect();

    function onMove(ev) {
        const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX;
        let pct = (clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        const time = pct * clip.duration;

        if (which === 'start') {
            clip.trim_start = Math.min(time, clip.trim_end - 0.1);
            clip.trim_start = Math.max(0, clip.trim_start);
        } else {
            clip.trim_end = Math.max(time, clip.trim_start + 0.1);
            clip.trim_end = Math.min(clip.duration, clip.trim_end);
        }

        updateTrimVisuals(clipId);
        updateTrimInputs(clipId);
        updateTrimDurationLabel(clipId);
        updateUI();
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
        renderClipList();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
}

// === Trim: click on track to seek ===
function onTrackClick(e, clipId) {
    if (e.target.classList.contains('trim-range-handle')) return;

    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const track = document.getElementById(`track-${clipId}`);
    const video = document.getElementById(`video-${clipId}`);
    const rect = track.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    let pct = (clientX - rect.left) / rect.width;
    pct = Math.max(0, Math.min(1, pct));
    const time = pct * clip.duration;

    if (video) {
        video.currentTime = time;
    }

    updatePlayhead(clipId, pct);
}

function updatePlayhead(clipId, pct) {
    const playhead = document.getElementById(`playhead-${clipId}`);
    if (playhead) {
        playhead.style.left = (pct * 100) + '%';
    }
}

// === Trim: time inputs ===
function updateTrimInputs(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const startInput = document.getElementById(`input-start-${clipId}`);
    const endInput = document.getElementById(`input-end-${clipId}`);
    if (startInput) startInput.value = formatTimePrecise(clip.trim_start);
    if (endInput) endInput.value = formatTimePrecise(clip.trim_end);
}

function updateTrimDurationLabel(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const label = document.getElementById(`trim-dur-${clipId}`);
    if (label) {
        label.textContent = `Trecho: ${formatDuration(clip.trim_end - clip.trim_start)}`;
    }
}

function onTimeInputChange(clipId, which, value) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const seconds = parseTime(value);
    if (isNaN(seconds)) return;

    if (which === 'start') {
        clip.trim_start = Math.max(0, Math.min(seconds, clip.trim_end - 0.1));
    } else {
        clip.trim_end = Math.min(clip.duration, Math.max(seconds, clip.trim_start + 0.1));
    }

    updateTrimVisuals(clipId);
    updateTrimInputs(clipId);
    updateTrimDurationLabel(clipId);
    updateUI();
}

// === Trim: preview & reset ===
function playTrimmed(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const video = document.getElementById(`video-${clipId}`);
    if (!video) return;

    video.currentTime = clip.trim_start;
    video.play();

    // Atualiza playhead durante a reprodução
    const playheadInterval = setInterval(() => {
        if (video.paused || video.currentTime >= clip.trim_end) {
            video.pause();
            clearInterval(playheadInterval);
            return;
        }
        const pct = video.currentTime / clip.duration;
        updatePlayhead(clipId, pct);
    }, 50);
}

function resetTrim(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    clip.trim_start = 0;
    clip.trim_end = clip.duration;

    updateTrimVisuals(clipId);
    updateTrimInputs(clipId);
    updateTrimDurationLabel(clipId);
    updateUI();
    renderClipList();
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
                clips: activeClips.map(c => ({
                    stored_name: c.stored_name,
                    trim_start: c.trim_start,
                    trim_end: c.trim_end,
                })),
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

function formatTimePrecise(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${pad(m)}:${s.toFixed(1).padStart(4, '0')}`;
}

function parseTime(str) {
    // Aceita "MM:SS.s" ou "SS.s" ou "SS"
    const parts = str.split(':');
    if (parts.length === 2) {
        return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    }
    if (parts.length === 3) {
        return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return parseFloat(str);
}

function pad(n) { return n.toString().padStart(2, '0'); }

function formatSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
}

// Keyboard: ESC fecha clipes expandidos
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        clips.forEach(c => c.expanded = false);
        renderClipList();
    }
});

// === Start ===
init();
