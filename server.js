// server.js
// Один файл: Express + Socket.IO сервер и клиент (встроенный HTML/JS)
// Установка:
//   npm init -y
//   npm install express socket.io cors
// Запуск:
//   node server.js
//
// Поддержка TURN:
//   Если у вас есть TURN, установите в окружении: TURN_URL, TURN_USER, TURN_PASS
//   (например TURN_URL = "turn:your.turn.server:3478")

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// ----------------- Встроенный frontend (HTML+JS) -----------------
const indexHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>WebRTC call — single file</title>
<style>
  :root{--green:#128C7E;--red:#E50914;--bg:#000;}
  html,body{height:100%;margin:0;background:var(--bg);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,Arial;}
  .screen{position:relative;height:100vh;overflow:hidden;}
  #remote{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000;}
  #local{position:absolute;top:16px;right:16px;width:160px;height:120px;border-radius:12px;object-fit:cover;border:3px solid rgba(255,255,255,0.85);z-index:20;}
  header{position:absolute;left:12px;top:12px;color:#fff;z-index:30;background:rgba(0,0,0,0.35);padding:8px 12px;border-radius:10px;}
  .join{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.6);padding:16px;border-radius:12px;min-width:300px;z-index:40;display:flex;flex-direction:column;gap:8px;}
  input{padding:10px;border-radius:8px;border:none;background:rgba(255,255,255,0.04);color:#fff;}
  button.primary{padding:10px;border-radius:8px;border:none;background:#25D366;color:#002;font-weight:700;cursor:pointer;}
  .controls{position:absolute;left:50%;transform:translateX(-50%);bottom:28px;display:flex;gap:12px;z-index:30;}
  .btn{width:64px;height:64px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;font-size:22px;color:white;cursor:pointer;box-shadow:0 8px 22px rgba(0,0,0,.6);}
  .btn.green{background:var(--green);} .btn.red{background:var(--red);}
  .status{position:absolute;left:12px;bottom:12px;color:#ddd;z-index:30;font-size:13px;}
  .log{position:absolute;left:12px;top:72px;color:#ddd;z-index:30;font-size:12px;max-width:360px;white-space:pre-wrap;}
</style>
</head>
<body>
  <div class="screen">
    <video id="remote" autoplay playsinline></video>
    <video id="local" autoplay playsinline muted></video>
    <header id="hdr">Видеозвонок</header>

    <div class="join" id="joinPanel">
      <input id="room" placeholder="Имя комнаты (например: friends)" />
      <input id="turn" placeholder="(опц.) TURN_URL (можно оставить пустым)" />
      <div style="display:flex;gap:8px;">
        <button id="joinBtn" class="primary">Подключиться</button>
        <button id="testBtn">Тест</button>
      </div>
      <div style="font-size:12px;color:#ccc;">Если не устанавливается связь — потребуется TURN (введите TURN_URL или задайте env на сервере).</div>
    </div>

    <div class="controls" id="controls" style="display:none;">
      <button id="muteBtn" class="btn green">🎤</button>
      <button id="camBtn" class="btn green">📷</button>
      <button id="hangBtn" class="btn red">📞</button>
    </div>

    <div class="status" id="status">Статус: не подключено</div>
    <div class="log" id="log"></div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
(async function(){
  const status = (s) => { document.getElementById('status').textContent = 'Статус: ' + s; };
  const logEl = document.getElementById('log');
  const log = (...args) => { logEl.textContent += args.join(' ') + '\\n'; logEl.scrollTop = logEl.scrollHeight; };

  const joinPanel = document.getElementById('joinPanel');
  const joinBtn = document.getElementById('joinBtn');
  const testBtn = document.getElementById('testBtn');
  const roomInput = document.getElementById('room');
  const turnInput = document.getElementById('turn');

  const remoteV = document.getElementById('remote');
  const localV = document.getElementById('local');
  const controls = document.getElementById('controls');
  const muteBtn = document.getElementById('muteBtn');
  const camBtn = document.getElementById('camBtn');
  const hangBtn = document.getElementById('hangBtn');

  let socket = null;
  let pc = null;
  let localStream = null;
  let currentRoom = null;
  let isCreator = false;
  // Queue for remote ICE candidates received before remoteDescription is set
  let remoteCandidatesQueue = [];

  // Default media constraints: balanced (720p@30)
  const mediaConstraints = { audio: true, video: { width:{ideal:1280}, height:{ideal:720}, frameRate:{ideal:30, max:60} } };

  // Fetch config (iceServers) from server; server may include TURN from env
  async function fetchConfig(){
    try {
      const r = await fetch('/config');
      if(r.ok) return await r.json();
    } catch(e){ /* ignore */ }
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  // Create RTCPeerConnection with handlers
  async function createPeerConnection(configIce){
    pc = new RTCPeerConnection({ iceServers: configIce, iceCandidatePoolSize: 2 });
    pc.onicecandidate = (e) => {
      if(e.candidate){
        socket.emit('candidate', { roomId: currentRoom, candidate: e.candidate });
        log('Local ICE candidate -> sent');
      }
    };
    pc.ontrack = (e) => {
      if(!remoteV.srcObject){
        remoteV.srcObject = e.streams[0];
        log('Remote stream attached');
      }
    };
    pc.onconnectionstatechange = () => {
      log('PC state', pc.connectionState);
      status('PC ' + pc.connectionState);
      // if failed -> try to restart ICE (caller can create new offer with iceRestart)
      if(pc.connectionState === 'failed'){
        log('Connection failed — попробуйте перезапустить (ICE restart).');
      }
    };
    // Add local tracks
    if(localStream){
      localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    }
    // when remoteDescription is set later, flush queued candidates
    return pc;
  }

  // Apply any queued remote ICE candidates
  async function flushRemoteCandidates(){
    if(!pc) return;
    if(remoteCandidatesQueue.length === 0) return;
    for(const c of remoteCandidatesQueue){
      try{
        await pc.addIceCandidate(new RTCIceCandidate(c));
        log('Applied queued remote candidate');
      }catch(e){
        console.warn('addIceCandidate error', e);
      }
    }
    remoteCandidatesQueue = [];
  }

  // Handlers for socket events
  function attachSocketHandlers(){
    socket.on('created', () => {
      isCreator = true;
      status('Вы — создатель комнаты (ожидаем другого участника)');
      log('received created');
    });

    socket.on('ready', async () => {
      status('В комнате 2 участника — начинаем сигналинг');
      log('received ready');
      if(isCreator){
        // create offer
        try{
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { roomId: currentRoom, sdp: pc.localDescription });
          log('offer sent');
        }catch(e){ console.error('make offer failed', e); }
      }
    });

    socket.on('offer', async ({ sdp }) => {
      log('received offer');
      try{
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        // flush candidates queued before remote desc
        await flushRemoteCandidates();

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { roomId: currentRoom, sdp: pc.localDescription });
        log('answer sent');
      }catch(e){ console.error('handle offer failed', e); }
    });

    socket.on('answer', async ({ sdp }) => {
      log('received answer');
      try{
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        await flushRemoteCandidates();
      }catch(e){ console.error('handle answer failed', e); }
    });

    // candidates forwarded by server
    socket.on('candidate', async ({ candidate }) => {
      log('received remote candidate');
      try{
        // if remoteDescription not set yet - queue
        if(!pc || !pc.remoteDescription || pc.remoteDescription.type === null){
          remoteCandidatesQueue.push(candidate);
          log('queued remote candidate (remoteDescription not set yet)');
        } else {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
          log('added remote candidate');
        }
      }catch(e){
        console.warn('addIceCandidate error', e);
      }
    });

    socket.on('peer-left', () => {
      status('Собеседник вышел');
      log('peer-left');
      // cleanup remote stream
      if(remoteV.srcObject){ remoteV.srcObject = null; }
    });

    socket.on('room-full', () => { alert('Комната заполнена (макс 2 участника)'); cleanup(); });
    socket.on('invalid-room', () => { alert('Неверное имя комнаты'); cleanup(); });
  }

  // Start/join flow
  joinBtn.addEventListener('click', async () => {
    const room = (roomInput.value || '').trim();
    if(!room) return alert('Введите имя комнаты');
    currentRoom = room;
    // get local media (constrained for quality but not extreme)
    try{
      localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
      localV.srcObject = localStream;
    }catch(e){
      alert('Ошибка доступа к камере/микрофону: ' + (e.message || e));
      return;
    }

    // fetch ice config from server; if user provided TURN URL in the field - tell server to include it by calling /config?turn=...
    let config = await fetchConfig();
    // If user typed a TURN URL into input we try to use it as an extra candidate (note: server must have env TURN to actually use credentials)
    // (This input is informational; primary recommendation is to set TURN on server via env variables.)
    log('Using ICE servers:', JSON.stringify(config.iceServers));

    socket = io();
    attachSocketHandlers();

    // create pc with ICE servers
    pc = await createPeerConnection(config.iceServers);

    // join room
    socket.emit('join', currentRoom);
    status('Подключено к сигналингу, ожидаем...');
    joinPanel.style.display = 'none';
    controls.style.display = 'flex';
  });

  // Manual test button: check if browser can get local candidates + basic operations
  testBtn.addEventListener('click', async () => {
    log('Running quick test: enumerating devices and creating local stream...');
    try{
      const s = await navigator.mediaDevices.getUserMedia({ audio:true, video:true });
      log('Got media tracks:', s.getTracks().map(t => t.kind + '/' + t.readyState).join(', '));
      s.getTracks().forEach(t => t.stop());
      alert('Камера и микрофон доступны');
    }catch(e){
      alert('Ошибка доступа: ' + (e.message || e));
    }
  });

  // control buttons
  muteBtn.addEventListener('click', () => {
    if(!localStream) return;
    const enabled = !localStream.getAudioTracks()[0].enabled;
    localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    muteBtn.textContent = enabled ? '🎤' : '🔇';
  });
  camBtn.addEventListener('click', () => {
    if(!localStream) return;
    const enabled = !localStream.getVideoTracks()[0].enabled;
    localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    camBtn.textContent = enabled ? '📷' : '🚫';
  });
  hangBtn.addEventListener('click', cleanup);

  // cleanup function
  function cleanup(){
    try{ if(socket){ socket.emit('leave', { room: currentRoom }); socket.disconnect(); socket = null; } }catch(e){}
    try{ if(pc){ pc.close(); pc = null; } }catch(e){}
    try{ if(localStream){ localStream.getTracks().forEach(t => t.stop()); localStream = null; } }catch(e){}
    remoteV.srcObject = null; localV.srcObject = null;
    joinPanel.style.display = 'block';
    controls.style.display = 'none';
    status('Отключено');
    remoteCandidatesQueue = [];
    log('Cleaned up');
  }

  // ensure cleanup on unload
  window.addEventListener('beforeunload', cleanup);

  // small helper to fetch config (calls server /config)
  async function fetchConfig(){
    try{
      // if user provided turn URL in field, we still rely on server env. The safest is to set TURN variables on server.
      const resp = await fetch('/config');
      if(resp.ok) return await resp.json();
    }catch(e){}
    return { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  }

  // initial UI text
  status('Готово');
})(); // IIFE
</script>
</body>
</html>
`;

// ----------------- Сервер: конфиг ICE и простая логика комнат -----------------
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml);
});

// отдаём iceServers (добавляем TURN если заданы env переменные)
app.get('/config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  // If TURN env variables are present, add TURN
  if (process.env.TURN_URL && process.env.TURN_USER && process.env.TURN_PASS) {
    iceServers.push({
      urls: process.env.TURN_URL, // e.g. "turn:turn.example.com:3478"
      username: process.env.TURN_USER,
      credential: process.env.TURN_PASS
    });
  }

  res.json({ iceServers });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// rooms: Map roomId -> Set(socketId)
const rooms = new Map();

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', (room) => {
    room = String(room || '').trim();
    if (!room) { socket.emit('invalid-room'); return; }

    if (!rooms.has(room)) rooms.set(room, new Set());
    const members = rooms.get(room);

    if (members.size >= 2) {
      socket.emit('room-full');
      return;
    }

    members.add(socket.id);
    socket.join(room);
    joinedRoom = room;

    if (members.size === 1) {
      socket.emit('created');
    } else if (members.size === 2) {
      // notify both participants
      io.to(room).emit('ready');
    }
    console.log('Room', room, 'members', Array.from(members));
  });

  // offer/answer/candidate forwarding
  socket.on('offer', ({ roomId, sdp }) => {
    if (!roomId) return;
    socket.to(roomId).emit('offer', { sdp });
  });
  socket.on('answer', ({ roomId, sdp }) => {
    if (!roomId) return;
    socket.to(roomId).emit('answer', { sdp });
  });
  socket.on('candidate', ({ roomId, candidate }) => {
    if (!roomId) return;
    socket.to(roomId).emit('candidate', { candidate });
  });

  socket.on('leave', ({ room } = {}) => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (r) {
      r.delete(socket.id);
      socket.to(joinedRoom).emit('peer-left');
      if (r.size === 0) rooms.delete(joinedRoom);
    }
    socket.leave(joinedRoom);
    joinedRoom = null;
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const r = rooms.get(joinedRoom);
    if (r) {
      r.delete(socket.id);
      socket.to(joinedRoom).emit('peer-left');
      if (r.size === 0) rooms.delete(joinedRoom);
    }
    joinedRoom = null;
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('✅ Server listening on port', PORT));
