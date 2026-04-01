// === Estado ===
let sessionId = null;
let clips = [];
let profiles = {};
let currentProfileSlug = '';
let transcribedWords = []; // { word, start, end }
let subtitleStyle = 'word_by_word';

// === Elementos ===
const dropZone = document.getElementById('dropZone');
const fileInput = document.getElementById('fileInput');
const clipList = document.getElementById('clipList');
const clipsSection = document.getElementById('clipsSection');
const statsBar = document.getElementById('statsBar');
const renderBtn = document.getElementById('renderBtn');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const downloadSection = document.getElementById('downloadSection');
const downloadBtn = document.getElementById('downloadBtn');
const previewSection = document.getElementById('previewSection');

// === Init ===
async function init() {
    const [sessionRes, profilesRes] = await Promise.all([
        fetch('/api/sessions', { method: 'POST' }),
        fetch('/api/profiles'),
    ]);
    sessionId = (await sessionRes.json()).session_id;
    profiles = await profilesRes.json();
    renderProfileSelect();
    setupDropZone();
    setupSortable();
}

// === Profiles ===
function renderProfileSelect() {
    const select = document.getElementById('profileSelect');
    select.innerHTML = '';
    for (const [slug, prof] of Object.entries(profiles)) {
        const opt = document.createElement('option');
        opt.value = slug;
        opt.textContent = prof.name;
        select.appendChild(opt);
    }
    if (!currentProfileSlug || !profiles[currentProfileSlug]) {
        currentProfileSlug = Object.keys(profiles)[0] || '';
    }
    select.value = currentProfileSlug;
    onProfileChange();
}

function onProfileChange() {
    const select = document.getElementById('profileSelect');
    currentProfileSlug = select.value;
    updateUI();
}

function getCurrentProfile() {
    return profiles[currentProfileSlug] || {};
}

function openProfileEditor(isNew) {
    const editor = document.getElementById('profileEditor');
    const title = document.getElementById('profileEditorTitle');
    const deleteBtn = document.getElementById('profDeleteBtn');
    editor.style.display = '';

    if (isNew) {
        title.textContent = 'Novo Perfil';
        deleteBtn.style.display = 'none';
        document.getElementById('profName').value = '';
        document.getElementById('profAspect').value = '1:1';
        document.getElementById('profFps').value = '30';
        document.getElementById('profCodec').value = 'libx264';
        document.getElementById('profFitMode').value = 'letterbox';
        document.getElementById('profTransition').value = 'cut';
        document.getElementById('profTransDuration').value = '0.5';
        document.getElementById('profNormAudio').checked = true;
        editor.dataset.mode = 'new';
    } else {
        const prof = getCurrentProfile();
        title.textContent = `Editar: ${prof.name || ''}`;
        deleteBtn.style.display = '';
        document.getElementById('profName').value = prof.name || '';
        document.getElementById('profAspect').value = prof.aspect_ratio || '1:1';
        document.getElementById('profFps').value = String(prof.fps || 30);
        document.getElementById('profCodec').value = prof.codec || 'libx264';
        document.getElementById('profFitMode').value = prof.fit_mode || 'letterbox';
        document.getElementById('profTransition').value = prof.transition || 'cut';
        document.getElementById('profTransDuration').value = String(prof.transition_duration || 0.5);
        document.getElementById('profNormAudio').checked = prof.normalize_audio !== false;
        editor.dataset.mode = 'edit';
    }
}

function closeProfileEditor() {
    document.getElementById('profileEditor').style.display = 'none';
}

