// server.js
// ОДИН файл: Express + Socket.IO сервер и встроенный фронтенд (WebRTC сигналинг).
// Требования: Node.js >= 18
//
// Установка:
//   npm init -y
//   npm install express socket.io cors
// Запуск:
//   node server.js
//
// Переменные окружения:
//  - PORT (по умолчанию 3000)
//  - TURN_URL, TURN_USER, TURN_PASS (опционально, для TURN — добавится в iceServers если заданы)

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

// Отдаём единственную страницу — весь фронтенд встроен в строку ниже
const indexHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Звонок другу — WebRTC (один файл)</title>
  <style>
    body { font-family: Inter, system-ui, -apple-system, Roboto, sans-serif; margin:0; background:#0b1220; color:#e6edf3; }
    .wrap{max-width:960px;margin:20px auto;padding:20px;}
    .card{background:#071126;padding:16px;border-radius:12px;border:1px solid #123;}
    .controls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
    input,button,label{padding:8px;border-radius:8px;border:1px solid #234;background:#071126;color:#e6edf3;}
    button.primary{background:#2563eb;border-color:#2563eb;}
    video{width:100%;background:#000;border-radius:8px;}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
    .log{height:120px;overflow:auto;background:#051025;border-radius:8px;padding:8px;font-size:13px;border:1px solid #122;}
    .hint{color:#9ca3af;font-size:13px;}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Звонок другу — WebRTC (один файл)</h1>
    <div class="card">
      <div class="controls">
        <input id="room" placeholder="Имя комнаты (например: friends)" />
        <button id="connect" class="primary">Подключиться</button>
        <button id="hangup">Завершить</button>
        <label style="align-items:center;display:flex;gap:6px;"><input type="checkbox" id="shareScreen"> Делиться экраном</label>
      </div>
      <div class="hint">Оба участника должны зайти в одну и ту же комнату и нажать «Подключиться».</div>

      <div class="grid" style="margin-top:12px;">
        <div>
          <div class="hint">Вы</div>
          <video id="localVideo" autoplay playsinline muted></video>
        </div>
        <div>
          <div class="hint">Друг</div>
          <video id="remoteVideo" autoplay playsinline></video>
        </div>
      </div>

      <div style="margin-top:12px;" class="log" id="log"></div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
  (function(){
    const logEl = document.getElementById('log');
    const log = (...a) => { logEl.textContent += a.join(' ') + '\\n'; logEl.scrollTop = logEl.scrollHeight; };

    const roomInput = document.getElementById('room');
    const btnConnect = document.getElementById('connect');
    const btnHangup = document.getElementById('hangup');
    const chkShare = document.getElementById('shareScreen');

    const localVideo = document.getElementById('localVideo');
    const remoteVideo = document.getElementById('remoteVideo');

    let socket = null;
    let pc = null;
    let localStream = null;
    let currentRoom = null;
    let isCaller = false;

    // iceServers — сервер присылает через /config (опционально)
    let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

    async function fetchConfig() {
      try {
        const res = await fetch('/config');
        if (res.ok) {
          const cfg = await res.json();
          if (cfg && cfg.iceServers) iceServers = cfg.iceServers;
          log('Конфиг загружен (iceServers).');
        }
      } catch (e) {
        log('Не удалось получить /config — используем дефолт STUN.');
      }
    }

    function createPeerConnection() {
      pc = new RTCPeerConnection({ iceServers });

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          socket.emit('ice-candidate', { roomId: currentRoom, candidate: e.candidate });
        }
      };

      pc.ontrack = (e) => {
        if (!remoteVideo.srcObject) {
          remoteVideo.srcObject = e.streams[0];
          log('Remote stream attached.');
        }
      };

      pc.onconnectionstatechange = () => {
        log('PC state:', pc.connectionState);
      };

      // attach local tracks
      if (localStream) {
        localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
      }
    }

    async function getMedia(useScreen=false) {
      if (useScreen) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:true }).catch(e=>{ throw e; });
        // попытка добавить микрофон, если системное аудио отсутствует
        if (screenStream.getAudioTracks().length === 0) {
          try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio:true });
            screenStream.addTrack(mic.getAudioTracks()[0]);
          } catch (e) {/* игнор */ }
        }
        return screenStream;
      }
      return navigator.mediaDevices.getUserMedia({ video:true, audio:true });
    }

    async function start() {
      currentRoom = (roomInput.value || '').trim();
      if (!currentRoom) { alert('Введите имя комнаты'); return; }

      btnConnect.disabled = true;
      btnHangup.disabled = false;

      await fetchConfig();

      try {
        localStream = await getMedia(chkShare.checked);
      } catch (e) {
        alert('Ошибка доступа к микрофону/камере: ' + (e && e.message));
        btnConnect.disabled = false;
        btnHangup.disabled = true;
        return;
      }

      localVideo.srcObject = localStream;

      socket = io();

      socket.on('connect', () => {
        log('Socket connected:', socket.id);
        socket.emit('join', currentRoom);
      });

      socket.on('created', () => {
        log('Вы — первый в комнате (created).');
        isCaller = true;
      });

      socket.on('ready', async () => {
        log('В комнате 2 участника (ready).');
        if (!pc) createPeerConnection();
        if (isCaller) {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.emit('offer', { roomId: currentRoom, sdp: offer });
          log('Отправили offer.');
        }
      });

      socket.on('offer', async ({ sdp }) => {
        log('Получили offer.');
        if (!pc) createPeerConnection();
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('answer', { roomId: currentRoom, sdp: answer });
        log('Отправили answer.');
      });

      socket.on('answer', async ({ sdp }) => {
        log('Получили answer.');
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      });

      socket.on('ice-candidate', async ({ candidate }) => {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('addIce failed', e);
        }
      });

      socket.on('room-full', () => {
        alert('Комната заполнена (максимум 2 участника).');
        cleanup();
      });

      socket.on('peer-left', () => {
        log('Собеседник вышел.');
        endCallButKeepLocal();
      });

      socket.on('disconnect', () => {
        log('Socket disconnected.');
      });
    }

    function endCallButKeepLocal() {
      if (pc) {
        try { pc.getSenders().forEach(s => { if (s.track) s.track.stop?.(); }); } catch(e){}
        pc.close();
        pc = null;
      }
      remoteVideo.srcObject = null;
    }

    function cleanup() {
      if (socket) {
        socket.emit('leave');
        socket.disconnect();
        socket = null;
      }
      if (pc) {
        try { pc.getSenders().forEach(s => { if (s.track) s.track.stop?.(); }); } catch(e){}
        pc.close(); pc = null;
      }
      if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
      }
      localVideo.srcObject = null;
      remoteVideo.srcObject = null;
      btnConnect.disabled = false;
      btnHangup.disabled = true;
      isCaller = false;
      currentRoom = null;
    }

    btnConnect.addEventListener('click', start);
    btnHangup.addEventListener('click', cleanup);
    window.addEventListener('beforeunload', cleanup);
  })();
  </script>
