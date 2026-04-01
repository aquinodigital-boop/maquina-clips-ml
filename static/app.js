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
const webhookSection = document.getElementById('webhookSection');

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

        let metaText = '';
        if (clip.uploading) {
            metaText = 'Enviando...';
        } else {
            metaText = `${formatDuration(trimmedDuration)} · ${clip.width}x${clip.height} · ${clip.fps}fps`;
            if (isTrimmed) metaText += ' <span class="trim-badge">CORTADO</span>';
            if (resMismatch) metaText += ` <span class="res-warn">⚠ ${clip.width}x${clip.height} → ${targetAR}</span>`;
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
                <video class="trim-preview" id="video-${clip.clip_id}"
                    src="/api/sessions/${sessionId}/clips/${clip.stored_name}/preview"
                    preload="metadata"></video>
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
                    <button class="trim-reset-btn" onclick="resetTrim('${clip.clip_id}')">Resetar</button>
                </div>
                <div class="crop-controls">
                    <div class="crop-group">
                        <label>Enquadramento</label>
                        <select id="fitmode-${clip.clip_id}" onchange="onFitModeChange('${clip.clip_id}', this.value)">
                            <option value="default" ${clip.fit_mode === 'default' ? 'selected' : ''}>Padrão do perfil</option>
                            <option value="letterbox" ${clip.fit_mode === 'letterbox' ? 'selected' : ''}>Letterbox (barras pretas)</option>
                            <option value="crop" ${clip.fit_mode === 'crop' ? 'selected' : ''}>Crop (recortar para preencher)</option>
                            <option value="stretch" ${clip.fit_mode === 'stretch' ? 'selected' : ''}>Esticar (distorce)</option>
                        </select>
                    </div>
                    <div class="crop-group" id="anchor-group-${clip.clip_id}" style="display: ${clip.fit_mode === 'crop' ? '' : 'none'}">
                        <label>Ponto de recorte</label>
                        <div class="crop-anchor-grid" id="anchor-grid-${clip.clip_id}">
                            ${['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right'].map(pos =>
                                `<button class="anchor-btn ${clip.crop_anchor === pos ? 'active' : ''}"
                                    onclick="onCropAnchorChange('${clip.clip_id}', '${pos}')"
                                    title="${pos}">
                                    <span class="anchor-dot"></span>
                                </button>`
                            ).join('')}
                        </div>
                    </div>
                    ${resMismatch ? `<div class="crop-warning">⚠ ${clip.width}x${clip.height} → ${targetAR}</div>` : ''}
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
    webhookSection.style.display = hasClips ? '' : 'none';
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
    renderClipList();
    updateUI();
}

// === Crop controls ===
function onFitModeChange(clipId, value) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    clip.fit_mode = value;
    const anchorGroup = document.getElementById(`anchor-group-${clipId}`);
    if (anchorGroup) anchorGroup.style.display = value === 'crop' ? '' : 'none';
}

function onCropAnchorChange(clipId, anchor) {
    const clip = clips.find(c => c.clip_id === clipId);
    if (!clip) return;
    clip.crop_anchor = anchor;
    // Update active state visually
    const grid = document.getElementById(`anchor-grid-${clipId}`);
    if (grid) {
        grid.querySelectorAll('.anchor-btn').forEach((btn, i) => {
            const positions = ['top-left','top','top-right','left','center','right','bottom-left','bottom','bottom-right'];
            btn.classList.toggle('active', positions[i] === anchor);
        });
    }
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

// === Webhook ===
function toggleWebhookUrl() {
    const enabled = document.getElementById('webhookEnabled').checked;
    document.getElementById('webhookUrlGroup').style.display = enabled ? '' : 'none';
}

// === Render ===
async function renderVideo() {
    const active = clips.filter(c => !c.uploading);
    if (active.length === 0) return;

    renderBtn.disabled = true;
    progressSection.style.display = '';
    downloadSection.style.display = 'none';

    const prof = getCurrentProfile();
    const webhookEnabled = document.getElementById('webhookEnabled').checked;
    const webhookUrl = webhookEnabled ? document.getElementById('webhookUrl').value.trim() : null;

    setProgress(15, 'Preparando renderização...');

    try {
        setProgress(25, 'Costurando os cortes e aplicando transições...');

        const res = await fetch(`/api/sessions/${sessionId}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                clips: active.map(c => ({
                    stored_name: c.stored_name,
                    trim_start: c.trim_start,
                    trim_end: c.trim_end,
                    fit_mode: c.fit_mode !== 'default' ? c.fit_mode : undefined,
                    crop_anchor: c.crop_anchor !== 'center' ? c.crop_anchor : undefined,
                })),
                profile: currentProfileSlug,
                webhook_url: webhookUrl || undefined,
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
