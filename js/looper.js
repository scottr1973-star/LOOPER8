/* FILE: js/looper.js
   FIXED: Metronome crash, FX Chain routing, Panel Draggability, Close Button
*/
(() => {
  // ====== Tunables ======
  const PRE_ROLL_MS = 120, NO_LOOP_STOP_GRACE_MS = 80;
  const MAX_HISTORY = 10; 

  // ====== State ======
  const N = 8, LED_CELLS = 32;
  let audioCtx = null, mediaStream = null, mediaRec = null;
  let recordingTrack = -1, chunks = [];
  let loopLenSec = null, playing = false, startAt = 0;
  let inputNode = null, inputGainNode = null, limiterNode = null, processedStreamDest = null;
  let analyser = null, monitorGain = null;
  let recBusy = false, recSchedule = null, fallbackRec = null, hiddenFileInput = null;
  let monitorInitialized = false;
  let metronomeEnabled = false, metronomeGain = null, metronomeTimerID = null;
  let easyMode = false;
  
  let bpm = 120, tsTop = 4, tsBottom = 4, swingPercent = 0;
  let measureLength = null; 
  let metroNextSubdivTime = 0, metroSubdivIndex = 0, metroPulseSubdivisions = 1; 
  const scheduleAheadTime = 0.12, scheduleLookahead = 25.0; 

  let fxPanelState = { currentTrack: -1, reverbImpulse: null };

  const tracks = Array.from({length:N}, (_,i)=>({
    i, label:'T'+(i+1), colorClass:'c'+(i+1),
    buffer:null, source:null, gainNode:null,
    muted:false, solo:false, 
    leds:[], progressEl:null, statusEl:null, recChip:null, labelEl: null,
    easyPadEl: null, easyFillEl: null, easyStatusEl: null,
    fx: getDefaultFxState(), fxNodes: {},
    history: [], historyPointer: -1, undoBtn: null, redoBtn: null, 
    stopBtn: null 
  }));

  // ====== DOM Refs ======
  const tEl = document.getElementById('tracks'), 
        easyGridEl = document.getElementById('easyGrid'),
        viewToggleBtn = document.getElementById('viewToggle'),
        initBtn = document.getElementById('initBtn'), playBtn = document.getElementById('playBtn'),
        stopBtn = document.getElementById('stopBtn'), 
        loopMeasuresInput = document.getElementById('loopMeasures'), applyLoopBtn = document.getElementById('applyLoop'),
        fitModeSel = document.getElementById('fitMode'), loopBadge = document.getElementById('loopBadge'), 
        exportMixBtn = document.getElementById('exportMix'), exportStemsBtn = document.getElementById('exportStems'), 
        saveSessBtn = document.getElementById('saveSess'), loadSessBtn = document.getElementById('loadSess'),
        monitorChk = document.getElementById('monitorChk'), meterFill = document.getElementById('meterFill'), toastEl = document.getElementById('toast'),
        inputGain = document.getElementById('inputGain'), metroBtn = document.getElementById('metroBtn'), metroVol = document.getElementById('metroVol'),
        metroSubdivisionsSel = document.getElementById('metroSubdivisions'),
        fxPanel = document.getElementById('fxPanel'), fxPanelHeader = document.getElementById('fxPanelHeader'),
        fxPanelTitle = document.getElementById('fxPanelTitle'), fxPanelClose = document.getElementById('fxPanelClose'), fxPanelContent = document.getElementById('fxPanelContent'),
        fxPanelResizeHandle = document.getElementById('fxPanelResizeHandle');

  // Tempo UI
  const bpmInput = document.getElementById('bpmInput'), bpmSlider = document.getElementById('bpmSlider'),
        timeTopSel = document.getElementById('timeTop'), timeBottomSel = document.getElementById('timeBottom'),
        swingSlider = document.getElementById('swingSlider'), swingLabel = document.getElementById('swingLabel'),
        measureInfo = document.getElementById('measureInfo');

  for (let i=1;i<=32;i++){
    const opt = document.createElement('option'); opt.value = String(i); opt.textContent = String(i);
    if (i===4) opt.selected = true;
    timeTopSel.appendChild(opt);
  }

  // ====== VIEW TOGGLE LOGIC ======
  viewToggleBtn.addEventListener('click', () => {
    easyMode = !easyMode;
    if (easyMode) {
      tEl.classList.add('hidden');
      easyGridEl.classList.remove('hidden');
      viewToggleBtn.textContent = '📋 List View';
      viewToggleBtn.className = 'btn gray';
    } else {
      tEl.classList.remove('hidden');
      easyGridEl.classList.add('hidden');
      viewToggleBtn.textContent = '⚡ Easy Mode';
      viewToggleBtn.className = 'btn blue';
    }
  });

  // ====== UI Build ======
  function buildUI(){
    tEl.innerHTML = '';
    easyGridEl.innerHTML = '';

    tracks.forEach(tr=>{
      const row = document.createElement('div'); row.className='track';
      const tag = document.createElement('div'); 
      tag.className='tlabel '+tr.colorClass; 
      tag.textContent=tr.label; 
      row.appendChild(tag);
      tr.labelEl = tag;

      const mid = document.createElement('div'); mid.className='mid';
      const leds = document.createElement('div'); leds.className='leds';
      tr.leds = []; for(let k=0;k<LED_CELLS;k++){ const d=document.createElement('div'); d.className='led'; leds.appendChild(d); tr.leds.push(d); } mid.appendChild(leds);
      const bar = document.createElement('div'); bar.className='bar'; const fill = document.createElement('div'); fill.className='fill'; bar.appendChild(fill); tr.progressEl = fill; mid.appendChild(bar); row.appendChild(mid);
      
      const ctrls = document.createElement('div'); ctrls.className='ctrls';
      const recBtn = document.createElement('button'); recBtn.className='btn small'; recBtn.textContent='Rec'; recBtn.disabled = true;
      const trackToggleBtn = document.createElement('button'); trackToggleBtn.className='btn small red'; trackToggleBtn.textContent='Stop'; trackToggleBtn.disabled = true;
      const clrBtn = document.createElement('button'); clrBtn.className='btn small'; clrBtn.textContent='Clr'; clrBtn.disabled = true;
      const undoBtn = document.createElement('button'); undoBtn.className='btn small'; undoBtn.textContent='Undo'; undoBtn.disabled = true;
      const redoBtn = document.createElement('button'); redoBtn.className='btn small'; redoBtn.textContent='Redo'; redoBtn.disabled = true;
      const fxBtn = document.createElement('button'); fxBtn.className='btn small blue'; fxBtn.textContent='FX'; fxBtn.disabled = true;
      const muteBtn = document.createElement('button'); muteBtn.className='btn small'; muteBtn.textContent='M'; muteBtn.disabled = true;
      const soloBtn = document.createElement('button'); soloBtn.className='btn small'; soloBtn.textContent='S'; soloBtn.disabled = true;
      const vol = document.createElement('input'); vol.className='vol'; vol.type='range'; vol.min=0; vol.max=1; vol.step=0.01; vol.value=0.9; vol.disabled = true;
      const chip = document.createElement('span'); chip.className='chip idle'; chip.textContent='—';
      ctrls.append(recBtn, trackToggleBtn, clrBtn, undoBtn, redoBtn, fxBtn, muteBtn, soloBtn, vol, chip); row.appendChild(ctrls);
      
      const status = document.createElement('div'); status.className='status'; status.textContent='Idle'; row.appendChild(status);
      tr.statusEl = status; tr.recChip = chip;
      tr.undoBtn = undoBtn; tr.redoBtn = redoBtn;
      tr.stopBtn = trackToggleBtn; 

      // Easy Mode Pad
      const pad = document.createElement('div');
      pad.className = `easy-pad ${tr.colorClass}`;
      pad.innerHTML = `<div class="easy-pad-fill"></div><div class="easy-pad-content"><div class="ep-label">${tr.label}</div><div class="ep-status">EMPTY</div></div>`;
      tr.easyPadEl = pad;
      tr.easyFillEl = pad.querySelector('.easy-pad-fill');
      tr.easyStatusEl = pad.querySelector('.ep-status');

      // Handlers
      const handlePadClick = () => {
        if (recordingTrack === tr.i) { stopRecording(); } 
        else if (!recBusy && recordingTrack === -1) { safeRecordStart(tr.i, recBtn, trackToggleBtn); }
      };

      const handleTrackToggle = () => {
        if (recordingTrack === tr.i) {
            stopRecording();
        } else {
            if (tr.source) {
                // STOP SPECIFIC TRACK
                try { tr.source.stop(); } catch(e){}
                tr.source.disconnect(); 
                tr.source = null;
                tr.statusEl.textContent = 'Stopped';
                if(tr.easyStatusEl) tr.easyStatusEl.textContent = 'STOPPED';
                tr.stopBtn.textContent = 'Play'; tr.stopBtn.className = 'btn small green';
                tr.leds.forEach(d => d.classList.remove('on'));
                tr.progressEl.style.width = '0%';
                if(tr.easyFillEl) tr.easyFillEl.style.width = '0%';
            } 
            else if (tr.buffer && loopLenSec) {
                // PLAY SPECIFIC TRACK
                const src = audioCtx.createBufferSource();
                src.buffer = normalizeToLoop(tr.buffer, loopLenSec);
                src.loop = true; src.loopStart = 0; src.loopEnd = loopLenSec;
                src.connect(tr.fxNodes.input);
                
                const now = audioCtx.currentTime;
                let offset = 0;
                if(playing) {
                    offset = (now - startAt) % loopLenSec;
                } else {
                    startAt = now;
                    playing = true;
                    requestAnimationFrame(tickProgress);
                    if(metronomeEnabled) startMetronome();
                }
                src.start(now, offset);
                tr.source = src;
                
                tr.statusEl.textContent = 'Playing';
                if(tr.easyStatusEl) tr.easyStatusEl.textContent = 'PLAYING';
                tr.stopBtn.textContent = 'Stop'; tr.stopBtn.className = 'btn small red';
            }
        }
      };

      recBtn.addEventListener('click', ()=> safeRecordStart(tr.i, recBtn, trackToggleBtn));
      trackToggleBtn.addEventListener('click', handleTrackToggle);
      tag.addEventListener('click', handlePadClick);
      pad.addEventListener('click', handlePadClick);

      clrBtn.addEventListener('click', ()=> clearTrack(tr.i));
      undoBtn.addEventListener('click', ()=> undo(tr.i));
      redoBtn.addEventListener('click', ()=> redo(tr.i));
      fxBtn.addEventListener('click', () => openFxPanel(tr.i));
      muteBtn.addEventListener('click', ()=> toggleMute(tr.i, muteBtn));
      soloBtn.addEventListener('click', ()=> toggleSolo(tr.i, soloBtn));
      vol.addEventListener('input', e=> setVolume(tr.i, Number(e.target.value)));
      
      tEl.appendChild(row);
      easyGridEl.appendChild(pad);
    });
  }
  buildUI();

  // ====== MAIN GLOBAL TRANSPORT ======
  playBtn.onclick = async () => { 
    await ensureAudioReady(); 
    if(audioCtx.state === 'suspended') await audioCtx.resume();

    if (!loopLenSec){ 
        const measures = Math.max(1, Number(loopMeasuresInput.value) || 4); 
        if (!measureLength) measureLength = computeMeasureLength(); 
        loopLenSec = measures * measureLength; setLoopLenDisplay(); 
    } 
    
    startAllPlayback(); 
  };
  
  stopBtn.onclick = () => { 
    if (recordingTrack !== -1) stopRecording(); 
    stopAllPlayback(); 
  };
  
  function startAllPlayback(){
    stopAllPlayback(); // Clear first
    
    const now = audioCtx.currentTime;
    startAt = now; 
    let anyStarted = false;

    tracks.forEach(tr=>{
      if (!tr.buffer) return;
      const buf = normalizeToLoop(tr.buffer, loopLenSec);
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = loopLenSec;
      src.connect(tr.fxNodes.input); 
      src.start(now); 
      tr.source = src;
      anyStarted = true;
      
      tr.statusEl.textContent = 'Playing';
      if(tr.easyStatusEl) tr.easyStatusEl.textContent = 'PLAYING';
      tr.stopBtn.textContent = 'Stop'; 
      tr.stopBtn.className = 'btn small red';
    });
    
    if(anyStarted) {
        playing = true; 
        requestAnimationFrame(tickProgress);
        if (metronomeEnabled) { stopMetronome(); metroNextSubdivTime = now; metroSubdivIndex = 0; metronomeScheduler(); }
    }
  }
  
  function stopAllPlayback(){
    stopMetronome();
    tracks.forEach(tr=>{ 
      if (tr.source){ try{ tr.source.stop(); }catch{} tr.source.disconnect(); tr.source=null; } 
      if (tr.progressEl) tr.progressEl.style.width='0%'; 
      if (tr.easyFillEl) tr.easyFillEl.style.width='0%'; 
      tr.leds.forEach(d=>d.classList.remove('on')); 
      
      if (tr.buffer) {
        tr.stopBtn.textContent = 'Play'; tr.stopBtn.className = 'btn small green';
        tr.statusEl.textContent = 'Stopped';
        if(tr.easyStatusEl) tr.easyStatusEl.textContent = 'STOPPED';
      }
    });
    playing = false;
  }

  // ====== AUDIO ENGINE HELPERS ======
  function enableControls(on){
    document.querySelectorAll('.ctrls .btn').forEach(b=>{
      const label = b.textContent;
      if (label==='Rec' || label==='FX') b.disabled = !on;
      else if (label==='Stop' || label==='Play') b.disabled = true; 
      else if (label==='Undo' || label==='Redo') b.disabled = true;
      else if (label !== 'M' && label !== 'S' && label !== 'Clr') b.disabled = !on;
    });
    document.querySelectorAll('.ctrls .btn[disabled]').forEach(b=>{
        if (b.textContent==='M' || b.textContent==='S' || b.textContent==='Clr') b.disabled = !on;
    });
    document.querySelectorAll('.vol').forEach(v=> v.disabled = !on);
  }

  async function ensureAudioReady(){ 
    if (!audioCtx){ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } 
    if (audioCtx.state === 'suspended'){ try{ await audioCtx.resume(); }catch{} } 
  }
  
  async function ensureMic(){
    if (!mediaStream){
      try{ mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); } catch(e){ toast('Mic blocked.'); return false; }
    }
    if (!inputNode){
      inputNode = audioCtx.createMediaStreamSource(mediaStream);
      inputGainNode = audioCtx.createGain(); inputGainNode.gain.value = Number(inputGain.value);
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.threshold.setValueAtTime(-1, audioCtx.currentTime); 
      limiterNode.ratio.setValueAtTime(20, audioCtx.currentTime); 
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; 
      monitorGain = audioCtx.createGain(); monitorGain.gain.value = 0.0;
      processedStreamDest = audioCtx.createMediaStreamDestination();
      inputNode.connect(inputGainNode).connect(limiterNode).connect(analyser);
      limiterNode.connect(processedStreamDest);
      analyser.connect(monitorGain).connect(audioCtx.destination);
      if (!monitorInitialized){
        monitorChk.disabled = false; monitorChk.checked = false;
        monitorChk.addEventListener('change', () => { if (monitorGain) monitorGain.gain.value = monitorChk.checked ? 0.18 : 0.0; });
        monitorInitialized = true;
      }
    }
    if (!mediaRec && window.MediaRecorder){
      const mime = getBestMime(); 
      try{ mediaRec = mime ? new MediaRecorder(processedStreamDest.stream, {mimeType:mime}) : new MediaRecorder(processedStreamDest.stream); } catch{ mediaRec = null; }
      if (mediaRec){ 
        mediaRec.ondataavailable = (e)=> { if (e.data.size) chunks.push(e.data); }; 
        mediaRec.onstop = onRecordingComplete_MediaRecorder; 
      }
    }
    if (!fallbackRec){ fallbackRec = createFallbackRecorder(limiterNode, audioCtx); }
    return true;
  }
  
  initBtn.addEventListener('click', async ()=>{
    await ensureAudioReady();
    const ok = await ensureMic();
    if (ok) {
        if (!fxPanelState.reverbImpulse) fxPanelState.reverbImpulse = createImpulseResponse(audioCtx);
        tracks.forEach(tr => {
            if (!tr.gainNode) {
                const g = audioCtx.createGain(); g.gain.value=0.9; g.connect(audioCtx.destination); tr.gainNode=g;
                createFxChain(tr, audioCtx);
            }
        });
        if (!metronomeGain){ metronomeGain = audioCtx.createGain(); metronomeGain.gain.value = Number(metroVol.value); metronomeGain.connect(audioCtx.destination); }
    }
    playBtn.disabled = !ok; stopBtn.disabled = !ok; metroBtn.disabled = !ok; metroVol.disabled = !ok; inputGain.disabled = !ok;
    enableControls(ok);
    if (ok){ initBtn.disabled = true; initBtn.textContent = 'Audio On'; }
  });
  
  inputGain.addEventListener('input', e => { if (inputGainNode) inputGainNode.gain.setTargetAtTime(Number(e.target.value), audioCtx.currentTime, 0.01); });
  
  function computeMeasureLength(){ return (60 / bpm) * tsTop * (4 / tsBottom); }
  function updateMeasureDisplay(){ measureLength = computeMeasureLength(); measureInfo.textContent = `${measureLength.toFixed(2)}s | ${tsTop}/${tsBottom} @ ${bpm}`; if (loopLenSec){ const measures = Math.max(1, Math.round(loopLenSec / measureLength)); loopLenSec = measures * measureLength; loopBadge.style.display = 'inline-block'; loopBadge.textContent = 'Loop: ' + loopLenSec.toFixed(2) + ' s'; loopMeasuresInput.value = measures; } }
  function scheduleMetroTickAt(time, isAccent){ 
    const osc = audioCtx.createOscillator(); 
    const env = audioCtx.createGain(); 
    osc.type = 'sine'; 
    osc.frequency.value = isAccent ? 1000 : 800; 
    const vol = isAccent ? 1.0 : 0.7; 
    const masterVol = metronomeGain ? metronomeGain.gain.value : 0.4;
    env.gain.setValueAtTime(0, time); 
    env.gain.linearRampToValueAtTime(vol * masterVol, time + 0.001); 
    env.gain.linearRampToValueAtTime(0, time + 0.08); 
    osc.connect(env).connect(metronomeGain || audioCtx.destination); 
    osc.start(time); 
    osc.stop(time + 0.09); 
  }
  function metronomeScheduler(){ 
    if (!metronomeEnabled || !measureLength) return; 
    const now = audioCtx.currentTime; 
    const totalSubdivisionsPerMeasure = tsTop * metroPulseSubdivisions; 
    const beatDuration = measureLength / tsTop; 
    while (metroNextSubdivTime < now + scheduleAheadTime){ 
        const idx = metroSubdivIndex % totalSubdivisionsPerMeasure; 
        const isAccent = (Math.floor(idx / metroPulseSubdivisions) === 0 && (idx % metroPulseSubdivisions) === 0); 
        scheduleMetroTickAt(metroNextSubdivTime, isAccent); 
        metroNextSubdivTime += (beatDuration / metroPulseSubdivisions); 
        metroSubdivIndex++; 
        if (metroSubdivIndex >= totalSubdivisionsPerMeasure) { metroSubdivIndex = 0; } 
    } 
    metronomeTimerID = setTimeout(metronomeScheduler, scheduleLookahead); 
  }
  function startMetronome(){ if (!metronomeEnabled || !measureLength) return; if (metronomeTimerID) return; const now = audioCtx.currentTime; let ref = playing ? startAt : now; metroNextSubdivTime = now + 0.05; metroSubdivIndex = 0; metronomeScheduler(); }
  function stopMetronome(){ if (metronomeTimerID) clearTimeout(metronomeTimerID); metronomeTimerID = null; }
  function setupTempoUI(){ 
      bpm = Number(bpmInput.value) || 120; bpmSlider.value = bpm; 
      tsTop = Number(timeTopSel.value) || 4; tsBottom = Number(timeBottomSel.value) || 4; 
      swingPercent = Number(swingSlider.value) || 0; swingLabel.textContent = swingPercent + '%'; 
      // Safe access for subdivision
      metroPulseSubdivisions = metroSubdivisionsSel ? (Number(metroSubdivisionsSel.value) || 1) : 1;
      
      updateMeasureDisplay(); 
      const updateAll = () => { 
          bpm = Math.max(40, Math.min(240, Number(bpmInput.value)||120)); 
          tsTop = Number(timeTopSel.value)||4; tsBottom = Number(timeBottomSel.value)||4; 
          updateMeasureDisplay(); 
      }; 
      bpmInput.onchange = updateAll; bpmSlider.oninput = (e)=>{ bpmInput.value=e.target.value; updateAll(); }; 
      timeTopSel.onchange = updateAll; timeBottomSel.onchange = updateAll; 
      
      if(metroSubdivisionsSel) metroSubdivisionsSel.onchange = () => { metroPulseSubdivisions = Number(metroSubdivisionsSel.value) || 1; };

      metroBtn.addEventListener('click', ()=>{ 
          metronomeEnabled = !metronomeEnabled; 
          metroBtn.textContent = metronomeEnabled ? 'On' : 'Off'; 
          metroBtn.className = metronomeEnabled ? 'btn small green' : 'btn small gray'; 
          if (metronomeEnabled && playing) startMetronome(); else stopMetronome(); 
      }); 
      metroVol.addEventListener('input', ()=>{ if (metronomeGain) metronomeGain.gain.value = Number(metroVol.value); }); 
  }
  setupTempoUI();

  // ====== History ======
  function pushHistory(i) { const t = tr(i); const currentBuffer = t.buffer; if (t.historyPointer < t.history.length - 1) { t.history.splice(t.historyPointer + 1); } t.history.push(currentBuffer); if (t.history.length > MAX_HISTORY) t.history.shift(); t.historyPointer = t.history.length - 1; updateUndoRedoBtns(i); }
  function undo(i) { const t=tr(i); if(t.historyPointer>0){ t.historyPointer--; applyBufferToTrack(i, t.history[t.historyPointer]); updateUndoRedoBtns(i); } }
  function redo(i) { const t=tr(i); if(t.historyPointer<t.history.length-1){ t.historyPointer++; applyBufferToTrack(i, t.history[t.historyPointer]); updateUndoRedoBtns(i); } }
  function updateUndoRedoBtns(i){ const t=tr(i); t.undoBtn.disabled=t.historyPointer<=0; t.redoBtn.disabled=t.historyPointer>=t.history.length-1; }

  function applyBufferToTrack(i, buffer) {
    const t = tr(i);
    if (t.source){ try{ t.source.stop() }catch{} t.source.disconnect(); t.source=null; }
    t.buffer = buffer;
    
    t.statusEl.textContent = buffer ? 'Ready' : 'Empty';
    if(t.easyStatusEl) t.easyStatusEl.textContent = buffer ? 'READY' : 'EMPTY';
    
    t.stopBtn.disabled = !buffer; 
    if(buffer) {
        t.stopBtn.textContent = playing ? 'Stop' : 'Play';
        t.stopBtn.className = playing ? 'btn small red' : 'btn small green';
    } else {
        t.stopBtn.textContent = 'Stop'; t.stopBtn.className = 'btn small red';
    }
    
    exportMixBtn.disabled = !tracks.some(x=>x.buffer); exportStemsBtn.disabled = !tracks.some(x=>x.buffer);
    if (playing && buffer && loopLenSec) {
      const src = audioCtx.createBufferSource(); src.buffer = normalizeToLoop(buffer, loopLenSec); src.loop = true; src.loopStart = 0; src.loopEnd = loopLenSec; src.connect(t.fxNodes.input); const now = audioCtx.currentTime; const elapsed = (now - startAt) % loopLenSec; src.start(now, elapsed); t.source = src;
    } else { t.progressEl.style.width='0%'; if(t.easyFillEl) t.easyFillEl.style.width='0%'; t.leds.forEach(d=>d.classList.remove('on')); }
    if (!tracks.some(x=>x.buffer)){ setLoopLenDisplay(); }
  }

  // ====== Recording ======
  async function safeRecordStart(i,recBtn,toggleBtn){
    if(recBusy)return; recBusy=true; tr(i).recChip.textContent='Arm';
    await ensureAudioReady(); const ok=await ensureMic(); if(!ok){ tr(i).recChip.textContent='Err'; recBusy=false; restoreMonitorAfterRecord(); return; }
    monitorPrevValue=monitorGain?monitorGain.gain.value:0; if(monitorGain)monitorGain.gain.value=0.0;
    
    recBtn.disabled=true; 
    toggleBtn.disabled=false; toggleBtn.textContent='Stop'; toggleBtn.className='btn small red';
    
    recordingTrack=i; chunks=[];
    tr(i).statusEl.textContent='Rec...'; tr(i).progressEl.classList.add('rec'); tr(i).recChip.className='chip rec'; tr(i).recChip.textContent='REC';
    if(tr(i).labelEl) tr(i).labelEl.classList.add('recording-active'); if(tr(i).easyPadEl) tr(i).easyPadEl.classList.add('recording'); if(tr(i).easyStatusEl) tr(i).easyStatusEl.textContent='RECORDING';
    
    const usingMediaRecorder=!!mediaRec;
    if(loopLenSec && playing){
        const now = audioCtx.currentTime; const currentLoopOffset = (now - startAt) % loopLenSec;
        if(usingMediaRecorder){ try{ mediaRec.start(); }catch(e){ endRecUI(i); recBusy=false; return; } } else { fallbackRec.start(); }
        recSchedule = { track: i, offset: currentLoopOffset }; if(playing) requestAnimationFrame(tickProgress);
    } else {
        if(usingMediaRecorder){ try{ mediaRec.start(); }catch(e){ endRecUI(i); recBusy=false; return; } } else { fallbackRec.start(); }
        if(!playing) { startAt = audioCtx.currentTime; requestAnimationFrame(tickProgress); }
    }
    recBusy=false;
  }

  function stopRecording(){
    const t=audioCtx.currentTime; const when=t+NO_LOOP_STOP_GRACE_MS/1000;
    if(mediaRec&&mediaRec.state==='recording'){ waitUntil(when,()=>{try{if(mediaRec.requestData)mediaRec.requestData()}catch{}mediaRec.stop()}) } 
    else if(fallbackRec&&fallbackRec.isRecording){ waitUntil(when,()=>{fallbackRec.stop();onRecordingComplete_Fallback(recordingTrack)}) }
  }
  function waitUntil(whenCtxTime,fn){ const tick=()=>{if(!audioCtx)return;if(audioCtx.currentTime>=whenCtxTime-0.001){fn();return}requestAnimationFrame(tick)}; requestAnimationFrame(tick) }

  async function onRecordingComplete_MediaRecorder(){ const i=recordingTrack; recordingTrack=-1; tr(i).recChip.className='chip idle'; tr(i).recChip.textContent='—'; pushHistory(i); const blob=new Blob(chunks,{type:chunks[0]?.type||'audio/webm'}); let ab; try{ ab=await blob.arrayBuffer(); }catch{ endRecUI(i); restoreMonitorAfterRecord(); return; } let buf=await audioCtx.decodeAudioData(ab).catch(()=>null); if(!buf){ toast('Decode failed'); endRecUI(i); restoreMonitorAfterRecord(); return; } processRecordedBuffer(i, buf); }
  function onRecordingComplete_Fallback(i){ tr(i).recChip.className='chip idle'; tr(i).recChip.textContent='—'; pushHistory(i); let buf=fallbackRec.getAudioBuffer(); processRecordedBuffer(i, buf); }

  function processRecordedBuffer(i, buf){
    buf=toMonoWithFades(buf,0.004);
    if(recSchedule && recSchedule.track === i && recSchedule.offset !== undefined){
        const sr=buf.sampleRate, totalSamples=Math.floor(loopLenSec*sr), offsetSamples=Math.floor(recSchedule.offset*sr);
        const out=audioCtx.createBuffer(1,totalSamples,sr), outData=out.getChannelData(0), inData=buf.getChannelData(0);
        const copyLen=Math.min(inData.length, totalSamples-offsetSamples);
        outData.set(inData.subarray(0,copyLen), offsetSamples);
        if(inData.length > (totalSamples-offsetSamples)) outData.set(inData.subarray(totalSamples-offsetSamples), 0);
        buf=out; recSchedule=null;
    } else {
        if(!loopLenSec){
            const measures=Math.max(1, Math.round(buf.duration/(measureLength||computeMeasureLength())));
            loopLenSec=measures*(measureLength||computeMeasureLength());
            setLoopLenDisplay(); playing=true; startAt=audioCtx.currentTime; if(metronomeEnabled) startMetronome();
        }
        buf=fitBufferToLoop(buf,loopLenSec);
    }
    applyBufferToTrack(i, buf);
    pushHistory(i);
    endRecUI(i); restoreMonitorAfterRecord();
    requestAnimationFrame(tickProgress);
  }

  function restoreMonitorAfterRecord(){if(!monitorGain)return;const wantsMonitor=monitorChk&&monitorChk.checked;monitorGain.gain.value=wantsMonitor?(typeof monitorPrevValue==='number'?monitorPrevValue:0.18):0.0}
  function endRecUI(i){
    document.querySelectorAll('.ctrls .btn').forEach(b=>{ if(b.textContent==='Rec') b.disabled=false; });
    const f=tr(i).progressEl;if(f)f.classList.remove('rec');
    if (tr(i).labelEl) tr(i).labelEl.classList.remove('recording-active');
    if (tr(i).easyPadEl) tr(i).easyPadEl.classList.remove('recording');
  }
  function tr(i){return tracks[i]}
  function clearTrack(i){ pushHistory(i); applyBufferToTrack(i, null); pushHistory(i); }
  function toggleMute(i,btn){const t=tr(i);t.muted=!t.muted;refreshGains();btn.textContent=t.muted?'U':'M';btn.style.color=t.muted?'var(--rec)':'#e8f5e9';}
  function toggleSolo(i,btn){const t=tr(i);t.solo=!t.solo;refreshGains();btn.textContent=t.solo?'U':'S';btn.style.color=t.solo?'var(--g1)':'#e8f5e9';}
  function setVolume(i,v){const t=tr(i);if(!t.gainNode)return;t.gainNode.gain.value=v*(t.muted?0:1)*(anySolo()?(t.solo?1:0):1)}
  function anySolo(){return tracks.some(t=>t.solo)}
  function refreshGains(){const soloMode=anySolo();document.querySelectorAll('.tracks .track').forEach((row,idx)=>{const vol=Number(row.querySelector('.vol').value)||1;const t=tr(idx);const gate=t.muted?0:(soloMode?(t.solo?1:0):1);if(t.gainNode)t.gainNode.gain.value=vol*gate})}
  function setLoopLenDisplay(){ if(!loopLenSec){ loopBadge.style.display='none'; loopMeasuresInput.value = '4'; return; } const measures = Math.round(loopLenSec / (measureLength || computeMeasureLength())); loopMeasuresInput.value = measures; loopBadge.style.display='inline-block'; loopBadge.textContent='Loop: '+loopLenSec.toFixed(2)+'s'; }

  // ====== FX SYSTEM ======
  function getDefaultFxState() { return { eq: { on: false, low: 0, mid: 0, high: 0 }, comp: { on: false, threshold: -24, ratio: 12, attack: 0.003 }, phaser: { on: false, freq: 700, depth: 0.7 }, delay: { on: false, time: 0.3, feedback: 0.4, mix: 0.5 }, reverb: { on: false, mix: 0.4 } }; }
  
  function createFxChain(track, ctx) {
    const nodes = {};
    nodes.input = ctx.createGain();
    nodes.eqLow = ctx.createBiquadFilter(); nodes.eqLow.type = 'lowshelf'; nodes.eqLow.frequency.value = 300;
    nodes.eqMid = ctx.createBiquadFilter(); nodes.eqMid.type = 'peaking'; nodes.eqMid.frequency.value = 1000; nodes.eqMid.Q.value = 1.0;
    nodes.eqHigh = ctx.createBiquadFilter(); nodes.eqHigh.type = 'highshelf'; nodes.eqHigh.frequency.value = 3000;
    nodes.comp = ctx.createDynamicsCompressor();
    nodes.phaser = ctx.createBiquadFilter(); nodes.phaser.type = 'allpass'; nodes.phaser.Q.value = 5;
    const phaserLFO = ctx.createOscillator(); phaserLFO.type = 'sine'; phaserLFO.frequency.value = 0.5;
    const phaserDepth = ctx.createGain();
    phaserLFO.connect(phaserDepth).connect(nodes.phaser.frequency); phaserLFO.start();
    nodes.phaserLFO = phaserLFO; nodes.phaserDepth = phaserDepth;
    
    // Delay Nodes
    nodes.delay = ctx.createDelay(1.0); 
    nodes.delayFeedback = ctx.createGain(); 
    nodes.delayWet = ctx.createGain(); 
    nodes.delayDry = ctx.createGain();
    nodes.delayOut = ctx.createGain(); // Intermediate output for Delay stage

    // Reverb Nodes
    nodes.reverb = ctx.createConvolver(); nodes.reverb.buffer = fxPanelState.reverbImpulse; 
    nodes.reverbWet = ctx.createGain(); 
    nodes.reverbDry = ctx.createGain();
    
    nodes.output = ctx.createGain(); 
    nodes.output.connect(track.gainNode);
    track.fxNodes = nodes; 
    connectFxChain(track); 
    updateAllFxForTrack(track);
  }
  
  function connectFxChain(track) {
    const { input, eqLow, eqMid, eqHigh, comp, phaser, 
            delay, delayFeedback, delayWet, delayDry, delayOut,
            reverb, reverbWet, reverbDry, output } = track.fxNodes;
    const fx = track.fx; 
    
    // 1. Disconnect everything from previous state
    const allNodes = [input, eqLow, eqMid, eqHigh, comp, phaser, delay, delayFeedback, delayWet, delayDry, delayOut, reverb, reverbWet, reverbDry];
    allNodes.forEach(n => { try { n.disconnect(); } catch(e){} });
    
    // Re-establish internal loops
    phaser.disconnect(); // Clear phaser audio path, but keep LFO
    delay.connect(delayFeedback).connect(delay); // Internal delay feedback loop

    let lastNode = input;

    // 2. Linear Chain Construction
    
    // EQ
    if (fx.eq.on) { 
        lastNode.connect(eqLow); 
        eqLow.connect(eqMid).connect(eqHigh); 
        lastNode = eqHigh; 
    }

    // Compressor
    if (fx.comp.on) { 
        lastNode.connect(comp); 
        lastNode = comp; 
    }

    // Phaser
    if (fx.phaser.on) { 
        lastNode.connect(phaser); 
        lastNode = phaser; 
    }

    // Delay (Mix Stage)
    if (fx.delay.on) {
        lastNode.connect(delayDry);
        lastNode.connect(delay);
        delay.connect(delayWet);
        
        delayDry.connect(delayOut);
        delayWet.connect(delayOut);
        
        lastNode = delayOut;
    } else {
        lastNode.connect(delayOut);
        lastNode = delayOut;
    }

    // Reverb (Mix Stage)
    if (fx.reverb.on) {
        lastNode.connect(reverbDry);
        lastNode.connect(reverb);
        reverb.connect(reverbWet);
        
        reverbDry.connect(output);
        reverbWet.connect(output);
    } else {
        lastNode.connect(output);
    }
  }

  function updateAllFxForTrack(track) { Object.keys(track.fx).forEach(fxKey => { Object.keys(track.fx[fxKey]).forEach(paramKey => { if (paramKey !== 'on') { updateFxParam(track, fxKey, paramKey, track.fx[fxKey][paramKey]); } }); }); connectFxChain(track); }
  function updateFxParam(track, fx, param, value) {
    track.fx[fx][param] = value; const n = track.fxNodes, now = audioCtx.currentTime;
    if(fx==='eq'){ if(param==='low') n.eqLow.gain.setTargetAtTime(value,now,0.01); if(param==='mid') n.eqMid.gain.setTargetAtTime(value,now,0.01); if(param==='high') n.eqHigh.gain.setTargetAtTime(value,now,0.01); }
    else if(fx==='comp'){ if(param==='threshold') n.comp.threshold.setTargetAtTime(value,now,0.01); if(param==='ratio') n.comp.ratio.setTargetAtTime(value,now,0.01); if(param==='attack') n.comp.attack.setTargetAtTime(value,now,0.01); }
    else if(fx==='phaser'){ if(param==='freq') n.phaser.frequency.setTargetAtTime(value,now,0.01); if(param==='depth') n.phaserDepth.gain.setTargetAtTime(value,now,0.01); }
    else if(fx==='delay'){ if(param==='time') n.delay.delayTime.setTargetAtTime(value,now,0.01); if(param==='feedback') n.delayFeedback.gain.setTargetAtTime(value,now,0.01); if(param==='mix'){n.delayWet.gain.setTargetAtTime(value,now,0.01); n.delayDry.gain.setTargetAtTime(1-value,now,0.01);} }
    else if(fx==='reverb'){ if(param==='mix'){n.reverbWet.gain.setTargetAtTime(value,now,0.01); n.reverbDry.gain.setTargetAtTime(1-value,now,0.01);} }
  }

  function openFxPanel(trackIndex) {
    fxPanelState.currentTrack = trackIndex; const track = tracks[trackIndex]; fxPanelTitle.textContent = `${track.label} - FX Rack`;
    fxPanelContent.innerHTML = `
      <div class="fx-module"><div class="fx-title"><input type="checkbox" data-fx="eq" ${track.fx.eq.on ? 'checked' : ''}>EQ</div><div class="fx-grid three">${['low','mid','high'].map(b=>`<label>${b.charAt(0).toUpperCase()+b.slice(1)}<input type="range" min="-20" max="20" step="0.1" value="${track.fx.eq[b]}" data-fx="eq" data-param="${b}"><output>${track.fx.eq[b]}</output>dB</label>`).join('')}</div></div>
      <div class="fx-module"><div class="fx-title"><input type="checkbox" data-fx="comp" ${track.fx.comp.on ? 'checked' : ''}>Compressor</div><div class="fx-grid three"><label>Thresh<input type="range" min="-100" max="0" step="1" value="${track.fx.comp.threshold}" data-fx="comp" data-param="threshold"><output>${track.fx.comp.threshold}</output></label><label>Ratio<input type="range" min="1" max="20" step="1" value="${track.fx.comp.ratio}" data-fx="comp" data-param="ratio"><output>${track.fx.comp.ratio}</output></label><label>Attack<input type="range" min="0" max="0.1" step="0.001" value="${track.fx.comp.attack}" data-fx="comp" data-param="attack"><output>${(track.fx.comp.attack*1000).toFixed(1)}</output>ms</label></div></div>
      <div class="fx-module"><div class="fx-title"><input type="checkbox" data-fx="phaser" ${track.fx.phaser.on ? 'checked' : ''}>Phaser</div><div class="fx-grid"><label>Freq<input type="range" min="20" max="2000" step="1" value="${track.fx.phaser.freq}" data-fx="phaser" data-param="freq"><output>${track.fx.phaser.freq}</output></label><label>Depth<input type="range" min="0" max="1" step="0.01" value="${track.fx.phaser.depth}" data-fx="phaser" data-param="depth"><output>${track.fx.phaser.depth}</output></label></div></div>
      <div class="fx-module"><div class="fx-title"><input type="checkbox" data-fx="delay" ${track.fx.delay.on ? 'checked' : ''}>Delay</div><div class="fx-grid three"><label>Time<input type="range" min="0.01" max="1.0" step="0.01" value="${track.fx.delay.time}" data-fx="delay" data-param="time"><output>${track.fx.delay.time}</output></label><label>Fdbk<input type="range" min="0" max="0.9" step="0.01" value="${track.fx.delay.feedback}" data-fx="delay" data-param="feedback"><output>${track.fx.delay.feedback}</output></label><label>Mix<input type="range" min="0" max="1" step="0.01" value="${track.fx.delay.mix}" data-fx="delay" data-param="mix"><output>${track.fx.delay.mix}</output></label></div></div>
      <div class="fx-module"><div class="fx-title"><input type="checkbox" data-fx="reverb" ${track.fx.reverb.on ? 'checked' : ''}>Reverb</div><div class="fx-grid"><label>Mix<input type="range" min="0" max="1" step="0.01" value="${track.fx.reverb.mix}" data-fx="reverb" data-param="mix"><output>${track.fx.reverb.mix}</output></label></div></div>
    `;
    
    // Reset visual position for draggability
    fxPanel.style.display = 'flex';
    fxPanel.style.transform = 'translate(-50%, -50%)'; 
    fxPanel.style.top = '50%';
    fxPanel.style.left = '50%';
    fxPanel.style.width = '400px';
  }
  
  fxPanelContent.addEventListener('input', e => {
    if (!e.target.dataset.fx) return;
    const track = tracks[fxPanelState.currentTrack];
    const { fx, param } = e.target.dataset;
    const isCheck = (e.target.type === 'checkbox');
    const value = isCheck ? e.target.checked : Number(e.target.value);
    
    if (e.target.type === 'range') {
        const out = e.target.closest('label').querySelector('output');
        if (out) { let d=value; if(fx==='comp'&&param==='attack') d=(value*1000).toFixed(1); out.textContent = d; }
    }
    if (isCheck) { track.fx[fx].on = value; connectFxChain(track); } else { updateFxParam(track, fx, param, value); }
  });
  
  fxPanelClose.onclick = (e) => { 
      e.stopPropagation(); 
      fxPanel.style.display = 'none'; 
      fxPanelState.currentTrack = -1; 
  };

  function makeDraggable(el, handle){ 
      let pos1=0,pos2=0,pos3=0,pos4=0; 
      handle.onmousedown=dragMouseDown; 
      
      function dragMouseDown(e){ 
          if(e.target.id==='fxPanelClose' || e.target.parentNode.id==='fxPanelClose') return; 
          e.preventDefault(); 
          
          // Remove transform on first drag to avoid jumpiness
          if (el.style.transform.includes('translate')) {
              const rect = el.getBoundingClientRect();
              el.style.transform = 'none';
              el.style.left = rect.left + 'px';
              el.style.top = rect.top + 'px';
          }
          
          pos3=e.clientX; 
          pos4=e.clientY; 
          document.onmouseup=closeDragElement; 
          document.onmousemove=elementDrag; 
      } 
      function elementDrag(e){ 
          e.preventDefault(); 
          pos1=pos3-e.clientX; 
          pos2=pos4-e.clientY; 
          pos3=e.clientX; 
          pos4=e.clientY; 
          el.style.top=(el.offsetTop-pos2)+"px"; 
          el.style.left=(el.offsetLeft-pos1)+"px"; 
      } 
      function closeDragElement(){ 
          document.onmouseup=null; 
          document.onmousemove=null; 
      } 
  }
  function makeResizable(el, handle){ let oldX=0,oldY=0,oldW=0,oldH=0; handle.onmousedown=dragMouseDown; function dragMouseDown(e){ e.preventDefault(); oldX=e.clientX; oldY=e.clientY; oldW=el.offsetWidth; oldH=el.offsetHeight; document.onmouseup=closeDragElement; document.onmousemove=elementDrag; } function elementDrag(e){ e.preventDefault(); el.style.width=(oldW+(e.clientX-oldX))+"px"; el.style.height=(oldH+(e.clientY-oldY))+"px"; } function closeDragElement(){ document.onmouseup=null; document.onmousemove=null; } }
  makeDraggable(fxPanel, fxPanelHeader); makeResizable(fxPanel, fxPanelResizeHandle);
  function createImpulseResponse(ctx) { const sr = ctx.sampleRate, len = sr * 2, decay = 2.0; const impulse = ctx.createBuffer(2, len, sr); const impL = impulse.getChannelData(0), impR = impulse.getChannelData(1); for (let i = 0; i < len; i++) { const p = i / len; impL[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, decay); impR[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, decay); } return impulse; }

  // Utils
  function getBestMime(){const cands=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];for(const m of cands){if(window.MediaRecorder&&MediaRecorder.isTypeSupported(m))return m}return''}
  function toast(msg){toastEl.textContent=msg;toastEl.style.opacity=1;setTimeout(()=>toastEl.style.opacity=0,2500)}
  function createFallbackRecorder(sourceNode,ctx){const rec={isRecording:false,_bufs:[],_script:null,_sr:ctx.sampleRate,start(){if(this.isRecording)return;this._bufs=[];const sp=ctx.createScriptProcessor(2048,1,1);sourceNode.connect(sp);sp.connect(ctx.destination);sp.onaudioprocess=(ev)=>{if(!this.isRecording)return;const ch=ev.inputBuffer.getChannelData(0);this._bufs.push(new Float32Array(ch))};this._script=sp;this.isRecording=true},stop(){if(!this.isRecording)return;this.isRecording=false;try{this._script.disconnect()}catch{}try{sourceNode.disconnect(this._script)}catch{}},getAudioBuffer(){const total=this._bufs.reduce((s,a)=>s+a.length,0);if(total===0)return null;const out=ctx.createBuffer(1,total,this._sr);const o=out.getChannelData(0);let off=0;for(const a of this._bufs){o.set(a,off);off+=a.length}return out}};return rec}

  // Animation Loops
  function tickProgress(){
    if(!audioCtx || audioCtx.state === 'suspended'){ requestAnimationFrame(tickProgress); return; }
    const now=audioCtx.currentTime; const len = loopLenSec || measureLength;
    if(len > 0 && (playing || (recordingTrack!==-1))) {
        let frac = 0; if(startAt <= now) { frac = ((now - startAt) % len) / len; }
        const pos=Math.floor(frac*LED_CELLS)%LED_CELLS;
        tracks.forEach(tr=>{
          if(tr.source || recordingTrack === tr.i) {
              if(tr.progressEl) tr.progressEl.style.width=(frac*100).toFixed(1)+'%';
              if(tr.leds) tr.leds.forEach((d,idx)=>d.classList.toggle('on',idx===pos));
              if(tr.easyFillEl) tr.easyFillEl.style.width=(frac*100).toFixed(1)+'%';
          }
        });
    }
    requestAnimationFrame(tickProgress);
  }
  function tickMeter(){
    if(!audioCtx || audioCtx.state === 'suspended' || !analyser){ requestAnimationFrame(tickMeter); return; }
    const arr=new Uint8Array(analyser.fftSize); analyser.getByteTimeDomainData(arr); let sum=0; for(let i=0;i<arr.length;i++){ const v=(arr[i]-128)/128; sum+=v*v; }
    const rms=Math.sqrt(sum/arr.length); const pct=Math.min(100,Math.max(0,rms*140*100)); meterFill.style.width=pct.toFixed(0)+'%';
    if (recordingTrack !== -1) { meterFill.classList.add('recording'); } else { meterFill.classList.remove('recording'); }
    requestAnimationFrame(tickMeter);
  }
  requestAnimationFrame(tickProgress); requestAnimationFrame(tickMeter);

  // Standard Export & Save
  exportMixBtn.addEventListener('click',async()=>{if(!hasAudio()){toast('Empty');return}const sr=audioCtx?.sampleRate||44100;const len=Math.floor(loopLenSec*sr);const off=new OfflineAudioContext(1,len,sr);tracks.forEach(t=>{if(!t.buffer)return;const src=off.createBufferSource();src.buffer=normalizeToLoop(t.buffer,loopLenSec);src.loop=true;src.loopStart=0;src.loopEnd=loopLenSec;const g=off.createGain();const vol=getVolForIndex(t.i);const gate=t.muted?0:(anySolo()?(t.solo?1:0):1);g.gain.value=vol*gate;src.connect(g).connect(off.destination);src.start(0)});const rendered=await off.startRendering();downloadBlobAs(bufferToWavBlob(rendered),`mix.wav`)});
  exportStemsBtn.addEventListener('click',()=>{if(!hasAudio()){toast('Empty');return}tracks.forEach((t,idx)=>{if(!t.buffer)return;const b=normalizeToLoop(t.buffer,loopLenSec);downloadBlobAs(bufferToWavBlob(b),`track_${idx+1}.wav`)}).filter(b=>b)});
  function hasAudio(){return!!loopLenSec&&tracks.some(t=>t.buffer)}
  function getVolForIndex(i){const row=document.querySelectorAll('.tracks .track')[i];return row?Number(row.querySelector('.vol').value)||1:1}
  saveSessBtn.addEventListener('click',async()=>{if(!audioCtx){toast('No Audio');return}const loopSec=loopLenSec||(4*(measureLength||computeMeasureLength()));const payload={version:3,loopLenSec:loopSec,bpm,tsTop,tsBottom,swingPercent,tracks:await Promise.all(tracks.map(async(t,idx)=>{const row=document.querySelectorAll('.tracks .track')[idx];const vol=row?Number(row.querySelector('.vol').value)||0.9:0.9;const obj={muted:t.muted,solo:t.solo,vol,wavDataUrl:null,fx:t.fx,history:await Promise.all(t.history.map(async(buf)=>buf?await blobToDataURL(bufferToWavBlob(buf)):null)),historyPointer:t.historyPointer};if(t.buffer){const b=normalizeToLoop(t.buffer,loopSec);const wavBlob=bufferToWavBlob(b);obj.wavDataUrl=await blobToDataURL(wavBlob)}return obj}))};const jsonBlob=new Blob([JSON.stringify(payload)],{type:'application/json'});downloadBlobAs(jsonBlob,`session.json`);toast('Saved');});
  loadSessBtn.addEventListener('click',async()=>{if(!hiddenFileInput){hiddenFileInput=document.createElement('input');hiddenFileInput.type='file';hiddenFileInput.accept='application/json';hiddenFileInput.style.display='none';document.body.appendChild(hiddenFileInput);hiddenFileInput.addEventListener('change',async(e)=>{const file=e.target.files[0];if(!file)return;const text=await file.text().catch(()=>null);if(!text){toast('Err');return}let payload=null;try{payload=JSON.parse(text)}catch{toast('Err');return}await ensureAudioReady();stopPlayback();loopLenSec=Math.max(0.5,Number(payload.loopLenSec)||2);bpm=Number(payload.bpm)||120;bpmInput.value=bpm;bpmSlider.value=bpm;tsTop=Number(payload.tsTop)||4;timeTopSel.value=tsTop;tsBottom=Number(payload.tsBottom)||4;timeBottomSel.value=tsBottom;swingPercent=Number(payload.swingPercent)||0;swingSlider.value=swingPercent;swingLabel.textContent=swingPercent+'%';updateMeasureDisplay();const measures=Math.max(1,Math.round(loopLenSec/measureLength));loopLenSec=measures*measureLength;setLoopLenDisplay();for(let i=0;i<tracks.length;i++){const t=tr(i);const data=payload.tracks?.[i];if(t.source){try{t.source.stop()}catch{}t.source.disconnect();t.source=null}t.buffer=null;t.history=[];t.historyPointer=-1;const row=document.querySelectorAll('.tracks .track')[i];const vol=data?.vol??0.9;if(row){row.querySelector('.vol').value=String(vol)}t.muted=!!data?.muted;t.solo=!!data?.solo;if(data?.fx)t.fx={...getDefaultFxState(),...data.fx};else t.fx=getDefaultFxState();updateAllFxForTrack(t);if(payload.version>=3&&data?.history){const loadedHistory=await Promise.all(data.history.map(async(dataUrl)=>{if(!dataUrl)return null;const wavAb=dataURLToArrayBuffer(dataUrl);return await audioCtx.decodeAudioData(wavAb).catch(()=>null);}));t.history=loadedHistory.slice(0,MAX_HISTORY);t.historyPointer=data.historyPointer??(t.history.length>0?t.history.length-1:-1);}if(data?.wavDataUrl){const wavAb=dataURLToArrayBuffer(data.wavDataUrl);const buf=await audioCtx.decodeAudioData(wavAb).catch(()=>null);if(buf){applyBufferToTrack(i,normalizeToLoop(toMonoWithFades(buf,0.004),loopLenSec))}else{t.statusEl.textContent='Empty';if(t.easyStatusEl)t.easyStatusEl.textContent='EMPTY';}}else{t.statusEl.textContent='Empty';if(t.easyStatusEl)t.easyStatusEl.textContent='EMPTY';}}exportMixBtn.disabled=!tracks.some(x=>x.buffer);exportStemsBtn.disabled=!tracks.some(x=>x.buffer);refreshGains();toast('Loaded')})}hiddenFileInput.value='';hiddenFileInput.click()});
  function downloadBlobAs(blob,filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;document.body.appendChild(a);a.click();setTimeout(()=>{try{document.body.removeChild(a)}catch{}URL.revokeObjectURL(url)},1500)}
  async function blobToDataURL(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob)})}
  function dataURLToArrayBuffer(dataURL){const comma=dataURL.indexOf(',');const base64=dataURL.slice(comma+1);const bin=atob(base64);const len=bin.length;const buf=new ArrayBuffer(len);const view=new Uint8Array(buf);for(let i=0;i<len;i++)view[i]=bin.charCodeAt(i);return buf}
  function bufferToWavBlob(buffer){const wav=encodeWAV(buffer);return new Blob([wav],{type:'audio/wav'})}
  function encodeWAV(buffer){const numCh=1,sr=buffer.sampleRate,data=buffer.getChannelData(0),len=data.length;const bytes=new ArrayBuffer(44+len*2);const view=new DataView(bytes);const W=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i))};W(0,'RIFF');view.setUint32(4,36+len*2,true);W(8,'WAVE');W(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,numCh,true);view.setUint32(24,sr,true);view.setUint32(28,sr*numCh*2,true);view.setUint16(32,numCh*2,true);view.setUint16(34,16,true);W(36,'data');view.setUint32(40,len*2,true);let off=44;for(let i=0;i<len;i++){let s=Math.max(-1,Math.min(1,data[i]));view.setInt16(off,s<0?s*0x8000:s*0x7fff,true);off+=2}return view}
  function toMonoWithFades(buf,fadeSec=0.003){const ch=buf.numberOfChannels,len=buf.length,out=audioCtx.createBuffer(1,len,buf.sampleRate);const o=out.getChannelData(0);if(ch===1){o.set(buf.getChannelData(0))}else{const a=buf.getChannelData(0),b=buf.getChannelData(1);for(let i=0;i<len;i++)o[i]=0.5*(a[i]+b[i])}const f=Math.max(1,Math.floor(fadeSec*out.sampleRate));for(let k=0;k<f;k++){const t=k/f;o[k]*=t;o[len-1-k]*=t}return out}
  function fitBufferToLoop(buf,loopLen){const sr=buf.sampleRate,want=Math.floor(loopLen*sr);const out=audioCtx.createBuffer(1,want,sr);const o=out.getChannelData(0);const iData=buf.getChannelData(0);const n=Math.min(want,buf.length);o.set(iData.subarray(0,n),0);const f=Math.max(1,Math.floor(0.003*sr));for(let i=0;i<f;i++){const t=i/f;o[want-1-i]*=t}return out}
  function fitOrScale(buf,newLen,mode){if(mode==='trim')return fitBufferToLoop(buf,newLen);const ratio=newLen/buf.duration;const sr=buf.sampleRate,outLen=Math.max(1,Math.floor(buf.length*ratio));const out=audioCtx.createBuffer(1,outLen,sr);const o=out.getChannelData(0),i=buf.getChannelData(0);for(let n=0;n<outLen;n++){const x=n/ratio;const i0=Math.floor(x),i1=Math.min(buf.length-1,i0+1);const f=x-i0;o[n]=i[i0]*(1-f)+i[i1]*f}const F=Math.max(1,Math.floor(0.003*sr));for(let k=0;k<F;k++){const t=k/F;o[k]*=t;o[outLen-1-k]*=t}return out}
  function normalizeToLoop(buf,loopLen){return Math.abs(buf.duration-loopLen)<1e-3?buf:fitBufferToLoop(buf,loopLen)}

})();