</body>
</html>
`;

// Отдаём конфигурацию (iceServers) — можно задать TURN через env,
// например: TURN_URL=turn:1.2.3.4:3478 TURN_USER=user TURN_PASS=pass
app.get('/config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USER;
  const turnPass = process.env.TURN_PASS;
  if (turnUrl && turnUser && turnPass) {
    iceServers.push({ urls: turnUrl, username: turnUser, credential: turnPass });
  }

  res.json({ iceServers });
});

// Отдаём страницу
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(indexHtml);
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' }
});

// Простая логика комнат: max 2 участника
const rooms = new Map(); // roomId -> Set(socketId)

io.on('connection', (socket) => {
  let joinedRoom = null;

  socket.on('join', (roomId) => {
    roomId = String(roomId || '').trim();
    if (!roomId) {
      socket.emit('error', 'empty-room');
      return;
    }

    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    const members = rooms.get(roomId);

    if (members.size >= 2) {
      socket.emit('room-full');
      return;
    }

    members.add(socket.id);
    socket.join(roomId);
    joinedRoom = roomId;

    // уведомления
    if (members.size === 1) {
      socket.emit('created');
    } else if (members.size === 2) {
      io.to(roomId).emit('ready');
    }
  });

  socket.on('offer', ({ roomId, sdp }) => {
    if (!roomId) return;
    socket.to(roomId).emit('offer', { sdp });
  });

  socket.on('answer', ({ roomId, sdp }) => {
    if (!roomId) return;
    socket.to(roomId).emit('answer', { sdp });
  });

  socket.on('ice-candidate', ({ roomId, candidate }) => {
    if (!roomId) return;
    socket.to(roomId).emit('ice-candidate', { candidate });
  });

  socket.on('leave', () => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit('peer-left');
    socket.leave(joinedRoom);
    const members = rooms.get(joinedRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(joinedRoom);
    }
    joinedRoom = null;
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    socket.to(joinedRoom).emit('peer-left');
    const members = rooms.get(joinedRoom);
    if (members) {
      members.delete(socket.id);
      if (members.size === 0) rooms.delete(joinedRoom);
    }
    joinedRoom = null;
  });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log('✅ Сервер запущен на порту', PORT);
  console.log('Открой в браузере: http://localhost:' + PORT);
});
