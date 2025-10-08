(() => {
  // ====== Tunables ======
  const PRE_ROLL_MS = 120, TAIL_MS = 60, NO_LOOP_STOP_GRACE_MS = 80;
  // NEW: History tunables
  const MAX_HISTORY = 10; // Maximum number of undo steps

  // ====== State ======
  const N = 8, LED_CELLS = 32;
  let audioCtx = null, mediaStream = null, mediaRec = null;
  let recordingTrack = -1, chunks = [];
  let loopLenSec = null, playing = false, startAt = 0;
  let inputNode = null, inputGainNode = null, limiterNode = null, processedStreamDest = null;
  let analyser = null, monitorGain = null;
  let recBusy = false, recSchedule = null, fallbackRec = null, hiddenFileInput = null;
  let monitorInitialized = false, monitorPrevValue = 0;
  let metronomeEnabled = false, metronomeGain = null, metronomeTimerID = null;
  
  // Metronome / tempo / time signature / swing
  let bpm = 120, tsTop = 4, tsBottom = 4, swingPercent = 0;
  let measureLength = null; // seconds per measure
  let metroNextSubdivTime = 0; // next scheduled subdivision time (AudioContext time)
  let metroSubdivIndex = 0; // 0 .. (tsTop * metroPulseSubdivisions - 1)
  let metroPulseSubdivisions = 1; // 1=Quarter, 2=Eighth, 4=16th (per beat) (NEW)
  const scheduleAheadTime = 0.12, scheduleLookahead = 25.0; // ms for scheduling loop

  let fxPanelState = { currentTrack: -1, reverbImpulse: null };

  const tracks = Array.from({length:N}, (_,i)=>({
    i, label:'T'+(i+1), colorClass:'c'+(i+1),
    buffer:null, source:null, gainNode:null,
    muted:false, solo:false, leds:[], progressEl:null, statusEl:null, recChip:null,
    // FX nodes and state for each track
    fx: getDefaultFxState(),
    fxNodes: {},
    // NEW: Undo/Redo State
    history: [],
    historyPointer: -1,
    undoBtn: null,
    redoBtn: null
  }));

  // ====== DOM ======
  const tEl = document.getElementById('tracks'), initBtn = document.getElementById('initBtn'), playBtn = document.getElementById('playBtn'),
        stopBtn = document.getElementById('stopBtn'), 
        // MODIFIED: loopMeasures replaces loopLenInput
        loopMeasuresInput = document.getElementById('loopMeasures'), applyLoopBtn = document.getElementById('applyLoop'),
        fitModeSel = document.getElementById('fitMode'), loopBadge = document.getElementById('loopBadge'), exportMixBtn = document.getElementById('exportMix'),
        exportStemsBtn = document.getElementById('exportStems'), saveSessBtn = document.getElementById('saveSess'), loadSessBtn = document.getElementById('loadSess'),
        monitorChk = document.getElementById('monitorChk'), meterFill = document.getElementById('meterFill'), toastEl = document.getElementById('toast'),
        inputGain = document.getElementById('inputGain'), metroBtn = document.getElementById('metroBtn'), metroVol = document.getElementById('metroVol'),
        // NEW: Metronome Pulse Subdivision Select
        metroSubdivisionsSel = document.getElementById('metroSubdivisions'),
        fxPanel = document.getElementById('fxPanel'), fxPanelHeader = document.getElementById('fxPanelHeader'),
        fxPanelTitle = document.getElementById('fxPanelTitle'), fxPanelClose = document.getElementById('fxPanelClose'), fxPanelContent = document.getElementById('fxPanelContent'),
        fxPanelResizeHandle = document.getElementById('fxPanelResizeHandle');

  // Tempo UI elements
  const bpmInput = document.getElementById('bpmInput'), bpmSlider = document.getElementById('bpmSlider'),
        timeTopSel = document.getElementById('timeTop'), timeBottomSel = document.getElementById('timeBottom'),
        swingSlider = document.getElementById('swingSlider'), swingLabel = document.getElementById('swingLabel'),
        measureInfo = document.getElementById('measureInfo');

  // populate top number select 1..13
  for (let i=1;i<=32;i++){
    const opt = document.createElement('option'); opt.value = String(i); opt.textContent = String(i);
    if (i===4) opt.selected = true;
    timeTopSel.appendChild(opt);
  }

  // ====== UI Build ======
  function buildUI(){
    tEl.innerHTML = '';
    tracks.forEach(tr=>{
      const row = document.createElement('div'); row.className='track';
      const tag = document.createElement('div'); tag.className='tlabel '+tr.colorClass; tag.textContent=tr.label; row.appendChild(tag);
      const mid = document.createElement('div'); mid.className='mid';
      const leds = document.createElement('div'); leds.className='leds';
      tr.leds = []; for(let k=0;k<LED_CELLS;k++){ const d=document.createElement('div'); d.className='led'; leds.appendChild(d); tr.leds.push(d); } mid.appendChild(leds);
      const bar = document.createElement('div'); bar.className='bar'; const fill = document.createElement('div'); fill.className='fill'; bar.appendChild(fill); tr.progressEl = fill; mid.appendChild(bar); row.appendChild(mid);
      
      const ctrls = document.createElement('div'); ctrls.className='ctrls';
      const recBtn = document.createElement('button'); recBtn.className='btn small'; recBtn.textContent='Rec'; recBtn.disabled = true;
      const stopRecBtn = document.createElement('button'); stopRecBtn.className='btn small red'; stopRecBtn.textContent='Stop Rec'; stopRecBtn.disabled = true;
      const clrBtn = document.createElement('button'); clrBtn.className='btn small'; clrBtn.textContent='Clear'; clrBtn.disabled = true;
      // NEW: Undo/Redo Buttons
      const undoBtn = document.createElement('button'); undoBtn.className='btn small'; undoBtn.textContent='Undo'; undoBtn.disabled = true;
      const redoBtn = document.createElement('button'); redoBtn.className='btn small'; redoBtn.textContent='Redo'; redoBtn.disabled = true;
      const fxBtn = document.createElement('button'); fxBtn.className='btn small blue'; fxBtn.textContent='FX'; fxBtn.disabled = true;
      const muteBtn = document.createElement('button'); muteBtn.className='btn small'; muteBtn.textContent='Mute'; muteBtn.disabled = true;
      const soloBtn = document.createElement('button'); soloBtn.className='btn small'; soloBtn.textContent='Solo'; soloBtn.disabled = true;
      const vol = document.createElement('input'); vol.className='vol'; vol.type='range'; vol.min=0; vol.max=1; vol.step=0.01; vol.value=0.9; vol.disabled = true;
      const chip = document.createElement('span'); chip.className='chip idle'; chip.textContent='Idle';
      ctrls.append(recBtn, stopRecBtn, clrBtn, undoBtn, redoBtn, fxBtn, muteBtn, soloBtn, vol, chip); row.appendChild(ctrls);
      
      const status = document.createElement('div'); status.className='status'; status.textContent='—'; row.appendChild(status);
      tr.statusEl = status; tr.recChip = chip;
      // NEW: Store Undo/Redo button references
      tr.undoBtn = undoBtn; tr.redoBtn = redoBtn;
      
      recBtn.addEventListener('click', ()=> safeRecordStart(tr.i, recBtn, stopRecBtn));
      stopRecBtn.addEventListener('click', ()=> stopRecording());
      clrBtn.addEventListener('click', ()=> clearTrack(tr.i));
      // NEW: Undo/Redo listeners
      undoBtn.addEventListener('click', ()=> undo(tr.i));
      redoBtn.addEventListener('click', ()=> redo(tr.i));
      // FX button functionality is correct:
      fxBtn.addEventListener('click', () => openFxPanel(tr.i));
      muteBtn.addEventListener('click', ()=> toggleMute(tr.i, muteBtn));
      soloBtn.addEventListener('click', ()=> toggleSolo(tr.i, soloBtn));
      vol.addEventListener('input', e=> setVolume(tr.i, Number(e.target.value)));
      
      tEl.appendChild(row);
    });
  }
  buildUI();

  function enableControls(on){
    document.querySelectorAll('.ctrls .btn').forEach(b=>{
      const label = b.textContent;
      if (label==='Rec' || label==='FX') b.disabled = !on;
      else if (label==='Stop Rec' || label==='Undo' || label==='Redo') b.disabled = true; // Undo/Redo disabled by default, managed by updateUndoRedoBtns
      else if (label !== 'Mute' && label !== 'Solo' && label !== 'Clear') b.disabled = !on;
    });
    document.querySelectorAll('.ctrls .btn[disabled]').forEach(b=>{
        if (b.textContent==='Mute' || b.textContent==='Solo' || b.textContent==='Clear') b.disabled = !on;
    });
    document.querySelectorAll('.vol').forEach(v=> v.disabled = !on);
  }

  // ====== Audio setup (MOBILE-SAFE) ======
  async function ensureAudioReady(){ if (!audioCtx){ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } if (audioCtx.state === 'suspended'){ try{ await audioCtx.resume(); }catch{} } }
  async function ensureMic(){
    // Use direct getUserMedia (from working file) — allows file:// testing
    if (!mediaStream){
      try{
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      } catch(e){
        toast('Mic blocked. Allow mic in browser settings.');
        return false;
      }
    }
    if (!inputNode){
      inputNode = audioCtx.createMediaStreamSource(mediaStream);
      inputGainNode = audioCtx.createGain(); inputGainNode.gain.value = Number(inputGain.value);
      limiterNode = audioCtx.createDynamicsCompressor();
      limiterNode.threshold.setValueAtTime(-1, audioCtx.currentTime); limiterNode.knee.setValueAtTime(0, audioCtx.currentTime);
      limiterNode.ratio.setValueAtTime(20, audioCtx.currentTime); limiterNode.attack.setValueAtTime(0.001, audioCtx.currentTime);
      limiterNode.release.setValueAtTime(0.1, audioCtx.currentTime);
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.85;
      monitorGain = audioCtx.createGain(); monitorGain.gain.value = 0.0;
      processedStreamDest = audioCtx.createMediaStreamDestination();
      inputNode.connect(inputGainNode).connect(limiterNode).connect(analyser);
      limiterNode.connect(processedStreamDest);
      analyser.connect(monitorGain).connect(audioCtx.destination);
      tickMeter();
      if (!monitorInitialized){
        monitorChk.disabled = false; monitorChk.checked = false;
        monitorChk.addEventListener('change', () => { if (monitorGain) monitorGain.gain.value = monitorChk.checked ? 0.18 : 0.0; });
        monitorInitialized = true;
      }
    }
    if (!mediaRec && window.MediaRecorder){
      const mime = getBestMime(); const streamToRecord = processedStreamDest.stream;
      try{ mediaRec = mime ? new MediaRecorder(streamToRecord, {mimeType:mime}) : new MediaRecorder(streamToRecord); } catch{ mediaRec = null; }
      if (mediaRec){ mediaRec.ondataavailable = (e)=> { if (e.data.size) chunks.push(e.data); }; mediaRec.onstop = onRecordingComplete_MediaRecorder; }
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
    if (ok){ initBtn.disabled = true; initBtn.textContent = 'Audio Ready'; }
  });
  
  inputGain.addEventListener('input', e => { if (inputGainNode) inputGainNode.gain.setTargetAtTime(Number(e.target.value), audioCtx.currentTime, 0.01); });
  
  // ====== Metronome / Tempo / Time Signature / Swing Logic (MODIFIED) ======
  function computeMeasureLength(){
    // measureLength = seconds per measure = (60 / BPM) * top * (4 / bottom)
    const beatSec = 60 / bpm; // quarter note at BPM
    const scale = 4 / tsBottom; // e.g., bottom=8 => scale=0.5 (eighth is half of quarter)
    return beatSec * tsTop * scale;
  }

  function updateMeasureDisplay(){
    measureLength = computeMeasureLength();
    measureInfo.textContent = `Measure: ${measureLength.toFixed(3)} s • ${tsTop}/${tsBottom} • ${bpm} BPM`;
    // If loopLenSec exists, update loop display and measures input
    if (loopLenSec){
      const measures = Math.max(1, Math.round(loopLenSec / measureLength));
      // Re-calculate loopLenSec to snap to the new whole measure length
      loopLenSec = measures * measureLength;
      
      loopBadge.style.display = 'inline-block';
      loopBadge.textContent = 'Loop: ' + loopLenSec.toFixed(2) + ' s (' + measures + ' measure' + (measures>1?'s':'') + ')';
      loopMeasuresInput.value = measures; // Update the loop measures input field
    }
  }

  function scheduleMetroTickAt(time, isAccent){
    // create a short click: accented is higher pitch/volume
    const osc = audioCtx.createOscillator();
    const env = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = isAccent ? 1000 : 800;
    const vol = isAccent ? 1.0 : 0.7;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(vol * (metronomeGain ? metronomeGain.gain.value : 0.4), time + 0.001);
    env.gain.linearRampToValueAtTime(0, time + 0.08);
    osc.connect(env).connect(metronomeGain || audioCtx.destination);
    osc.start(time);
    osc.stop(time + 0.09);
  }

  function metronomeScheduler(){
    if (!metronomeEnabled || !measureLength) return;
    const now = audioCtx.currentTime;
    
    // totalSubdivisionsPerMeasure = tsTop (beats) * metroPulseSubdivisions (subdivisions per beat)
    const totalSubdivisionsPerMeasure = tsTop * metroPulseSubdivisions;
    const beatDuration = measureLength / tsTop; // seconds per beat

    // schedule ahead for small window
    while (metroNextSubdivTime < now + scheduleAheadTime){
      const idx = metroSubdivIndex % totalSubdivisionsPerMeasure;
      const beatIndex = Math.floor(idx / metroPulseSubdivisions); // which beat within measure (0..tsTop-1)
      const subdivIndexInBeat = idx % metroPulseSubdivisions; // 0 .. metroPulseSubdivisions-1

      // 1. Determine Accent: Accent only on the first subdivision of the first beat
      const isAccent = (beatIndex === 0 && subdivIndexInBeat === 0);

      // 2. Determine Pulse Duration (considering swing)
      let pulseDuration = beatDuration / metroPulseSubdivisions; // default equal division
      
      // Swing logic only applies when metroPulseSubdivisions is 2 (eighth notes)
      if (metroPulseSubdivisions === 2 && swingPercent > 0) {
        // Two subdivisions per beat (eighths)
        const firstDur = beatDuration * (0.5 + (swingPercent/100)/2); // on-beat (longer)
        const secondDur = beatDuration - firstDur; // off-beat (shorter)
        
        if (subdivIndexInBeat === 0){
          pulseDuration = firstDur;
        } else {
          pulseDuration = secondDur;
        }
      }

      scheduleMetroTickAt(metroNextSubdivTime, isAccent);
      
      // Advance to the next time slot
      metroNextSubdivTime += pulseDuration;
      metroSubdivIndex++;
      
      // Wrap every measure
      if (metroSubdivIndex >= totalSubdivisionsPerMeasure) {
        metroSubdivIndex = 0;
        // Snap the next metronome start to the measure boundary
        let ref = playing ? startAt : audioCtx.currentTime;
        const nowAtNextMeasure = ref + Math.ceil((now - ref) / measureLength) * measureLength;
        metroNextSubdivTime = nowAtNextMeasure;
      }
      
      if (pulseDuration <= 0) break; // Safety
    }
    // run again
    metronomeTimerID = setTimeout(metronomeScheduler, scheduleLookahead);
  }

  function startMetronome(){
    if (!metronomeEnabled || !measureLength) return;
    if (metronomeTimerID) return;
    
    // Compute next start time, snapped to the next measure boundary
    const now = audioCtx.currentTime;
    let ref = playing ? startAt : now;
    const measuresSinceRef = Math.floor((now - ref) / measureLength);
    // Start at the next whole measure boundary after 'now'
    const nextMeasureBoundary = ref + (measuresSinceRef + 1) * measureLength;
    
    metroNextSubdivTime = nextMeasureBoundary;
    metroSubdivIndex = 0;
    
    // start scheduler
    metronomeScheduler();
  }

  function stopMetronome(){
    if (metronomeTimerID) clearTimeout(metronomeTimerID);
    metronomeTimerID = null;
  }

  // UI hookup for tempo/time/swing
  function setupTempoUI(){
    // initial read
    bpm = Number(bpmInput.value) || 120;
    bpmSlider.value = bpm;
    tsTop = Number(timeTopSel.value) || 4;
    tsBottom = Number(timeBottomSel.value) || 4;
    swingPercent = Number(swingSlider.value) || 0;
    swingLabel.textContent = swingPercent + '%';
    metroPulseSubdivisions = Number(metroSubdivisionsSel.value) || 1; // NEW: Read initial pulse
    updateMeasureDisplay();

    // Event listeners
    bpmInput.addEventListener('change', ()=>{
      bpm = Math.max(40, Math.min(240, Number(bpmInput.value) || 120));
      bpmInput.value = bpm;
      bpmSlider.value = bpm;
      updateMeasureDisplay();
      if (metronomeEnabled){ stopMetronome(); startMetronome(); }
    });
    bpmSlider.addEventListener('input', ()=>{
      bpm = Number(bpmSlider.value);
      bpmInput.value = bpm;
      updateMeasureDisplay();
      if (metronomeEnabled){ stopMetronome(); startMetronome(); }
    });
    timeTopSel.addEventListener('change', ()=>{
      tsTop = Number(timeTopSel.value) || 4;
      updateMeasureDisplay();
      if (metronomeEnabled){ stopMetronome(); startMetronome(); }
    });
    timeBottomSel.addEventListener('change', ()=>{
      tsBottom = Number(timeBottomSel.value) || 4;
      updateMeasureDisplay();
      if (metronomeEnabled){ stopMetronome(); startMetronome(); }
    });
    swingSlider.addEventListener('input', ()=>{
      swingPercent = Number(swingSlider.value);
      swingLabel.textContent = swingPercent + '%';
      // Swing only affects the calculation within the scheduler, no need for immediate restart
    });
    // NEW: Metronome Pulse Subdivision listener
    metroSubdivisionsSel.addEventListener('change', (e) => {
      metroPulseSubdivisions = Number(e.target.value) || 1;
      if (metronomeEnabled){ stopMetronome(); startMetronome(); }
    });
    // END NEW

    metroBtn.addEventListener('click', ()=>{
      metronomeEnabled = !metronomeEnabled;
      metroBtn.textContent = metronomeEnabled ? 'Metro ON' : 'Metro Off';
      metroBtn.className = metronomeEnabled ? 'btn small green' : 'btn small gray';
      if (metronomeEnabled) startMetronome(); else stopMetronome();
    });
    metroVol.addEventListener('input', ()=>{ if (metronomeGain) metronomeGain.gain.value = Number(metroVol.value); });
  }
  setupTempoUI();

  // ====== Transport (Only change is to startAt in playBtn to ensure measure boundary alignment) ======
  playBtn.addEventListener('click', async ()=>{ 
    await ensureAudioReady(); 
    if (!loopLenSec){ 
        // Calculate loop length from measures input
        const measures = Math.max(1, Number(loopMeasuresInput.value) || 4); 
        if (!measureLength) measureLength = computeMeasureLength();
        loopLenSec = measures * measureLength; 
        setLoopLenDisplay(); 
    } 
    startPlayback(); 
  });
  stopBtn.addEventListener('click', stopPlayback);
  
  function startPlayback(){
    if (playing || !loopLenSec) return;
    
    // Find next measure start time (quantization)
    const now = audioCtx.currentTime;
    const measuresSinceRef = Math.floor(now / loopLenSec);
    // Align transport to the next loop start after current time
    const t0 = (measuresSinceRef + 1) * loopLenSec; 

    tracks.forEach(tr=>{
      if (tr.source){ try{ tr.source.stop(); }catch{} tr.source.disconnect(); tr.source=null; }
      if (!tr.buffer) return;
      const buf = normalizeToLoop(tr.buffer, loopLenSec);
      const src = audioCtx.createBufferSource();
      src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = loopLenSec;
      src.connect(tr.fxNodes.input); // Connect to the start of the FX chain
      src.start(t0);
      tr.source = src;
    });
    startAt = t0; playing = true; tickProgress();
    if (metronomeEnabled) startMetronome();
  }
  
  function stopPlayback(){
    if (!playing) return;
    stopMetronome();
    tracks.forEach(tr=>{
      if (tr.source){ try{ tr.source.stop(); }catch{} tr.source.disconnect(); tr.source=null; }
      if (tr.progressEl) tr.progressEl.style.width='0%';
      tr.leds.forEach(d=>d.classList.remove('on'));
    });
    playing = false;
  }
  
  // ====== Recording, Track Ops, Utils... (kept intact except where needed) ======
  // NEW: History functions
  function pushHistory(i) {
    const t = tr(i);
    // Clear future history (redo stack)
    if (t.historyPointer < t.history.length - 1) {
      t.history.splice(t.historyPointer + 1);
    }
    // Only push if the current buffer is different from the last history entry (or if history is empty)
    if (t.buffer !== t.history[t.history.length - 1]) {
      // Add current buffer (can be null) to the history
      t.history.push(t.buffer);
    }
    // Trim history to max size
    if (t.history.length > MAX_HISTORY) {
      t.history.shift();
    }
    t.historyPointer = t.history.length - 1;
    updateUndoRedoBtns(i);
  }

  function applyBufferToTrack(i, buffer) {
    const t = tr(i);
    // Stop and disconnect old source
    if (t.source){ try{ t.source.stop() }catch{} t.source.disconnect(); t.source=null; }
    
    t.buffer = buffer;

    // Update UI status
    t.statusEl.textContent = buffer ? 'Ready (' + buffer.duration.toFixed(2) + 's)' : '—';
    // Update global export buttons
    exportMixBtn.disabled = !tracks.some(x=>x.buffer);
    exportStemsBtn.disabled = !tracks.some(x=>x.buffer);

    // If playing, start new source
    if (playing && buffer && loopLenSec) {
      const src = audioCtx.createBufferSource();
      src.buffer = normalizeToLoop(buffer, loopLenSec);
      src.loop = true; src.loopStart = 0; src.loopEnd = loopLenSec;
      src.connect(t.fxNodes.input);
      const now = audioCtx.currentTime;
      const elapsed = (now - startAt) % loopLenSec;
      src.start(now, elapsed);
      t.source = src;
    } else {
      // If buffer is null or not playing, reset progress
      t.progressEl.style.width='0%';
      t.leds.forEach(d=>d.classList.remove('on'));
    }

    // Check if loop length needs to be reset if all tracks are clear
    if (!tracks.some(x=>x.buffer)){
      loopLenSec=null;
      setLoopLenDisplay();
    }
  }

  function undo(i) {
    const t = tr(i);
    if (t.historyPointer > 0) {
      t.historyPointer--;
      // The current state is the buffer at historyPointer
      applyBufferToTrack(i, t.history[t.historyPointer]);
      updateUndoRedoBtns(i);
    }
  }

  function redo(i) {
    const t = tr(i);
    if (t.historyPointer < t.history.length - 1) {
      t.historyPointer++;
      // The current state is the buffer at historyPointer
      applyBufferToTrack(i, t.history[t.historyPointer]);
      updateUndoRedoBtns(i);
    }
  }

  function updateUndoRedoBtns(i) {
    const t = tr(i);
    // Can undo if there is a previous state in history (pointer > 0)
    t.undoBtn.disabled = t.historyPointer <= 0;
    // Can redo if there is a next state in history (pointer < max index)
    t.redoBtn.disabled = t.historyPointer >= t.history.length - 1;
  }
  // END NEW: History functions


  async function safeRecordStart(i,recBtn,stopRecBtn){ if(recBusy)return;recBusy=true;tr(i).recChip.className='chip arm';tr(i).recChip.textContent='Arming…';await ensureAudioReady();const ok=await ensureMic();if(!ok){tr(i).recChip.className='chip idle';tr(i).recChip.textContent='Idle';recBusy=false;return}monitorPrevValue=monitorGain?monitorGain.gain.value:0;if(monitorGain)monitorGain.gain.value=0.0;recBtn.disabled=true;stopRecBtn.disabled=false;recordingTrack=i;chunks=[];tr(i).statusEl.textContent='Recording…';tr(i).progressEl.classList.add('rec');tr(i).recChip.className='chip rec';tr(i).recChip.textContent='REC';const usingMediaRecorder=!!mediaRec;if(loopLenSec&&playing){const now=audioCtx.currentTime;const elapsed=(now-startAt)%loopLenSec;let timeToBoundary=loopLenSec-elapsed;if(timeToBoundary<PRE_ROLL_MS/1000+0.04)timeToBoundary+=loopLenSec;const boundaryAt=now+timeToBoundary;const stopAtCtx=boundaryAt+loopLenSec+(TAIL_MS/1000);if(usingMediaRecorder){let startActual=audioCtx.currentTime;try{mediaRec.start()}catch(e){toast('Recorder failed.');endRecUI(i);recBusy=false;restoreMonitorAfterRecord();return}recSchedule={track:i,startAtCtxActual:startActual,stopAtCtx,boundaryAtCtx:boundaryAt};sweepRecordLEDs(i);waitUntil(stopAtCtx,()=>{if(mediaRec&&mediaRec.state==='recording'){try{if(mediaRec.requestData)mediaRec.requestData()}catch{}mediaRec.stop()}})}else{fallbackRec.start();fallbackRec._startCtxActual=audioCtx.currentTime;recSchedule={track:i,startAtCtxActual:fallbackRec._startCtxActual,stopAtCtx,boundaryAtCtx:boundaryAt};sweepRecordLEDs(i);waitUntil(stopAtCtx,()=>{fallbackRec.stop();onRecordingComplete_Fallback(i)})}}else{if(usingMediaRecorder){try{mediaRec.start()}catch(e){toast('Recorder failed.');endRecUI(i);recBusy=false;restoreMonitorAfterRecord();return}sweepRecordLEDs(i)}else{fallbackRec.start();fallbackRec._startCtxActual=audioCtx.currentTime;sweepRecordLEDs(i)}}recBusy=false}
  function stopRecording(){const t=audioCtx.currentTime;const when=t+NO_LOOP_STOP_GRACE_MS/1000;if(mediaRec&&mediaRec.state==='recording'){waitUntil(when,()=>{try{if(mediaRec.requestData)mediaRec.requestData()}catch{}mediaRec.stop()})}else if(fallbackRec&&fallbackRec.isRecording){waitUntil(when,()=>{fallbackRec.stop();onRecordingComplete_Fallback(recordingTrack)})}}
  function waitUntil(whenCtxTime,fn){const tick=()=>{if(!audioCtx)return;if(audioCtx.currentTime>=whenCtxTime-0.001){fn();return}requestAnimationFrame(tick)};requestAnimationFrame(tick)}

  async function onRecordingComplete_MediaRecorder(){
    const i=recordingTrack; recordingTrack=-1; 
    tr(i).recChip.className='chip idle'; tr(i).recChip.textContent='Idle';
    // NEW: Save current state to history before recording result is applied
    pushHistory(i);
    const blob=new Blob(chunks,{type:chunks[0]?.type||'audio/webm'}); let ab; try{ab=await blob.arrayBuffer()}catch{endRecUI(i);restoreMonitorAfterRecord();return}
    let buf=await audioCtx.decodeAudioData(ab).catch(()=>null); if(!buf){toast('Decode failed.');endRecUI(i);restoreMonitorAfterRecord();return}
    buf=toMonoWithFades(buf,0.004);
    if(recSchedule&&recSchedule.track===i){
      const sr=buf.sampleRate;const startActual=recSchedule.startAtCtxActual;const boundary=recSchedule.boundaryAtCtx;
      let pre=Math.max(0,Math.floor((boundary-startActual)*sr));const want=Math.max(1,Math.floor(loopLenSec*sr));let data=buf.getChannelData(0);const headTrim=Math.min(pre,data.length);data=data.subarray(headTrim);const out=audioCtx.createBuffer(1,want,sr);out.getChannelData(0).set(data.subarray(0,want),0);buf=out;recSchedule=null
    } else{
      if(!loopLenSec){
        // Calculate loop length based on measures on first recording if loop is not set
        const measures = Math.max(1, Math.round(buf.duration / (measureLength || computeMeasureLength())));
        loopLenSec = measures * (measureLength || computeMeasureLength());
        setLoopLenDisplay();
      }
      buf=fitBufferToLoop(buf,loopLenSec);
    }
    // NEW: Update track buffer and UI using the new function
    applyBufferToTrack(i, buf);
    // NEW: Update history pointer after successfully applying new buffer
    tr(i).historyPointer = tr(i).history.length;
    pushHistory(i); // Add the new state to history
    
    endRecUI(i);restoreMonitorAfterRecord()
  }

  function onRecordingComplete_Fallback(i){
    tr(i).recChip.className='chip idle'; tr(i).recChip.textContent='Idle';
    // NEW: Save current state to history before recording result is applied
    pushHistory(i);
    let buf=fallbackRec.getAudioBuffer();
    if(!buf){endRecUI(i);restoreMonitorAfterRecord();return}
    buf=toMonoWithFades(buf,0.004);
    if(recSchedule&&recSchedule.track===i){
      const sr=buf.sampleRate;const startActual=recSchedule.startAtCtxActual;const boundary=recSchedule.boundaryAtCtx;const pre=Math.max(0,Math.floor((boundary-startActual)*sr));const want=Math.max(1,Math.floor(loopLenSec*sr));let data=buf.getChannelData(0);const headTrim=Math.min(pre,data.length);data=data.subarray(headTrim);const out=audioCtx.createBuffer(1,want,sr);out.getChannelData(0).set(data.subarray(0,want),0);buf=out;recSchedule=null
    }else{
      // Calculate loop length based on measures on first recording if loop is not set
      if (!loopLenSec){ 
        const measures = Math.max(1, Math.round(buf.duration / (measureLength || computeMeasureLength())));
        loopLenSec = measures * (measureLength || computeMeasureLength());
        setLoopLenDisplay();
      }
      buf=fitBufferToLoop(buf,loopLenSec);
    }
    // NEW: Update track buffer and UI using the new function
    applyBufferToTrack(i, buf);
    // NEW: Update history pointer after successfully applying new buffer
    tr(i).historyPointer = tr(i).history.length;
    pushHistory(i); // Add the new state to history

    endRecUI(i);restoreMonitorAfterRecord()
  }

  function restoreMonitorAfterRecord(){if(!monitorGain)return;const wantsMonitor=monitorChk&&monitorChk.checked;monitorGain.gain.value=wantsMonitor?(typeof monitorPrevValue==='number'?monitorPrevValue:0.18):0.0}
  function endRecUI(i){document.querySelectorAll('.ctrls .btn').forEach(b=>{if(b.textContent==='Stop Rec')b.disabled=true;if(b.textContent==='Rec')b.disabled=false});const f=tr(i).progressEl;if(f)f.classList.remove('rec')}
  function sweepRecordLEDs(i){const r=tr(i);const tick=()=>{const recActive=(mediaRec&&mediaRec.state==='recording')||(fallbackRec&&fallbackRec.isRecording);if(!recActive){r.leds.forEach(d=>d.classList.remove('on'));return}const now=audioCtx.currentTime;const frac=loopLenSec&&playing?((now-startAt)%loopLenSec)/loopLenSec:((now*1.0)%1.0);const pos=Math.floor(frac*LED_CELLS)%LED_CELLS;r.leds.forEach((d,idx)=>d.classList.toggle('on',idx===pos));requestAnimationFrame(tick)};tick()}
  function tr(i){return tracks[i]}
  function clearTrack(i){
    // NEW: Push current state to history before clearing
    pushHistory(i);
    const t=tr(i);if(t.source){try{t.source.stop()}catch{}t.source.disconnect();t.source=null}
    
    // NEW: Update using the new buffer application function
    applyBufferToTrack(i, null);
    // NEW: Add the null state to history
    pushHistory(i);

    // t.buffer=null;t.statusEl.textContent='—';t.progressEl.style.width='0%';t.leds.forEach(d=>d.classList.remove('on'));
    // if(!tracks.some(x=>x.buffer)){loopLenSec=null;setLoopLenDisplay();exportMixBtn.disabled=true;exportStemsBtn.disabled=true} // Handled by applyBufferToTrack
  }
  function toggleMute(i,btn){const t=tr(i);t.muted=!t.muted;refreshGains();btn.textContent=t.muted?'Unmute':'Mute'}
  function toggleSolo(i,btn){const t=tr(i);t.solo=!t.solo;refreshGains();btn.textContent=t.solo?'Unsolo':'Solo'}
  function setVolume(i,v){const t=tr(i);if(!t.gainNode)return;t.gainNode.gain.value=v*(t.muted?0:1)*(anySolo()?(t.solo?1:0):1)}
  function anySolo(){return tracks.some(t=>t.solo)}
  function refreshGains(){const soloMode=anySolo();document.querySelectorAll('.tracks .track').forEach((row,idx)=>{const vol=Number(row.querySelector('.vol').value)||1;const t=tr(idx);const gate=t.muted?0:(soloMode?(t.solo?1:0):1);if(t.gainNode)t.gainNode.gain.value=vol*gate})}
  
  applyLoopBtn.addEventListener('click',async()=>{
    await ensureAudioReady();
    
    // Read measures from new input and calculate loop length
    const requestedMeasures = Math.max(1, Number(loopMeasuresInput.value) || 1);
    
    if (!measureLength) measureLength = computeMeasureLength();
    
    const newLen = requestedMeasures * measureLength;

    if (!loopLenSec){ loopLenSec = newLen; setLoopLenDisplay(); return; }
    
    const conformed = tracks.map(t=>{
      // NEW: Push history for each track about to be modified
      pushHistory(t.i);
      return t.buffer?fitOrScale(t.buffer,newLen,fitModeSel.value):null;
    });

    tracks.forEach((t,idx)=>{ 
      if (!conformed[idx]) {
        // If buffer was null, the clear track already pushed null to history. 
        // We only need to deal with the historyPointer being updated later.
        return; 
      } 
      // NEW: Use the new function to apply the buffer
      applyBufferToTrack(idx, conformed[idx]);
    });
    
    // After all tracks are updated:
    loopLenSec = newLen; 
    setLoopLenDisplay();

    // NEW: Push history for all tracks again to save the result of the batch operation
    tracks.forEach(t => pushHistory(t.i));

  });
  
  function setLoopLenDisplay(){ 
    if(!loopLenSec){ 
        loopBadge.style.display='none'; 
        loopMeasuresInput.value = '4'; // Reset to default measures
        return; 
    } 
    const measures = Math.round(loopLenSec / (measureLength || computeMeasureLength())); 
    loopMeasuresInput.value = measures; // Set the measure input field
    loopBadge.style.display='inline-block'; 
    loopBadge.textContent='Loop: '+loopLenSec.toFixed(2)+' s ('+measures+' measure'+(measures>1?'s':'')+')'; 
  }

  exportMixBtn.addEventListener('click',async()=>{if(!hasAudio()){toast('Record something first.');return}const sr=audioCtx?.sampleRate||44100;const len=Math.floor(loopLenSec*sr);const off=new OfflineAudioContext(1,len,sr);tracks.forEach(t=>{if(!t.buffer)return;const src=off.createBufferSource();src.buffer=normalizeToLoop(t.buffer,loopLenSec);src.loop=true;src.loopStart=0;src.loopEnd=loopLenSec;const g=off.createGain();const vol=getVolForIndex(t.i);const gate=t.muted?0:(anySolo()?(t.solo?1:0):1);g.gain.value=vol*gate;src.connect(g).connect(off.destination);src.start(0)});const rendered=await off.startRendering();downloadBlobAs(bufferToWavBlob(rendered),`looper8_mix_${loopLenSec.toFixed(2)}s.wav`)});
  exportStemsBtn.addEventListener('click',()=>{if(!hasAudio()){toast('Record something first.');return}tracks.forEach((t,idx)=>{if(!t.buffer)return;const b=normalizeToLoop(t.buffer,loopLenSec);downloadBlobAs(bufferToWavBlob(b),`looper8_t${idx+1}_${loopLenSec.toFixed(2)}s.wav`)})});
  function hasAudio(){return!!loopLenSec&&tracks.some(t=>t.buffer)}
  function getVolForIndex(i){const row=document.querySelectorAll('.tracks .track')[i];return row?Number(row.querySelector('.vol').value)||1:1}
  saveSessBtn.addEventListener('click',async()=>{if(!audioCtx){toast('Nothing to save yet.');return}const rowEls=Array.from(document.querySelectorAll('.tracks .track'));const loopSec=loopLenSec||(4*(measureLength||computeMeasureLength()));const payload={version:3,loopLenSec:loopSec,bpm,tsTop,tsBottom,swingPercent,
    tracks:await Promise.all(tracks.map(async(t,idx)=>{const row=rowEls[idx];const vol=row?Number(row.querySelector('.vol').value)||0.9:0.9;const obj={muted:t.muted,solo:t.solo,vol,wavDataUrl:null,fx:t.fx,
      // NEW: Save history - only saving buffers in history, not other track state
      history: await Promise.all(t.history.map(async (buf) => buf ? await blobToDataURL(bufferToWavBlob(buf)) : null)),
      historyPointer: t.historyPointer
    };if(t.buffer){const b=normalizeToLoop(t.buffer,loopSec);const wavBlob=bufferToWavBlob(b);obj.wavDataUrl=await blobToDataURL(wavBlob)}return obj}))};const jsonBlob=new Blob([JSON.stringify(payload)],{type:'application/json'});downloadBlobAs(jsonBlob,`looper8_session.json`);toast('Session saved.')});
  
  loadSessBtn.addEventListener('click',async()=>{if(!hiddenFileInput){hiddenFileInput=document.createElement('input');hiddenFileInput.type='file';hiddenFileInput.accept='application/json';hiddenFileInput.style.display='none';document.body.appendChild(hiddenFileInput);hiddenFileInput.addEventListener('change',async(e)=>{const file=e.target.files[0];if(!file)return;const text=await file.text().catch(()=>null);if(!text){toast('Load failed.');return}let payload=null;try{payload=JSON.parse(text)}catch{toast('Invalid session file.');return}await ensureAudioReady();stopPlayback();
            // Load loop length and update measures input
            loopLenSec=Math.max(0.5,Number(payload.loopLenSec)||2);
            // Load tempo/time/swing from payload for measure calculation
            bpm = Number(payload.bpm) || 120; bpmInput.value = bpm; bpmSlider.value = bpm;
            tsTop = Number(payload.tsTop) || 4; timeTopSel.value = tsTop;
            tsBottom = Number(payload.tsBottom) || 4; timeBottomSel.value = tsBottom;
            swingPercent = Number(payload.swingPercent) || 0; swingSlider.value = swingPercent; swingLabel.textContent = swingPercent + '%';
            updateMeasureDisplay(); // Recalculate measureLength based on loaded tempo
            
            // Ensure loop length snaps to whole measures based on loaded tempo
            const measures = Math.max(1, Math.round(loopLenSec / measureLength));
            loopLenSec = measures * measureLength;
            setLoopLenDisplay(); // This updates the new measures input field
            
            const rowEls=Array.from(document.querySelectorAll('.tracks .track'));for(let i=0;i<tracks.length;i++){const t=tr(i);const data=payload.tracks?.[i];if(t.source){try{t.source.stop()}catch{}t.source.disconnect();t.source=null}t.buffer=null;t.history=[];t.historyPointer=-1; // NEW: Reset history on load
            const row=rowEls[i];const vol=data?.vol??0.9;if(row){row.querySelector('.vol').value=String(vol)}t.muted=!!data?.muted;t.solo=!!data?.solo;if (data?.fx) t.fx = { ...getDefaultFxState(), ...data.fx }; else t.fx = getDefaultFxState();updateAllFxForTrack(t);if(row){row.querySelectorAll('.ctrls .btn').forEach(b=>{if(b.textContent==='Mute')b.textContent=t.muted?'Unmute':'Mute';if(b.textContent==='Solo')b.textContent=t.solo?'Unsolo':'Solo'})}
            
            // NEW: Load history buffers
            if (payload.version >= 3 && data?.history) {
              const loadedHistory = await Promise.all(data.history.map(async (dataUrl) => {
                if (!dataUrl) return null;
                const wavAb = dataURLToArrayBuffer(dataUrl);
                return await audioCtx.decodeAudioData(wavAb).catch(() => null);
              }));
              t.history = loadedHistory.filter(buf => buf !== null || data.history.find(d => d === null)); // Keep nulls if they were saved
              t.historyPointer = data.historyPointer ?? -1;
            }

            if(data?.wavDataUrl){
              const wavAb=dataURLToArrayBuffer(data.wavDataUrl);
              const buf=await audioCtx.decodeAudioData(wavAb).catch(()=>null);
              if(buf){
                // NEW: Use applyBufferToTrack to set the initial buffer and update UI/playback
                applyBufferToTrack(i, normalizeToLoop(toMonoWithFades(buf,0.004),loopLenSec));
              }else{
                t.statusEl.textContent='—';
              }
            }else{
              t.statusEl.textContent='—';
            }
            updateUndoRedoBtns(i); // NEW: Update buttons after history/buffer load
          }exportMixBtn.disabled=!tracks.some(x=>x.buffer);exportStemsBtn.disabled=!tracks.some(x=>x.buffer);refreshGains();toast('Session loaded.')})}hiddenFileInput.value='';hiddenFileInput.click()});
  function downloadBlobAs(blob,filename){const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.rel='noopener';a.target='_blank';document.body.appendChild(a);a.click();setTimeout(()=>{try{document.body.removeChild(a)}catch{}URL.revokeObjectURL(url)},1500)}
  async function blobToDataURL(blob){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(blob)})}
  function dataURLToArrayBuffer(dataURL){const comma=dataURL.indexOf(',');const base64=dataURL.slice(comma+1);const bin=atob(base64);const len=bin.length;const buf=new ArrayBuffer(len);const view=new Uint8Array(buf);for(let i=0;i<len;i++)view[i]=bin.charCodeAt(i);return buf}
  function bufferToWavBlob(buffer){const wav=encodeWAV(buffer);return new Blob([wav],{type:'audio/wav'})}
  function encodeWAV(buffer){const numCh=1,sr=buffer.sampleRate,data=buffer.getChannelData(0),len=data.length;const bytes=new ArrayBuffer(44+len*2);const view=new DataView(bytes);const W=(o,s)=>{for(let i=0;i<s.length;i++)view.setUint8(o+i,s.charCodeAt(i))};W(0,'RIFF');view.setUint32(4,36+len*2,true);W(8,'WAVE');W(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,numCh,true);view.setUint32(24,sr,true);view.setUint32(28,sr*numCh*2,true);view.setUint16(32,numCh*2,true);view.setUint16(34,16,true);W(36,'data');view.setUint32(40,len*2,true);let off=44;for(let i=0;i<len;i++){let s=Math.max(-1,Math.min(1,data[i]));view.setInt16(off,s<0?s*0x8000:s*0x7fff,true);off+=2}return view}
  function toMonoWithFades(buf,fadeSec=0.003){const ch=buf.numberOfChannels,len=buf.length,out=audioCtx.createBuffer(1,len,buf.sampleRate);const o=out.getChannelData(0);if(ch===1){o.set(buf.getChannelData(0))}else{const a=buf.getChannelData(0),b=buf.getChannelData(1);for(let i=0;i<len;i++)o[i]=0.5*(a[i]+b[i])}const f=Math.max(1,Math.floor(fadeSec*out.sampleRate));for(let k=0;k<f;k++){const t=k/f;o[k]*=t;o[len-1-k]*=t}return out}
  function fitBufferToLoop(buf,loopLen){const sr=buf.sampleRate,want=Math.floor(loopLen*sr);const out=audioCtx.createBuffer(1,want,sr);const o=out.getChannelData(0);const iData=buf.getChannelData(0);const n=Math.min(want,buf.length);o.set(iData.subarray(0,n),0);const f=Math.max(1,Math.floor(0.003*sr));for(let i=0;i<f;i++){const t=i/f;o[want-1-i]*=t}return out}
  function fitOrScale(buf,newLen,mode){if(mode==='trim')return fitBufferToLoop(buf,newLen);const ratio=newLen/buf.duration;const sr=buf.sampleRate,outLen=Math.max(1,Math.floor(buf.length*ratio));const out=audioCtx.createBuffer(1,outLen,sr);const o=out.getChannelData(0),i=buf.getChannelData(0);for(let n=0;n<outLen;n++){const x=n/ratio;const i0=Math.floor(x),i1=Math.min(buf.length-1,i0+1);const f=x-i0;o[n]=i[i0]*(1-f)+i[i1]*f}const F=Math.max(1,Math.floor(0.003*sr));for(let k=0;k<F;k++){const t=k/F;o[k]*=t;o[outLen-1-k]*=t}return out}
  function normalizeToLoop(buf,loopLen){return Math.abs(buf.duration-loopLen)<1e-3?buf:fitBufferToLoop(buf,loopLen)}
  function tickProgress(){if(!playing||!loopLenSec)return;const now=audioCtx.currentTime,frac=((now-startAt)%loopLenSec)/loopLenSec;const pos=Math.floor(frac*LED_CELLS)%LED_CELLS;tracks.forEach(tr=>{if(tr.progressEl)tr.progressEl.style.width=(frac*100).toFixed(1)+'%';if(tr.leds)tr.leds.forEach((d,idx)=>d.classList.toggle('on',idx===pos))});requestAnimationFrame(tickProgress)}
  function tickMeter(){if(!analyser)return;const arr=new Uint8Array(analyser.fftSize);analyser.getByteTimeDomainData(arr);let sum=0;for(let i=0;i<arr.length;i++){const v=(arr[i]-128)/128;sum+=v*v}const rms=Math.sqrt(sum/arr.length);const pct=Math.min(100,Math.max(0,rms*140*100));meterFill.style.width=pct.toFixed(0)+'%';requestAnimationFrame(tickMeter)}
  function getBestMime(){const cands=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus'];for(const m of cands){if(window.MediaRecorder&&MediaRecorder.isTypeSupported(m))return m}return''}
  function toast(msg){toastEl.textContent=msg;setTimeout(()=>toastEl.textContent='',2500)}
  function createFallbackRecorder(sourceNode,ctx){const rec={isRecording:false,_bufs:[],_script:null,_sr:ctx.sampleRate,start(){if(this.isRecording)return;this._bufs=[];const sp=ctx.createScriptProcessor(2048,1,1);sourceNode.connect(sp);sp.connect(ctx.destination);sp.onaudioprocess=(ev)=>{if(!this.isRecording)return;const ch=ev.inputBuffer.getChannelData(0);this._bufs.push(new Float32Array(ch))};this._script=sp;this.isRecording=true},stop(){if(!this.isRecording)return;this.isRecording=false;try{this._script.disconnect()}catch{}try{sourceNode.disconnect(this._script)}catch{}},getAudioBuffer(){const total=this._bufs.reduce((s,a)=>s+a.length,0);if(total===0)return null;const out=ctx.createBuffer(1,total,this._sr);const o=out.getChannelData(0);let off=0;for(const a of this._bufs){o.set(a,off);off+=a.length}return out}};return rec}

  // ====== FX PANEL LOGIC (Unchanged) ======
  function getDefaultFxState() {
    return {
      eq: { on: false, low: 0, mid: 0, high: 0 },
      comp: { on: false, threshold: -24, ratio: 12, attack: 0.003 },
      phaser: { on: false, freq: 700, depth: 0.7 },
      delay: { on: false, time: 0.3, feedback: 0.4, mix: 0.5 },
      reverb: { on: false, mix: 0.4 }
    };
  }
  
  function createFxChain(track, ctx) {
    const nodes = {};
    nodes.input = ctx.createGain();
    // EQ
    nodes.eqLow = ctx.createBiquadFilter(); nodes.eqLow.type = 'lowshelf'; nodes.eqLow.frequency.value = 300;
    nodes.eqMid = ctx.createBiquadFilter(); nodes.eqMid.type = 'peaking'; nodes.eqMid.frequency.value = 1000; nodes.eqMid.Q.value = 1.0;
    nodes.eqHigh = ctx.createBiquadFilter(); nodes.eqHigh.type = 'highshelf'; nodes.eqHigh.frequency.value = 3000;
    // Compressor
    nodes.comp = ctx.createDynamicsCompressor();
    // Phaser
    nodes.phaser = ctx.createBiquadFilter(); nodes.phaser.type = 'allpass'; nodes.phaser.Q.value = 5;
    const phaserLFO = ctx.createOscillator(); phaserLFO.type = 'sine'; phaserLFO.frequency.value = 0.5;
    const phaserDepth = ctx.createGain();
    phaserLFO.connect(phaserDepth).connect(nodes.phaser.frequency);
    phaserLFO.start();
    nodes.phaserLFO = phaserLFO; nodes.phaserDepth = phaserDepth;
    // Delay
    nodes.delay = ctx.createDelay(1.0);
    nodes.delayFeedback = ctx.createGain();
    nodes.delayWet = ctx.createGain();
    nodes.delayDry = ctx.createGain();
    // Reverb
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
    const { input, eqLow, eqMid, eqHigh, comp, phaser, delay, delayFeedback, delayWet, delayDry, reverb, reverbWet, reverbDry, output } = track.fxNodes;
    const fx = track.fx;
    input.disconnect();
    
    let lastNode = input;
    if (fx.eq.on) { lastNode.connect(eqLow); lastNode = eqLow.connect(eqMid).connect(eqHigh); }
    if (fx.comp.on) { lastNode.connect(comp); lastNode = comp; }
    if (fx.phaser.on) { lastNode.connect(phaser); lastNode = phaser; }
    
    if (fx.delay.on) {
      lastNode.connect(delayDry).connect(output);
      lastNode.connect(delay).connect(delayWet).connect(output);
      delay.connect(delayFeedback).connect(delay);
      lastNode = delayDry; // Dry path continues
    }
    
    if (fx.reverb.on) {
      lastNode.connect(reverbDry).connect(output);
      lastNode.connect(reverb).connect(reverbWet).connect(output);
    } else {
      lastNode.connect(output);
    }
  }

  function updateAllFxForTrack(track) {
    Object.keys(track.fx).forEach(fxKey => {
      Object.keys(track.fx[fxKey]).forEach(paramKey => {
        if (paramKey !== 'on') {
          updateFxParam(track, fxKey, paramKey, track.fx[fxKey][paramKey]);
        }
      });
    });
    connectFxChain(track);
  }
  
  function updateFxParam(track, fx, param, value) {
    track.fx[fx][param] = value;
    const n = track.fxNodes, now = audioCtx.currentTime;
    if(fx==='eq'){ if(param==='low') n.eqLow.gain.setTargetAtTime(value,now,0.01); if(param==='mid') n.eqMid.gain.setTargetAtTime(value,now,0.01); if(param==='high') n.eqHigh.gain.setTargetAtTime(value,now,0.01); }
    else if(fx==='comp'){ if(param==='threshold') n.comp.threshold.setTargetAtTime(value,now,0.01); if(param==='ratio') n.comp.ratio.setTargetAtTime(value,now,0.01); if(param==='attack') n.comp.attack.setTargetAtTime(value,now,0.01); }
    else if(fx==='phaser'){ if(param==='freq') n.phaser.frequency.setTargetAtTime(value,now,0.01); if(param==='depth') n.phaserDepth.gain.setTargetAtTime(value,now,0.01); }
    else if(fx==='delay'){ if(param==='time') n.delay.delayTime.setTargetAtTime(value,now,0.01); if(param==='feedback') n.delayFeedback.gain.setTargetAtTime(value,now,0.01); if(param==='mix'){n.delayWet.gain.setTargetAtTime(value,now,0.01); n.delayDry.gain.setTargetAtTime(1-value,now,0.01);} }
    else if(fx==='reverb'){ if(param==='mix'){n.reverbWet.gain.setTargetAtTime(value,now,0.01); n.reverbDry.gain.setTargetAtTime(1-value,now,0.01);} }
  }

  function openFxPanel(trackIndex) {
    fxPanelState.currentTrack = trackIndex;
    const track = tracks[trackIndex];
    fxPanelTitle.textContent = `${track.label} - FX Rack`;
    fxPanelContent.innerHTML = `
      <div class="fx-module">
        <div class="fx-title"><input type="checkbox" data-fx="eq" ${track.fx.eq.on ? 'checked' : ''}>EQ</div>
        <div class="fx-grid three"> ${['low','mid','high'].map(b=>`
          <label>${b.charAt(0).toUpperCase()+b.slice(1)}<input type="range" min="-20" max="20" step="0.1" value="${track.fx.eq[b]}" data-fx="eq" data-param="${b}"><output>${track.fx.eq[b]}</output>dB</label>`).join('')}
        </div>
      </div>
      <div class="fx-module">
        <div class="fx-title"><input type="checkbox" data-fx="comp" ${track.fx.comp.on ? 'checked' : ''}>Compressor</div>
        <div class="fx-grid three">
          <label>Threshold<input type="range" min="-100" max="0" step="1" value="${track.fx.comp.threshold}" data-fx="comp" data-param="threshold"><output>${track.fx.comp.threshold}</output>dB</label>
          <label>Ratio<input type="range" min="1" max="20" step="1" value="${track.fx.comp.ratio}" data-fx="comp" data-param="ratio"><output>${track.fx.comp.ratio}</output>:1</label>
          <label>Attack<input type="range" min="0" max="0.1" step="0.001" value="${track.fx.comp.attack}" data-fx="comp" data-param="attack"><output>${(track.fx.comp.attack*1000).toFixed(1)}</output>ms</label>
        </div>
      </div>
      <div class="fx-module">
        <div class="fx-title"><input type="checkbox" data-fx="phaser" ${track.fx.phaser.on ? 'checked' : ''}>Phaser</div>
        <div class="fx-grid">
          <label>Frequency<input type="range" min="20" max="2000" step="1" value="${track.fx.phaser.freq}" data-fx="phaser" data-param="freq"><output>${track.fx.phaser.freq}</output>Hz</label>
          <label>Depth<input type="range" min="0" max="1" step="0.01" value="${track.fx.phaser.depth}" data-fx="phaser" data-param="depth"><output>${track.fx.phaser.depth}</output></label>
        </div>
      </div>
      <div class="fx-module">
        <div class="fx-title"><input type="checkbox" data-fx="delay" ${track.fx.delay.on ? 'checked' : ''}>Delay</div>
        <div class="fx-grid three">
          <label>Time<input type="range" min="0.01" max="1.0" step="0.01" value="${track.fx.delay.time}" data-fx="delay" data-param="time"><output>${track.fx.delay.time}</output>s</label>
          <label>Feedback<input type="range" min="0" max="0.9" step="0.01" value="${track.fx.delay.feedback}" data-fx="delay" data-param="feedback"><output>${track.fx.delay.feedback}</output></label>
          <label>Mix<input type="range" min="0" max="1" step="0.01" value="${track.fx.delay.mix}" data-fx="delay" data-param="mix"><output>${track.fx.delay.mix}</output></label>
        </div>
      </div>
      <div class="fx-module">
        <div class="fx-title"><input type="checkbox" data-fx="reverb" ${track.fx.reverb.on ? 'checked' : ''}>Reverb</div>
        <div class="fx-grid">
          <label>Mix<input type="range" min="0" max="1" step="0.01" value="${track.fx.reverb.mix}" data-fx="reverb" data-param="mix"><output>${track.fx.reverb.mix}</output></label>
        </div>
      </div>
    `;
    fxPanel.style.display = 'flex';
  }
  
  fxPanelContent.addEventListener('input', e => {
    if (!e.target.dataset.fx) return;
    const track = tracks[fxPanelState.currentTrack];
    const { fx, param } = e.target.dataset;
    const value = (e.target.type === 'checkbox') ? e.target.checked : Number(e.target.value);
    
    if (e.target.type === 'range' && e.target.nextElementSibling?.tagName === 'OUTPUT') {
      let displayValue = value;
      if (fx==='comp' && param==='attack') displayValue = (value*1000).toFixed(1);
      e.target.nextElementSibling.textContent = displayValue;
    }

    if (e.target.type === 'checkbox') {
      track.fx[fx].on = value;
      connectFxChain(track);
    } else {
      updateFxParam(track, fx, param, value);
    }
  });
  
  fxPanelClose.addEventListener('click', () => { fxPanel.style.display = 'none'; fxPanelState.currentTrack = -1; });
  
  function makeDraggable(el, handle){ let pos1=0,pos2=0,pos3=0,pos4=0; handle.onmousedown=dragMouseDown; function dragMouseDown(e){ e.preventDefault(); pos3=e.clientX; pos4=e.clientY; document.onmouseup=closeDragElement; document.onmousemove=elementDrag; } function elementDrag(e){ e.preventDefault(); pos1=pos3-e.clientX; pos2=pos4-e.clientY; pos3=e.clientX; pos4=e.clientY; el.style.top=(el.offsetTop-pos2)+"px"; el.style.left=(el.offsetLeft-pos1)+"px"; } function closeDragElement(){ document.onmouseup=null; document.onmousemove=null; } }
  function makeResizable(el, handle){ let oldX=0,oldY=0,oldW=0,oldH=0; handle.onmousedown=dragMouseDown; function dragMouseDown(e){ e.preventDefault(); oldX=e.clientX; oldY=e.clientY; oldW=el.offsetWidth; oldH=el.offsetHeight; document.onmouseup=closeDragElement; document.onmousemove=elementDrag; } function elementDrag(e){ e.preventDefault(); el.style.width=(oldW+(e.clientX-oldX))+"px"; el.style.height=(oldH+(e.clientY-oldY))+"px"; } function closeDragElement(){ document.onmouseup=null; document.onmousemove=null; } }
  makeDraggable(fxPanel, fxPanelHeader);
  makeResizable(fxPanel, fxPanelResizeHandle);

  function createImpulseResponse(ctx) {
    const sr = ctx.sampleRate, len = sr * 2, decay = 2.0;
    const impulse = ctx.createBuffer(2, len, sr);
    const impL = impulse.getChannelData(0), impR = impulse.getChannelData(1);
    for (let i = 0; i < len; i++) {
        const p = i / len;
        impL[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, decay);
        impR[i] = (Math.random() * 2 - 1) * Math.pow(1 - p, decay);
    }
    return impulse;
  }

  // Initialize measureLength from defaults
  measureLength = computeMeasureLength();
  updateMeasureDisplay();

  // NEW: Initial history push for all tracks (null state)
  tracks.forEach(t => pushHistory(t.i));

})();
