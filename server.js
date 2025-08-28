// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

// HTML + JS клиент
const indexHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>WebRTC Call</title>
<style>
body,html{margin:0;padding:0;height:100%;background:#000;font-family:sans-serif;}
.screen{position:relative;width:100%;height:100%;}
#remoteVideo{width:100%;height:100%;object-fit:cover;background:#000;}
#localVideo{position:absolute;top:20px;right:20px;width:120px;height:120px;border-radius:12px;object-fit:cover;border:2px solid #fff;}
.join-panel{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.7);padding:20px;border-radius:12px;display:flex;flex-direction:column;gap:10px;}
.join-panel input, .join-panel button{padding:10px;border-radius:8px;border:none;font-size:16px;}
.join-panel input{text-align:center;}
.join-panel button{background:#25D366;color:white;font-weight:bold;cursor:pointer;}
.controls{position:absolute;bottom:20px;left:50%;transform:translateX(-50%);display:flex;gap:10px;}
.btn{width:50px;height:50px;border-radius:50%;border:none;color:#fff;font-size:20px;cursor:pointer;}
.btn.green{background:#128C7E;}
.btn.red{background:#E50914;}
</style>
</head>
<body>
<div class="screen">
<video id="remoteVideo" autoplay playsinline></video>
<video id="localVideo" autoplay playsinline muted></video>

<div class="join-panel" id="joinPanel">
  <input id="room" placeholder="Имя комнаты"/>
  <input id="password" placeholder="Пароль (опционально)"/>
  <button id="connect">Подключиться</button>
</div>

<div class="controls" id="controls" style="display:none;">
  <button id="muteBtn" class="btn green">🎤</button>
  <button id="camBtn" class="btn green">📷</button>
  <button id="hangBtn" class="btn red">📞</button>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const roomInput=document.getElementById("room");
const passInput=document.getElementById("password");
const btnConnect=document.getElementById("connect");
const localVideo=document.getElementById("localVideo");
const remoteVideo=document.getElementById("remoteVideo");
const joinPanel=document.getElementById("joinPanel");
const controls=document.getElementById("controls");
const muteBtn=document.getElementById("muteBtn");
const camBtn=document.getElementById("camBtn");
const hangBtn=document.getElementById("hangBtn");

let socket, pc, localStream, currentRoom, isCaller;
const iceServers=[{urls:"stun:stun.l.google.com:19302"}];

// Инициализация PeerConnection
function createPeer(){
  pc=new RTCPeerConnection({iceServers});
  pc.onicecandidate=e=>{ if(e.candidate) socket.emit("ice-candidate",{roomId:currentRoom,candidate:e.candidate}); };
  pc.ontrack=e=>{ remoteVideo.srcObject=e.streams[0]; };
  localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
}

// Начало звонка
async function start(){
  currentRoom=(roomInput.value||"").trim();
  if(!currentRoom) return alert("Введите имя комнаты");
  localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  localVideo.srcObject=localStream;
  joinPanel.style.display="none";

  socket=io();
  socket.on("connect",()=>socket.emit("join",{room:currentRoom,password:passInput.value}));
  socket.on("created",()=>{isCaller=true;});
  socket.on("ready",async()=>{
    if(!pc) createPeer();
    if(isCaller){
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit("offer",{roomId:currentRoom,sdp:offer});
    }
  });
  socket.on("offer",async({sdp})=>{
    if(!pc) createPeer();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer=await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit("answer",{roomId:currentRoom,sdp:answer});
  });
  socket.on("answer",async({sdp})=>{
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  });
  socket.on("ice-candidate",async({candidate})=>{
    try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch{}
  });
  socket.on("peer-left",()=>{ remoteVideo.srcObject=null; });
  socket.on("wrong-password",()=>{ alert("Неверный пароль!"); joinPanel.style.display="flex"; });
  socket.on("room-full",()=>{ alert("Комната заполнена!"); joinPanel.style.display="flex"; });
  
  controls.style.display="flex";
}

// Кнопки управления
muteBtn.onclick=()=>{
  const track=localStream.getAudioTracks()[0];
  track.enabled=!track.enabled;
  muteBtn.textContent=track.enabled?"🎤":"🔇";
};
camBtn.onclick=()=>{
  const track=localStream.getVideoTracks()[0];
  track.enabled=!track.enabled;
  camBtn.textContent=track.enabled?"📷":"🚫";
};
hangBtn.onclick=()=>{
  if(socket) socket.emit("leave",{room:currentRoom});
  if(pc){ pc.close(); pc=null; }
  if(localStream){ localStream.getTracks().forEach(t=>t.stop()); localStream=null; }
  remoteVideo.srcObject=null; localVideo.srcObject=null;
  joinPanel.style.display="flex"; controls.style.display="none";
};

btnConnect.onclick=start;
</script>
</div>
</body>
</html>`;

// ----------------- Сервер -----------------
app.get("/", (req,res)=>res.send(indexHtml));

const server=http.createServer(app);
const io=new Server(server);

// Map room -> {password, members:Set}
const rooms=new Map();

io.on("connection",socket=>{
  let joined=null;
  socket.on("join",({room,password})=>{
    if(!rooms.has(room)) rooms.set(room,{password,password||"",members:new Set()});
    const r=rooms.get(room);

    // Проверка пароля
    if(r.members.size>0 && password!==r.password){
      socket.emit("wrong-password");
      return;
    }

    if(r.members.size>=2){ socket.emit("room-full"); return; }

    r.members.add(socket.id);
    socket.join(room);
    joined=room;
    if(r.members.size===1) socket.emit("created");
    else io.to(room).emit("ready");
  });

  socket.on("offer",({roomId,sdp})=>socket.to(roomId).emit("offer",{sdp}));
  socket.on("answer",({roomId,sdp})=>socket.to(roomId).emit("answer",{sdp}));
  socket.on("ice-candidate",({roomId,candidate})=>socket.to(roomId).emit("ice-candidate",{candidate}));

  function leaveRoom(){
    if(joined){
      const r=rooms.get(joined);
      if(r){
        r.members.delete(socket.id);
        socket.to(joined).emit("peer-left");
        if(r.members.size===0) rooms.delete(joined);
      }
      joined=null;
    }
  }

  socket.on("leave",leaveRoom);
  socket.on("disconnect",leaveRoom);
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("Server running on port",PORT));