async function saveProfile() {
    const editor = document.getElementById('profileEditor');
    const name = document.getElementById('profName').value.trim();
    if (!name) { alert('Nome do perfil é obrigatório'); return; }

    const data = {
        name,
        slug: editor.dataset.mode === 'edit' ? currentProfileSlug : undefined,
        aspect_ratio: document.getElementById('profAspect').value,
        fps: parseInt(document.getElementById('profFps').value),
        codec: document.getElementById('profCodec').value,
        fit_mode: document.getElementById('profFitMode').value,
        transition: document.getElementById('profTransition').value,
        transition_duration: parseFloat(document.getElementById('profTransDuration').value),
        normalize_audio: document.getElementById('profNormAudio').checked,
    };

    const res = await fetch('/api/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    const result = await res.json();
    profiles = await (await fetch('/api/profiles')).json();
    currentProfileSlug = result.slug;
    renderProfileSelect();
    closeProfileEditor();
}

async function deleteProfile() {
    if (!confirm(`Excluir perfil "${getCurrentProfile().name}"?`)) return;
    await fetch(`/api/profiles/${currentProfileSlug}`, { method: 'DELETE' });
    profiles = await (await fetch('/api/profiles')).json();
    currentProfileSlug = Object.keys(profiles)[0] || '';
    renderProfileSelect();
    closeProfileEditor();
}

// === Drop Zone ===
function setupDropZone() {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
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
            updateUI();
        }
    });
}

// === Upload ===
async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f =>
        f.name.toLowerCase().endsWith('.mp4') || f.name.toLowerCase().endsWith('.mov')
    );
    for (const file of files) await uploadFile(file);
}

async function uploadFile(file) {
    const tempId = 'temp_' + Math.random().toString(36).slice(2, 8);
    clips.push({
        clip_id: tempId, filename: file.name, stored_name: null,
        duration: 0, width: 0, height: 0, fps: 0, size_bytes: file.size,
        trim_start: 0, trim_end: 0, uploading: true, expanded: false,
        fit_mode: 'default', crop_anchor: 'center',
        crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1, // 0-1 percentuais
    });
    renderClipList();
    updateUI();

    try {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fetch(`/api/sessions/${sessionId}/clips`, {
            method: 'POST', body: formData,
        });
        if (!res.ok) throw new Error((await res.json()).detail || 'Erro no upload');
        const info = await res.json();
        const idx = clips.findIndex(c => c.clip_id === tempId);
        if (idx >= 0) {
            clips[idx] = {
                ...info, trim_start: 0, trim_end: info.duration,
                uploading: false, expanded: false,
                fit_mode: 'default', crop_anchor: 'center',
                crop_x: 0, crop_y: 0, crop_w: 1, crop_h: 1,
            };
        }
    } catch (err) {
        clips = clips.filter(c => c.clip_id !== tempId);
        alert(`Erro ao enviar "${file.name}": ${err.message}`);
    }
    renderClipList();
    updateUI();
}

