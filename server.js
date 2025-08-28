// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();

const indexHtml = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>WhatsApp Call</title>
  <style>
    body,html { margin:0; padding:0; height:100%; background:#000; font-family:sans-serif; }
    .call-screen { position:relative; width:100%; height:100%; overflow:hidden; }
    #remoteVideo { width:100%; height:100%; object-fit:cover; background:#000; }
    #localVideo { position:absolute; top:20px; right:20px; width:120px; height:120px; border-radius:50%; object-fit:cover; background:#222; border:3px solid white; }
    header { position:absolute; top:0; left:0; right:0; height:60px; background:rgba(0,0,0,0.4); display:flex; align-items:center; padding:0 16px; color:white; font-size:18px; }
    .controls { position:absolute; bottom:40px; left:0; right:0; display:flex; justify-content:center; gap:30px; }
    button { width:70px; height:70px; border-radius:50%; border:none; cursor:pointer; font-size:26px; color:white; display:flex; align-items:center; justify-content:center; }
    .btn-mic, .btn-cam { background:#128C7E; }
    .btn-end { background:#E50914; }
    .join-panel { position:absolute; top:50%; left:50%; transform:translate(-50%,-50%); background:rgba(0,0,0,0.7); padding:20px; border-radius:12px; display:flex; flex-direction:column; gap:10px; }
    .join-panel input, .join-panel button { padding:10px; border-radius:8px; border:none; font-size:16px; }
    .join-panel input { text-align:center; }
    .join-panel button { background:#25D366; color:white; font-weight:bold; cursor:pointer; }
  </style>
</head>
<body>
  <div class="call-screen">
    <video id="remoteVideo" autoplay playsinline></video>
    <video id="localVideo" autoplay playsinline muted></video>
    <header id="header">Звонок</header>
    <div class="controls">
      <button id="btnMic" class="btn-mic">🎤</button>
      <button id="btnCam" class="btn-cam">📷</button>
      <button id="btnEnd" class="btn-end">📞</button>
    </div>
    <div class="join-panel" id="joinPanel">
      <input id="room" placeholder="Имя комнаты"/>
      <button id="connect">Подключиться</button>
    </div>
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
    const joinPanel=document.getElementById("joinPanel");

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
      currentRoom=(roomInput.value||"").trim();
      if(!currentRoom) return alert("Введите имя комнаты");
      localStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
      localVideo.srcObject=localStream;
      joinPanel.style.display="none";

      socket=io();
      socket.on("connect",()=>socket.emit("join",currentRoom));
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
    }

    function hangup(){
      if(pc){ pc.close(); pc=null; }
      if(localStream){ localStream.getTracks().forEach(t=>t.stop()); }
      if(socket){ socket.emit("leave"); socket.disconnect(); }
      remoteVideo.srcObject=null; localVideo.srcObject=null;
      joinPanel.style.display="flex";
    }

    btnConnect.onclick=start;
    btnEnd.onclick=hangup;
    btnMic.onclick=()=>{ micEnabled=!micEnabled; localStream.getAudioTracks().forEach(t=>t.enabled=micEnabled); btnMic.textContent=micEnabled?"🎤":"🔇"; };
    btnCam.onclick=()=>{ camEnabled=!camEnabled; localStream.getVideoTracks().forEach(t=>t.enabled=camEnabled); btnCam.textContent=camEnabled?"📷":"🚫"; };
  </script>
</body>
</html>`;

app.get("/", (req,res)=>res.send(indexHtml));

const server = http.createServer(app);
const io = new Server(server);

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
