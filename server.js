// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const indexHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WhatsApp-style Call</title>
  <style>
    body { margin:0; font-family:sans-serif; background:#075E54; color:white; height:100vh; display:flex; flex-direction:column; }
    header { background:#128C7E; padding:12px; text-align:center; font-weight:bold; }
    main { flex:1; display:flex; align-items:center; justify-content:center; gap:20px; padding:20px; }
    video { width:200px; height:200px; border-radius:50%; object-fit:cover; background:black; }
    .controls { background:rgba(0,0,0,0.3); padding:12px; display:flex; justify-content:center; gap:20px; }
    button { width:60px; height:60px; border-radius:50%; border:none; cursor:pointer; font-size:20px; color:white; display:flex; align-items:center; justify-content:center; }
    .btn-mic { background:#128C7E; }
    .btn-cam { background:#128C7E; }
    .btn-end { background:#E50914; }
    input { margin:8px auto; padding:6px; border-radius:6px; border:none; display:block; text-align:center; }
    #connect { margin:6px auto; padding:8px 12px; border-radius:6px; border:none; background:#25D366; color:white; font-weight:bold; cursor:pointer; }
  </style>
</head>
<body>
  <header>Видеозвонок</header>
  <input id="room" placeholder="Имя комнаты"/>
  <button id="connect">Подключиться</button>
  <main>
    <video id="localVideo" autoplay playsinline muted></video>
    <video id="remoteVideo" autoplay playsinline></video>
  </main>
  <div class="controls">
    <button id="btnMic" class="btn-mic">🎤</button>
    <button id="btnCam" class="btn-cam">📷</button>
    <button id="btnEnd" class="btn-end">📞</button>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
  const roomInput=document.getElementById("room");
  const btnConnect=document.getElementById("connect");
  const btnEnd=document.getElementById("btnEnd");
  const btnMic=document.getElementById("btnMic");
  const btnCam=document.getElementById("btnCam");
  const localVideo=document.getElementById("localVideo");
  const remoteVideo=document.getElementById("remoteVideo");

  let socket,pc,localStream,currentRoom,isCaller;
  let micEnabled=true, camEnabled=true;

  const iceServers=[{urls:"stun:stun.l.google.com:19302"}];

  function createPeer(){
    pc=new RTCPeerConnection({iceServers});
    pc.onicecandidate=e=>{ if(e.candidate) socket.emit("ice-candidate",{roomId:currentRoom,candidate:e.candidate}); };
    pc.ontrack=e=>{ if(!remoteVideo.srcObject) remoteVideo.srcObject=e.streams[0]; };
    localStream.getTracks().forEach(t=>pc.addTrack(t,localStream));
  }

  async function start(){
    currentRoom=(roomInput.value||"").trim(); if(!currentRoom) return alert("Введите имя комнаты");
    localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
    localVideo.srcObject=localStream;
    socket=io();
    socket.on("connect",()=>socket.emit("join",currentRoom));
    socket.on("created",()=>{isCaller=true;});
    socket.on("ready",async()=>{
      if(!pc) createPeer();
      if(isCaller){ const offer=await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit("offer",{roomId:currentRoom,sdp:offer}); }
    });
    socket.on("offer",async({sdp})=>{
      if(!pc) createPeer();
      await pc.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer=await pc.createAnswer(); await pc.setLocalDescription(answer);
      socket.emit("answer",{roomId:currentRoom,sdp:answer});
    });
    socket.on("answer",async({sdp})=>{ await pc.setRemoteDescription(new RTCSessionDescription(sdp)); });
    socket.on("ice-candidate",async({candidate})=>{ try{ await pc.addIceCandidate(new RTCIceCandidate(candidate)); }catch{} });
    socket.on("peer-left",()=>{ remoteVideo.srcObject=null; });
  }

  function hangup(){
    if(pc){ pc.close(); pc=null; }
    if(localStream){ localStream.getTracks().forEach(t=>t.stop()); }
    if(socket){ socket.emit("leave"); socket.disconnect(); }
    remoteVideo.srcObject=null; localVideo.srcObject=null;
  }

  btnConnect.onclick=start;
  btnEnd.onclick=hangup;
  btnMic.onclick=()=>{ micEnabled=!micEnabled; localStream.getAudioTracks().forEach(t=>t.enabled=micEnabled); btnMic.textContent=micEnabled?"🎤":"🔇"; };
  btnCam.onclick=()=>{ camEnabled=!camEnabled; localStream.getVideoTracks().forEach(t=>t.enabled=camEnabled); btnCam.textContent=camEnabled?"📷":"🚫"; };
  </script>
</body>
</html>`;

app.get("/",(req,res)=>res.send(indexHtml));

const server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*"}});
const rooms=new Map();

io.on("connection",socket=>{
  let joined=null;
  socket.on("join",room=>{
    if(!rooms.has(room)) rooms.set(room,new Set());
    const members=rooms.get(room);
    if(members.size>=2){ socket.emit("room-full"); return; }
    members.add(socket.id); socket.join(room); joined=room;
    if(members.size===1) socket.emit("created");
    else io.to(room).emit("ready");
  });
  socket.on("offer",({roomId,sdp})=>socket.to(roomId).emit("offer",{sdp}));
  socket.on("answer",({roomId,sdp})=>socket.to(roomId).emit("answer",{sdp}));
  socket.on("ice-candidate",({roomId,candidate})=>socket.to(roomId).emit("ice-candidate",{candidate}));
  socket.on("leave",()=>{ if(joined){ socket.to(joined).emit("peer-left"); rooms.get(joined)?.delete(socket.id); if(rooms.get(joined)?.size===0) rooms.delete(joined); } });
  socket.on("disconnect",()=>{ if(joined){ socket.to(joined).emit("peer-left"); rooms.get(joined)?.delete(socket.id); if(rooms.get(joined)?.size===0) rooms.delete(joined); } });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log("Server running on port",PORT));