// === Clip List ===
function renderClipList() {
    clipList.innerHTML = '';
    const prof = getCurrentProfile();
    const targetAR = prof.aspect_ratio || '1:1';
    const [arW, arH] = targetAR.split(':').map(Number);
    const targetRatio = arW / arH;

    clips.forEach((clip, index) => {
        const el = document.createElement('div');
        const isTrimmed = !clip.uploading && (clip.trim_start > 0.05 || clip.trim_end < clip.duration - 0.05);
        const trimmedDuration = clip.uploading ? 0 : (clip.trim_end - clip.trim_start);

        // Check resolution mismatch
        let resMismatch = false;
        if (!clip.uploading && clip.width && clip.height) {
            const clipRatio = clip.width / clip.height;
            resMismatch = Math.abs(clipRatio - targetRatio) > 0.05;
        }

        el.className = 'clip-item'
            + (clip.uploading ? ' uploading' : '')
            + (clip.expanded ? ' expanded' : '')
            + (resMismatch ? ' resolution-mismatch' : '');
        el.dataset.id = clip.clip_id;

        const hasCrop = !clip.uploading && (clip.crop_x > 0.01 || clip.crop_y > 0.01 || clip.crop_w < 0.99 || clip.crop_h < 0.99);

        let metaText = '';
        if (clip.uploading) {
            metaText = 'Enviando...';
        } else {
            metaText = `${formatDuration(trimmedDuration)} · ${clip.width}x${clip.height} · ${clip.fps}fps`;
            if (isTrimmed) metaText += ' <span class="trim-badge">CORTADO</span>';
            if (hasCrop) metaText += ' <span class="trim-badge">RECORTADO</span>';
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
                           <button class="clip-btn delete" onclick="removeClip('${clip.clip_id}', '${clip.stored_name}')" title="Remover">✕</button>`}
                </div>
            </div>
            ${!clip.uploading ? `
            <div class="trim-editor">
                <div class="video-crop-container" id="crop-container-${clip.clip_id}">
                    <video class="trim-preview" id="video-${clip.clip_id}"
                        src="/api/sessions/${sessionId}/clips/${clip.stored_name}/preview"
                        preload="metadata"
                        onloadedmetadata="initCropOverlay('${clip.clip_id}')"></video>
                    <div class="crop-overlay" id="crop-overlay-${clip.clip_id}">
                        <div class="crop-dim crop-dim-top"></div>
                        <div class="crop-dim crop-dim-bottom"></div>
                        <div class="crop-dim crop-dim-left"></div>
                        <div class="crop-dim crop-dim-right"></div>
                        <div class="crop-box" id="crop-box-${clip.clip_id}"
                            onmousedown="startCropDrag(event, '${clip.clip_id}', 'move')">
                            <div class="crop-handle crop-handle-nw" onmousedown="startCropDrag(event, '${clip.clip_id}', 'nw')"></div>
                            <div class="crop-handle crop-handle-n" onmousedown="startCropDrag(event, '${clip.clip_id}', 'n')"></div>
                            <div class="crop-handle crop-handle-ne" onmousedown="startCropDrag(event, '${clip.clip_id}', 'ne')"></div>
                            <div class="crop-handle crop-handle-w" onmousedown="startCropDrag(event, '${clip.clip_id}', 'w')"></div>
                            <div class="crop-handle crop-handle-e" onmousedown="startCropDrag(event, '${clip.clip_id}', 'e')"></div>
                            <div class="crop-handle crop-handle-sw" onmousedown="startCropDrag(event, '${clip.clip_id}', 'sw')"></div>
                            <div class="crop-handle crop-handle-s" onmousedown="startCropDrag(event, '${clip.clip_id}', 's')"></div>
                            <div class="crop-handle crop-handle-se" onmousedown="startCropDrag(event, '${clip.clip_id}', 'se')"></div>
                            <div class="crop-info" id="crop-info-${clip.clip_id}"></div>
                        </div>
                    </div>
                </div>

                <div class="crop-toolbar">
                    <button class="crop-preset-btn" onclick="setCropPreset('${clip.clip_id}', 'full')">100%</button>
                    <button class="crop-preset-btn" onclick="setCropPreset('${clip.clip_id}', 'center-50')">Centro 50%</button>
                    <button class="crop-preset-btn" onclick="setCropPreset('${clip.clip_id}', 'ar-profile')">Ajustar ${targetAR}</button>
                    <span class="crop-size-label" id="crop-size-${clip.clip_id}"></span>
                </div>

                <div class="trim-range-container">
                    <div class="trim-range-track" id="track-${clip.clip_id}"
                        onmousedown="onTrackClick(event, '${clip.clip_id}')">
                        <div class="trim-range-selected" id="selected-${clip.clip_id}"></div>
                        <div class="trim-range-playhead" id="playhead-${clip.clip_id}"></div>
                        <div class="trim-range-handle start"
                            onmousedown="startDragHandle(event, '${clip.clip_id}', 'start')"></div>
                        <div class="trim-range-handle end"
                            onmousedown="startDragHandle(event, '${clip.clip_id}', 'end')"></div>
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
                    <button class="trim-reset-btn" onclick="resetTrim('${clip.clip_id}')">Resetar tudo</button>
                </div>` : ''}
        `;
        clipList.appendChild(el);

        if (!clip.uploading) {
            requestAnimationFrame(() => updateTrimVisuals(clip.clip_id));
        }
    });
}

function updateUI() {
    const active = clips.filter(c => !c.uploading);
    const hasClips = active.length > 0;

    clipsSection.style.display = hasClips ? '' : 'none';
    statsBar.style.display = hasClips ? '' : 'none';
    renderBtn.style.display = hasClips ? '' : 'none';
    previewSection.style.display = hasClips ? '' : 'none';
    document.getElementById('telegramSection').style.display = hasClips ? '' : 'none';
    document.getElementById('subtitlesSection').style.display = hasClips ? '' : 'none';

    const prof = getCurrentProfile();

    if (hasClips) {
        document.getElementById('statClips').textContent = active.length;
        const totalTrimmed = active.reduce((s, c) => s + (c.trim_end - c.trim_start), 0);
        document.getElementById('statDuration').textContent = formatDuration(totalTrimmed);
        document.getElementById('statAspect').textContent = prof.aspect_ratio || '1:1';

        const transLabels = { cut: 'Corte', fade: 'Fade', dissolve: 'Dissolve', flash: 'Flash' };
        document.getElementById('statTransition').textContent = transLabels[prof.transition] || 'Corte';

        // Warnings
        checkResolutionWarnings(active, prof);

        // Preview timeline
        renderPreviewTimeline(active, prof);
    }
}

function checkResolutionWarnings(active, prof) {
    const warningsDiv = document.getElementById('warnings');
    const targetAR = prof.aspect_ratio || '1:1';
    const [arW, arH] = targetAR.split(':').map(Number);
    const targetRatio = arW / arH;

    const mismatched = active.filter(c => {
        if (!c.width || !c.height) return false;
        return Math.abs((c.width / c.height) - targetRatio) > 0.05;
    });

    if (mismatched.length > 0) {
        warningsDiv.style.display = '';
        warningsDiv.innerHTML = mismatched.map(c =>
            `<div class="warning-item">⚠ "${c.filename}" (${c.width}x${c.height}) será ajustado para ${targetAR} com letterbox preto</div>`
        ).join('');
    } else {
        warningsDiv.style.display = 'none';
        warningsDiv.innerHTML = '';
    }
}

function renderPreviewTimeline(active, prof) {
    const timeline = document.getElementById('previewTimeline');
    const transLabels = { cut: '|', fade: '◼', dissolve: '✕', flash: '⚡' };
    const totalDur = active.reduce((s, c) => s + (c.trim_end - c.trim_start), 0);
    let currentTime = 0;
    let html = '';

    active.forEach((clip, i) => {
        const dur = clip.trim_end - clip.trim_start;
        const widthPct = Math.max(8, (dur / totalDur) * 100);

        html += `<div class="preview-block" style="flex-basis: ${widthPct}%">
            <div class="pb-name">${clip.filename}</div>
            <div class="pb-time">${formatDuration(currentTime)} - ${formatDuration(currentTime + dur)}</div>
        </div>`;

        currentTime += dur;

        if (i < active.length - 1 && prof.transition !== 'cut') {
            html += `<div class="preview-transition">${transLabels[prof.transition] || '|'}</div>`;
        }
    });

    timeline.innerHTML = html;
}

// === Trim Functions ===
function toggleExpand(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip || clip.uploading) return;
    clips.forEach(c => { if (c.clip_id !== clipId) c.expanded = false; });
    clip.expanded = !clip.expanded;
    renderClipList();
    if (clip.expanded) {
        requestAnimationFrame(() => {
            const el = document.querySelector(`[data-id="${clipId}"]`);
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });
    }
}

