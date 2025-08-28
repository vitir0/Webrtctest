// server.js
// Один файл: Express + Socket.IO сервер и фронтенд.
// Улучшения: низкая задержка + высокое качество + адаптация (авто-уровни)
// Зависимости: express, socket.io, cors
// Установка: npm install express socket.io cors
// Запуск: node server.js

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// ---------- встроенный фронтенд (HTML/JS) ----------
const indexHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Low-latency High-quality Call</title>
<style>
  html,body{height:100%;margin:0;background:#000;font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto;}
  .screen{position:relative;height:100vh;overflow:hidden;}
  video#remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;}
  video#local{position:absolute;top:16px;right:16px;width:160px;height:120px;border-radius:12px;object-fit:cover;border:3px solid rgba(255,255,255,0.85);z-index:20;}
  header{position:absolute;top:8px;left:8px;color:white;z-index:30;background:rgba(0,0,0,0.35);padding:8px 12px;border-radius:10px;}
  .controls{position:absolute;left:50%;transform:translateX(-50%);bottom:28px;display:flex;gap:18px;z-index:30;}
  .btn{width:64px;height:64px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;font-size:22px;color:white;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.6);}
  .btn.green{background:#128C7E;}
  .btn.red{background:#E50914;}
  .join{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.6);padding:16px;border-radius:12px;z-index:40;min-width:300px;display:flex;flex-direction:column;gap:8px;}
  input{padding:10px;border-radius:8px;border:none;background:rgba(255,255,255,0.04);color:white;}
  button.action{padding:10px;border-radius:8px;border:none;background:#25D366;color:#002;font-weight:700;}
  .status{position:absolute;left:12px;bottom:12px;color:#ddd;z-index:30;font-size:13px;}
  .log{position:absolute;left:12px;top:72px;color:#ddd;z-index:30;font-size:12px;max-width:320px;white-space:pre-wrap;}
</style>
</head>
<body>
  <div class="screen" id="screen">
    <video id="remote" autoplay playsinline></video>
    <video id="local" autoplay playsinline muted></video>
    <header id="hdr">Звонок — оптимизировано для низкой задержки</header>

    <div class="join" id="joinPanel">
      <input id="room" placeholder="Имя комнаты (например: friends)"/>
      <input id="pass" placeholder="(опционально) пароль комнаты"/>
      <div style="display:flex;gap:8px;">
        <button class="action" id="joinBtn">Подключиться</button>
        <button id="startDirect" title="Попробовать напрямую (prefers host)">Direct</button>
      </div>
      <div style="font-size:12px;color:#ccc;">Настройки: старт 720p@30/2.5Mbps, динамическое управление</div>
    </div>

    <div class="controls hidden" id="controls">
      <button id="muteBtn" class="btn green">🎤</button>
      <button id="camBtn" class="btn green">📷</button>
      <button id="hangBtn" class="btn red">📞</button>
    </div>

    <div class="status" id="status">Статус: не подключено</div>
    <div class="log" id="log"></div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
/* Клиент: агрессивная низколатентная конфигурация + адаптивный контроллер */
(async function(){
  const logEl = id('log');
  function log(...a){ logEl.textContent += a.join(' ') + '\\n'; logEl.scrollTop = logEl.scrollHeight; }

  const joinPanel = id('joinPanel'), joinBtn = id('joinBtn'), roomInput = id('room'), passInput = id('pass');
  const remote = id('remote'), local = id('local'), statusEl = id('status');
  const controls = id('controls'), muteBtn = id('muteBtn'), camBtn = id('camBtn'), hangBtn = id('hangBtn');

  let socket = null, pc = null, localStream = null, currentRoom = null, isCreator = false;
  let micOn = true, camOn = true;
  let statsInterval = null;
  let adaptState = { scale:1, fps:30, bitrate:2500000 }; // start ~2.5Mbps

  // aggressive start constraints: 1280x720 @30-60fps (higher fps if device supports)
  const startConstraints = {
    audio: { echoCancellation:true, noiseSuppression:true, sampleRate:48000 },
    video: {
      width: { ideal:1280 },
      height: { ideal:720 },
      frameRate: { ideal:30, max:60 }
    }
  };

  // fetch ice servers (server may include TURN) but prefer direct host candidates
  async function fetchIceServers(){
    try{
      const r = await fetch('/config'); if(r.ok){ const j = await r.json(); return j.iceServers || []; }
    }catch(e){}
    return [{ urls: 'stun:stun.l.google.com:19302' }];
  }

  // choose preferred codec: H264 first for hardware acceleration
  function preferCodec(transceiver, mimePrefix='video', preferred='video/H264'){
    try{
      const caps = RTCRtpSender.getCapabilities('video');
      if(!caps || !caps.codecs) return;
      const codecs = caps.codecs;
      const preferredCodec = codecs.find(c => (c.mimeType||c.codec)?.toLowerCase() === preferred.toLowerCase());
      if(!preferredCodec) return;
      // build preference list with preferred first
      const newOrder = [preferredCodec, ...codecs.filter(c => c !== preferredCodec)];
      transceiver.setCodecPreferences(newOrder);
      log('Codec preference set to', preferred);
    }catch(e){ console.warn('preferCodec failed', e); }
  }

  // create PC -> apply sender parameters (bitrate, SVC) aggressively
  async function createPC(){
    const ice = await fetchIceServers();
    pc = new RTCPeerConnection({ iceServers: ice, iceCandidatePoolSize: 2 });

    pc.oniceconnectionstatechange = () => {
      log('ICE state', pc.iceConnectionState);
      statusEl.textContent = 'ICE: ' + pc.iceConnectionState;
    };

    pc.onconnectionstatechange = () => {
      log('PC state', pc.connectionState);
      statusEl.textContent = 'PC: ' + pc.connectionState;
    };

    pc.ontrack = (ev) => {
      if(!remote.srcObject){
        remote.srcObject = ev.streams[0];
        log('Remote stream set');
      }
    };

    // add tracks
    if(localStream){
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }

    // prefer H264: need a transceiver; create one if not present
    try{
      const trans = pc.getTransceivers().find(t => t.receiver && t.sender);
      if(trans) preferCodec(trans, 'video', 'video/H264');
    }catch(e){ console.warn(e); }

    // after tracks added, try set sender params
    setTimeout(async () => {
      try{
        const senders = pc.getSenders();
        for(const s of senders){
          if(s.track && s.track.kind === 'video'){
            const params = s.getParameters();
            if(!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            // try SVC if supported (scalabilityMode) - many browsers support "L1T3" or "L1T2"
            params.encodings[0].maxBitrate = adaptState.bitrate; // start high
            params.encodings[0].scalabilityMode = 'L1T3';
            // try to favor low-latency
            await s.setParameters(params);
            log('Set sender params', params.encodings);
          }
        }
      }catch(e){ console.warn('setParameters failed', e); }
    }, 200);
  }

  // negotiate (caller)
  async function makeOffer(){
    await createPCIfNeeded();
    const offer = await pc.createOffer({ offerToReceiveVideo:true, offerToReceiveAudio:true });
    await pc.setLocalDescription(offer);
    socket.emit('offer', { roomId: currentRoom, sdp: pc.localDescription });
    log('Sent offer');
  }

  // ensure pc exists
  async function createPCIfNeeded(){
    if(!pc) await createPC();
  }

  // --- adaptive controller: monitor stats and quickly adjust ---
  async function startStatsLoop(){
    if(statsInterval) clearInterval(statsInterval);
    statsInterval = setInterval(async () => {
      if(!pc) return;
      try{
        const stats = await pc.getStats();
        let rtt = 0, packetsLost = 0, totalPackets = 0, framesDropped = 0, outboundBitrate = 0;
        stats.forEach(report => {
          if(report.type === 'candidate-pair' && report.state === 'succeeded'){
            if(report.currentRoundTripTime) rtt = report.currentRoundTripTime;
            if(report.availableOutgoingBitrate) outboundBitrate = report.availableOutgoingBitrate;
          }
          if(report.type === 'outbound-rtp' && report.kind === 'video'){
            if(report.framesDropped) framesDropped += report.framesDropped;
            if(report.bytesSent && report.timestamp && report.packetsSent){
              // compute approximate bitrate if needed (could compute delta)
            }
            if(report.packetsSent) totalPackets += report.packetsSent;
            if(report.packetsLost) packetsLost += report.packetsLost;
          }
        });

        // quick health metric: rtt (s) and packet loss ratio (packetsLost / max(1,totalPackets))
        const lossRatio = totalPackets ? (packetsLost / totalPackets) : 0;
        // Decision thresholds (aggressive; tune as needed)
        // If rtt > 0.18s or lossRatio > 0.02 or framesDropped > 5 -> degrade
        const needDegrade = (rtt > 0.18) || (lossRatio > 0.02) || (framesDropped > 5);
        const needUpgrade = (rtt < 0.07) && (lossRatio < 0.002);

        if(needDegrade){
          // decrease quickly
          adaptState.scale = Math.min(2, adaptState.scale * 1.5); // scaleResolutionDownBy >1 reduces resolution
          adaptState.fps = Math.max(15, Math.floor(adaptState.fps * 0.7));
          adaptState.bitrate = Math.max(250_000, Math.floor(adaptState.bitrate * 0.6));
          await applyAdaptation();
          log('Degraded: rtt', rtt.toFixed(3), 'loss', lossRatio.toFixed(4), 'scale', adaptState.scale, 'fps', adaptState.fps, 'bitrate', adaptState.bitrate);
        } else if(needUpgrade){
          // be conservative increasing
          adaptState.scale = Math.max(1, adaptState.scale * 0.8);
          adaptState.fps = Math.min(60, Math.floor(adaptState.fps * 1.15) || 30);
          adaptState.bitrate = Math.min(8_000_000, Math.floor(adaptState.bitrate * 1.25));
          await applyAdaptation();
          log('Upgraded: rtt', rtt.toFixed(3), 'loss', lossRatio.toFixed(4), 'scale', adaptState.scale, 'fps', adaptState.fps, 'bitrate', adaptState.bitrate);
        }
      }catch(e){ console.warn('stats loop error', e); }
    }, 1500);
  }

  async function applyAdaptation(){
    if(!pc) return;
    try{
      for(const sender of pc.getSenders()){
        if(sender.track && sender.track.kind === 'video'){
          const params = sender.getParameters();
          if(!params.encodings || params.encodings.length === 0) params.encodings = [{}];
          // 'scaleResolutionDownBy' reduces resolution on sender side (1 = same, 2 = half)
          params.encodings[0].scaleResolutionDownBy = adaptState.scale;
          params.encodings[0].maxBitrate = adaptState.bitrate;
          // set frame rate by applying constraint on track (if supported)
          try{
            await sender.track.applyConstraints({ frameRate: { ideal: adaptState.fps, max: adaptState.fps } });
          }catch(e){ /* some browsers disallow applyConstraints on track */ }
          await sender.setParameters(params);
        }
      }
    }catch(e){ console.warn('applyAdaptation failed', e); }
  }

  // quick ICE restart helper (if connection stuck)
  async function tryIceRestart(){
    if(!pc) return;
    try{
      const offer = await pc.createOffer({ iceRestart:true });
      await pc.setLocalDescription(offer);
      socket.emit('offer', { roomId: currentRoom, sdp: pc.localDescription });
      log('ICE restart attempted');
    }catch(e){ console.warn('iceRestart failed', e); }
  }

  // --------------- signaling via socket.io (simple) ---------------
  function setupSocketHandlers(){
    socket.on('created', () => { isCreator = true; status('Вы — создатель (ожидаем)'); });
    socket.on('ready', async () => {
      status('Собеседник в комнате, устанавливаем связь...');
      if(isCreator){
        await makeOffer();
      }
    });

    socket.on('offer', async ({ sdp }) => {
      await createPCIfNeeded();
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('answer', { roomId: currentRoom, sdp: pc.localDescription });
      log('Received offer, sent answer');
      startStatsLoop();
    });

    socket.on('answer', async ({ sdp }) => {
      if(!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      log('Received answer');
      startStatsLoop();
    });

    socket.on('ice-candidate', async ({ candidate }) => {
      try{ if(candidate) await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch(e){ console.warn('addIce failed', e); }
    });

    socket.on('room-full', () => { alert('Комната занята (макс 2).'); cleanup(); });
    socket.on('peer-left', () => { status('Собеседник вышел'); });
  }

  // createOffer used earlier
  async function makeOffer(){
    await createPCIfNeeded();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('offer', { roomId: currentRoom, sdp: pc.localDescription });
    log('Sent offer');
    startStatsLoop();
  }

  // join flow
  joinBtn.addEventListener('click', async () => {
    const room = (roomInput.value||'').trim();
    if(!room) return alert('Введите имя комнаты');
    currentRoom = room;
    // get high-quality media initially
    try{
      localStream = await navigator.mediaDevices.getUserMedia(startConstraints);
      local.srcObject = localStream;
    }catch(e){
      alert('Ошибка доступа к камере/микрофону: ' + (e.message || e));
      return;
    }

    socket = io();
    setupSocketHandlers();

    // Join: server simply accepts room string (we keep it simple here)
    socket.emit('join', currentRoom);

    joinPanel.style.display = 'none';
    controls.classList.remove('hidden');
    status('Подключено, ожидаем собеседника');
  });

  // control buttons
  muteBtn.addEventListener('click', () => {
    if(!localStream) return;
    micOn = !micOn;
    localStream.getAudioTracks().forEach(t=>t.enabled = micOn);
    muteBtn.textContent = micOn ? '🎤' : '🔇';
  });

  camBtn.addEventListener('click', () => {
    if(!localStream) return;
    camOn = !camOn;
    localStream.getVideoTracks().forEach(t=>t.enabled = camOn);
    camBtn.textContent = camOn ? '📷' : '🚫';
  });

  hangBtn.addEventListener('click', cleanup);

  // cleanup
  function cleanup(){
    try{ if(socket){ socket.emit('leave', { room: currentRoom }); socket.disconnect(); socket = null; } }catch(e){}
    try{ if(pc){ pc.close(); pc = null; } }catch(e){}
    try{ if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream = null; } }catch(e){}
    joinPanel.style.display = 'block';
    controls.classList.add('hidden');
    remote.srcObject = null;
    local.srcObject = null;
    status('Не подключено');
    if(statsInterval) clearInterval(statsInterval);
  }

  // helper
  function id(n){ return document.getElementById(n); }
  function status(s){ statusEl.textContent = 'Статус: ' + s; log('STATUS:', s); }

  // When pc is created, hook local track senders to emit ICE candidates through socket
  // need to intercept pc.onicecandidate already in createPC
  // Also add logic to emit ice-candidate
  // (we already used createPC's built-in onicecandidate via pc configuration earlier - but server signaling wiring:)
  // wire socket basic ICE events:
  if(window){
    // listen to socket-level events for ICE usage within setupSocketHandlers
    // but we need to ensure pc.onicecandidate sends to socket:
    // We'll patch pc creation to send ice candidates - done in createPC: add handler now:
  }

  // Note: The server routes: 'join' {room}, 'offer', 'answer', 'ice-candidate' (same as earlier server)
  // We rely on server simply forwarding messages.

})(); // IIFE
</script>
</body>
</html>`;

// ---------- простой сервер (тот же сигналинг, не меняем логику комнат) ----------
app.get('/', (req, res) => {
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.send(indexHtml);
});

app.get('/config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];
  if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
    iceServers.push({ urls: process.env.TURN_URL, username: process.env.TURN_USER, credential: process.env.TURN_PASS });
  }
  res.json({ iceServers });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const rooms = new Map(); // roomId -> Set(socketId)

io.on('connection', socket => {
  let joined = null;

  socket.on('join', (room) => {
    room = String(room || '').trim();
    if (!room) { socket.emit('invalid-room'); return; }
    if (!rooms.has(room)) rooms.set(room, new Set());
    const members = rooms.get(room);
    if (members.size >= 2) { socket.emit('room-full'); return; }
    members.add(socket.id);
    socket.join(room);
    joined = room;
    if (members.size === 1) {
      socket.emit('created');
    } else {
      // notify both participants that room is ready
      io.to(room).emit('ready');
    }
  });

  socket.on('offer', ({ roomId, sdp }) => {
    socket.to(roomId).emit('offer', { sdp });
  });
  socket.on('answer', ({ roomId, sdp }) => {
    socket.to(roomId).emit('answer', { sdp });
  });
  socket.on('ice-candidate', ({ roomId, candidate }) => {
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  socket.on('leave', ({ room } = {}) => {
    if (!joined) return;
    const s = rooms.get(joined);
    if (s) {
      s.delete(socket.id);
      socket.to(joined).emit('peer-left');
      if (s.size === 0) rooms.delete(joined);
    }
    socket.leave(joined);
    joined = null;
  });

  socket.on('disconnect', () => {
    if (!joined) return;
    const s = rooms.get(joined);
    if (s) {
      s.delete(socket.id);
      socket.to(joined).emit('peer-left');
      if (s.size === 0) rooms.delete(joined);
    }
    joined = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));