function updateTrimVisuals(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const selected = document.getElementById(`selected-${clipId}`);
    if (!selected) return;
    const startPct = (clip.trim_start / clip.duration) * 100;
    const endPct = (clip.trim_end / clip.duration) * 100;
    selected.style.left = startPct + '%';
    selected.style.width = (endPct - startPct) + '%';
}

function startDragHandle(e, clipId, which) {
    e.preventDefault();
    e.stopPropagation();
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const track = document.getElementById(`track-${clipId}`);
    const rect = track.getBoundingClientRect();

    function onMove(ev) {
        const cx = ev.touches ? ev.touches[0].clientX : ev.clientX;
        let pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
        const time = pct * clip.duration;
        if (which === 'start') {
            clip.trim_start = Math.max(0, Math.min(time, clip.trim_end - 0.1));
        } else {
            clip.trim_end = Math.min(clip.duration, Math.max(time, clip.trim_start + 0.1));
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
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('touchmove', onMove);
    document.addEventListener('touchend', onUp);
}

function onTrackClick(e, clipId) {
    if (e.target.classList.contains('trim-range-handle')) return;
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const track = document.getElementById(`track-${clipId}`);
    const video = document.getElementById(`video-${clipId}`);
    const rect = track.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const pct = Math.max(0, Math.min(1, (cx - rect.left) / rect.width));
    if (video) video.currentTime = pct * clip.duration;
    const playhead = document.getElementById(`playhead-${clipId}`);
    if (playhead) playhead.style.left = (pct * 100) + '%';
}

function updateTrimInputs(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const si = document.getElementById(`input-start-${clipId}`);
    const ei = document.getElementById(`input-end-${clipId}`);
    if (si) si.value = formatTimePrecise(clip.trim_start);
    if (ei) ei.value = formatTimePrecise(clip.trim_end);
}

function updateTrimDurationLabel(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const label = document.getElementById(`trim-dur-${clipId}`);
    if (label) label.textContent = `Trecho: ${formatDuration(clip.trim_end - clip.trim_start)}`;
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

function playTrimmed(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    const video = document.getElementById(`video-${clipId}`);
    if (!video) return;
    video.currentTime = clip.trim_start;
    video.play();
    const interval = setInterval(() => {
        if (video.paused || video.currentTime >= clip.trim_end) {
            video.pause();
            clearInterval(interval);
            return;
        }
        const pct = video.currentTime / clip.duration;
        const playhead = document.getElementById(`playhead-${clipId}`);
        if (playhead) playhead.style.left = (pct * 100) + '%';
    }, 50);
}

function resetTrim(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    clip.trim_start = 0;
    clip.trim_end = clip.duration;
    clip.crop_x = 0; clip.crop_y = 0;
    clip.crop_w = 1; clip.crop_h = 1;
    renderClipList();
    updateUI();
}

// === Visual Crop Editor ===
function getVideoContentRect(clipId) {
    // Calcula a área real do conteúdo do vídeo dentro do elemento <video>
    // (descontando as barras pretas que o browser adiciona)
    const video = document.getElementById(`video-${clipId}`);
    const overlay = document.getElementById(`crop-overlay-${clipId}`);
    if (!video || !overlay) return null;

    const elemW = overlay.offsetWidth;
    const elemH = overlay.offsetHeight;
    if (elemW === 0 || elemH === 0) return null;

    const natW = video.videoWidth || 1;
    const natH = video.videoHeight || 1;
    const elemRatio = elemW / elemH;
    const videoRatio = natW / natH;

    let vx, vy, vw, vh;
    if (videoRatio > elemRatio) {
        // Vídeo mais largo que o container → barras em cima/baixo
        vw = elemW;
        vh = elemW / videoRatio;
        vx = 0;
        vy = (elemH - vh) / 2;
    } else {
        // Vídeo mais alto que o container → barras nos lados
        vh = elemH;
        vw = elemH * videoRatio;
        vx = (elemW - vw) / 2;
        vy = 0;
    }

    return { vx, vy, vw, vh };
}

function initCropOverlay(clipId) {
    updateCropOverlay(clipId);
}

function updateCropOverlay(clipId) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const vr = getVideoContentRect(clipId);
    if (!vr) return;
    const { vx, vy, vw, vh } = vr;

    const overlay = document.getElementById(`crop-overlay-${clipId}`);
    const box = document.getElementById(`crop-box-${clipId}`);
    if (!overlay || !box) return;

    const ow = overlay.offsetWidth;
    const oh = overlay.offsetHeight;

    // Posição do crop box relativa ao container (mapeada para a área do vídeo)
    const bx = vx + clip.crop_x * vw;
    const by = vy + clip.crop_y * vh;
    const bw = clip.crop_w * vw;
    const bh = clip.crop_h * vh;

    box.style.left = bx + 'px';
    box.style.top = by + 'px';
    box.style.width = bw + 'px';
    box.style.height = bh + 'px';

    // Dim areas (cobre tudo fora do crop box)
    const dimTop = overlay.querySelector('.crop-dim-top');
    const dimBottom = overlay.querySelector('.crop-dim-bottom');
    const dimLeft = overlay.querySelector('.crop-dim-left');
    const dimRight = overlay.querySelector('.crop-dim-right');

    dimTop.style.height = by + 'px';
    dimBottom.style.top = (by + bh) + 'px';
    dimBottom.style.height = (oh - by - bh) + 'px';
    dimLeft.style.top = by + 'px';
    dimLeft.style.height = bh + 'px';
    dimLeft.style.width = bx + 'px';
    dimRight.style.top = by + 'px';
    dimRight.style.height = bh + 'px';
    dimRight.style.left = (bx + bw) + 'px';
    dimRight.style.width = (ow - bx - bw) + 'px';

    // Info label
    const cropPixW = Math.round(clip.crop_w * clip.width);
    const cropPixH = Math.round(clip.crop_h * clip.height);
    const infoEl = document.getElementById(`crop-info-${clipId}`);
    if (infoEl) infoEl.textContent = `${cropPixW}x${cropPixH}`;

    const sizeEl = document.getElementById(`crop-size-${clipId}`);
    if (sizeEl) {
        const pct = Math.round(clip.crop_w * clip.crop_h * 100);
        sizeEl.textContent = `Recorte: ${cropPixW}x${cropPixH} (${pct}%)`;
    }
}

function startCropDrag(e, clipId, mode) {
    e.preventDefault();
    e.stopPropagation();

    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    const vr = getVideoContentRect(clipId);
    if (!vr) return;
    const { vx, vy, vw, vh } = vr;

    const startMouse = { x: e.clientX, y: e.clientY };
    const startCrop = {
        x: clip.crop_x, y: clip.crop_y,
        w: clip.crop_w, h: clip.crop_h,
    };

    function onMove(ev) {
        // Delta em fração da área do vídeo (não do container)
        const dx = (ev.clientX - startMouse.x) / vw;
        const dy = (ev.clientY - startMouse.y) / vh;

        let nx = startCrop.x, ny = startCrop.y;
        let nw = startCrop.w, nh = startCrop.h;

        if (mode === 'move') {
            nx = startCrop.x + dx;
            ny = startCrop.y + dy;
        } else {
            if (mode.includes('w')) { nx = startCrop.x + dx; nw = startCrop.w - dx; }
            if (mode.includes('e')) { nw = startCrop.w + dx; }
            if (mode.includes('n')) { ny = startCrop.y + dy; nh = startCrop.h - dy; }
            if (mode.includes('s')) { nh = startCrop.h + dy; }
        }

        nw = Math.max(0.05, nw);
        nh = Math.max(0.05, nh);
        nx = Math.max(0, Math.min(nx, 1 - nw));
        ny = Math.max(0, Math.min(ny, 1 - nh));
        if (nx + nw > 1) nw = 1 - nx;
        if (ny + nh > 1) nh = 1 - ny;

        clip.crop_x = nx;
        clip.crop_y = ny;
        clip.crop_w = nw;
        clip.crop_h = nh;

        updateCropOverlay(clipId);
    }

    function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        updateUI();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function setCropPreset(clipId, preset) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;

    if (preset === 'full') {
        clip.crop_x = 0; clip.crop_y = 0;
        clip.crop_w = 1; clip.crop_h = 1;
    } else if (preset === 'center-50') {
        clip.crop_x = 0.25; clip.crop_y = 0.25;
        clip.crop_w = 0.5; clip.crop_h = 0.5;
    } else if (preset === 'ar-profile') {
        const prof = getCurrentProfile();
        const [arW, arH] = (prof.aspect_ratio || '1:1').split(':').map(Number);
        const targetRatio = arW / arH;
        const clipRatio = clip.width / clip.height;
        const currentRatio = clipRatio; // original frame ratio

        if (targetRatio > currentRatio) {
            // Target wider: full width, crop height
            const cropH = currentRatio / targetRatio;
            clip.crop_x = 0;
            clip.crop_w = 1;
            clip.crop_h = cropH;
            clip.crop_y = (1 - cropH) / 2;
        } else {
            // Target taller: full height, crop width
            const cropW = targetRatio / currentRatio;
            clip.crop_y = 0;
            clip.crop_h = 1;
            clip.crop_w = cropW;
            clip.crop_x = (1 - cropW) / 2;
        }
    }

    updateCropOverlay(clipId);
    updateUI();
}


// === Actions ===
async function removeClip(clipId, storedName) {
    clips = clips.filter(c => c.clip_id !== clipId);
    renderClipList();
    updateUI();
    if (storedName) fetch(`/api/sessions/${sessionId}/clips/${storedName}`, { method: 'DELETE' });
}

// === Subtitles ===
function toggleSubtitles() {
    const enabled = document.getElementById('subtitlesEnabled').checked;
    document.getElementById('subtitlesPanel').style.display = enabled ? '' : 'none';
}

async function transcribeClips() {
    const active = clips.filter(c => !c.uploading);
    if (active.length === 0) return;

    const btn = document.querySelector('.sub-transcribe-btn');
    btn.disabled = true;
    document.getElementById('subProgress').style.display = 'flex';
    document.getElementById('subTranscribeArea').style.display = 'none';

    const language = document.getElementById('subLanguage').value;

    try {
        const res = await fetch(`/api/sessions/${sessionId}/transcribe`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clips: active.map(c => ({
                    stored_name: c.stored_name,
                    trim_start: c.trim_start,
                    trim_end: c.trim_end,
                    duration: c.trim_end - c.trim_start,
                })),
                language,
            }),
        });

        if (!res.ok) throw new Error((await res.json()).detail || 'Erro na transcrição');

        const data = await res.json();
        transcribedWords = data.words;

        // Show results
        document.getElementById('subProgress').style.display = 'none';
        document.getElementById('subStyleSection').style.display = '';
        document.getElementById('subWordsSection').style.display = '';
        document.getElementById('subTranscribeArea').style.display = '';

        const text = transcribedWords.map(w => w.word).join(' ');
        document.getElementById('subWordsText').value = text;
        document.getElementById('subWordCount').textContent = `(${transcribedWords.length} palavras)`;

    } catch (err) {
        alert(`Erro na transcrição: ${err.message}`);
        document.getElementById('subProgress').style.display = 'none';
        document.getElementById('subTranscribeArea').style.display = '';
    }

    btn.disabled = false;
}

function selectSubStyle(style) {
    subtitleStyle = style;
    document.querySelectorAll('.sub-style-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.style === style);
    });
}

function getSubtitlesConfig() {
    if (!document.getElementById('subtitlesEnabled').checked) return null;
    if (transcribedWords.length === 0) return null;

    // Re-sync words if text was edited
    const editedText = document.getElementById('subWordsText').value.trim();
    const editedWords = editedText.split(/\s+/).filter(Boolean);
    let words;

    if (editedWords.length === transcribedWords.length) {
        // Same count — just replace the text, keep timestamps
        words = transcribedWords.map((w, i) => ({
            word: editedWords[i],
            start: w.start,
            end: w.end,
        }));
    } else {
        // Different count — redistribute timestamps evenly
        const totalStart = transcribedWords[0].start;
        const totalEnd = transcribedWords[transcribedWords.length - 1].end;
        const totalDur = totalEnd - totalStart;
        const wordDur = totalDur / editedWords.length;
        words = editedWords.map((word, i) => ({
            word,
            start: round3(totalStart + i * wordDur),
            end: round3(totalStart + (i + 1) * wordDur),
        }));
    }

    return {
        enabled: true,
        words,
        style: {
            subtitle_style: subtitleStyle,
            color: document.getElementById('subColor').value,
            highlight_color: document.getElementById('subHighlightColor').value,
            position: document.getElementById('subPosition').value,
            bg_color: document.getElementById('subBg').value || null,
        },
    };
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// === Telegram ===
let telegramChatId = null;
let telegramToken = null;

function toggleTelegram() {
    const enabled = document.getElementById('telegramEnabled').checked;
    document.getElementById('telegramPanel').style.display = enabled ? '' : 'none';
}

async function connectTelegram() {
    const token = document.getElementById('telegramToken').value.trim();
    if (!token) { alert('Cole o token do bot'); return; }

    try {
        const res = await fetch('/api/telegram/connect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });

        if (!res.ok) {
            const err = await res.json();
            alert(err.detail || 'Erro ao conectar');
            return;
        }

        const data = await res.json();
        telegramToken = token;
        telegramChatId = data.chat_id;

        document.getElementById('telegramChatName').textContent = data.chat_name;
        document.getElementById('telegramSetup').style.display = 'none';
        document.getElementById('telegramConnected').style.display = 'flex';
    } catch (err) {
        alert('Erro de conexão: ' + err.message);
    }
}

function disconnectTelegram() {
    telegramToken = null;
    telegramChatId = null;
    document.getElementById('telegramSetup').style.display = '';
    document.getElementById('telegramConnected').style.display = 'none';
    document.getElementById('telegramToken').value = '';
}

function getTelegramConfig() {
    if (!document.getElementById('telegramEnabled').checked) return undefined;
    if (!telegramToken || !telegramChatId) return undefined;
    return { token: telegramToken, chat_id: telegramChatId };
}

// === Render ===
async function renderVideo() {
    const active = clips.filter(c => !c.uploading);
    if (active.length === 0) return;

    renderBtn.disabled = true;
    progressSection.style.display = '';
    downloadSection.style.display = 'none';

    const prof = getCurrentProfile();
    setProgress(15, 'Preparando renderização...');

    try {
        setProgress(25, 'Costurando os cortes e aplicando transições...');

        const res = await fetch(`/api/sessions/${sessionId}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clips: active.map(c => {
                    const hasCrop = c.crop_x > 0.01 || c.crop_y > 0.01 || c.crop_w < 0.99 || c.crop_h < 0.99;
                    return {
                        stored_name: c.stored_name,
                        trim_start: c.trim_start,
                        trim_end: c.trim_end,
                        crop: hasCrop ? {
                            x: c.crop_x, y: c.crop_y,
                            w: c.crop_w, h: c.crop_h,
                        } : undefined,
                    };
                }),
                profile: currentProfileSlug,
                telegram: getTelegramConfig(),
                subtitles: getSubtitlesConfig(),
            }),
        });

        if (!res.ok) throw new Error((await res.json()).detail || 'Erro na renderização');

        setProgress(100, 'Vídeo finalizado!');
        const result = await res.json();

        downloadBtn.href = result.download_url;
        downloadBtn.download = result.filename;
        document.getElementById('successDetail').textContent =
            `Duração: ${formatDuration(result.duration)} · Tamanho: ${formatSize(result.size_bytes)} · ${result.resolution}`;
        document.getElementById('successFilename').textContent = result.filename;

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
    const parts = str.split(':');
    if (parts.length === 2) return parseInt(parts[0]) * 60 + parseFloat(parts[1]);
    if (parts.length === 3) return parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2]);
    return parseFloat(str);
}

function pad(n) { return n.toString().padStart(2, '0'); }

function formatSize(bytes) {
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1024).toFixed(1) + ' KB';
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        clips.forEach(c => c.expanded = false);
        renderClipList();
        closeProfileEditor();
    }
});

init();
