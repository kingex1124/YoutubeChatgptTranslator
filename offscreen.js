const DB_NAME='yt-recorder-v1', STORE='recordings';
let active=null;
const incomingOverlays=new Map();
const urls=new Map();
function openDb() {
  return new Promise((resolve,reject)=>{
    const r=indexedDB.open(DB_NAME,1);
    r.onupgradeneeded=()=>r.result.createObjectStore(STORE,{keyPath:'id'});
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  });
}
async function transaction(mode,fn) {
  const db=await openDb();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,mode),store=tx.objectStore(STORE);
    let request;
    try {request=fn(store);} catch(e) {db.close();reject(e);return;}
    tx.oncomplete=()=>{db.close();resolve(request?.result);};
    tx.onerror=()=>{db.close();reject(tx.error);};
    tx.onabort=()=>{db.close();reject(tx.error||new Error('Database aborted'));};
  });
}
const getRecord=id=>transaction('readonly',s=>s.get(id));
const base64 = buffer => {
  const arr = new Uint8Array(buffer);
  let text='';
  for(let i=0;i<arr.length;i+=0x8000) text+=String.fromCharCode(...arr.subarray(i,i+0x8000));
  return btoa(text);
};
function safeFilename(input) {
  const title=(input||'YouTube錄音').replace(/\s*[-–—]\s*YouTube\s*$/i,'').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').trim().slice(0,100)||'YouTube錄音';
  const d=new Date();const stamp=[d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('')+'_'+[d.getHours(),d.getMinutes(),d.getSeconds()].map(x=>String(x).padStart(2,'0')).join('');
  return `${title}_${stamp}.webm`;
}
async function start(m) {
  if(active) throw new Error('已有錄音正在進行');
  const stream=await navigator.mediaDevices.getUserMedia({audio:{mandatory:{chromeMediaSource:'tab',chromeMediaSourceId:m.streamId}},video:false});
  const audio=new AudioContext();
  const source=audio.createMediaStreamSource(stream);
  const analyser=audio.createAnalyser();analyser.fftSize=1024;
  source.connect(analyser);
  const samples=new Uint8Array(analyser.fftSize);
  const meterTimer=setInterval(()=>{try{analyser.getByteTimeDomainData(samples);let total=0;for(const x of samples)total+=((x-128)/128)**2;const level=Math.min(1,Math.sqrt(total/samples.length)*4);chrome.runtime.sendMessage({type:'METER',level}).catch(()=>{});}catch{}},1000);
  source.connect(audio.destination); // 擷取後分頁聲音須回送給使用者
  const mime=['audio/webm;codecs=opus','audio/webm'].find(x=>MediaRecorder.isTypeSupported(x));
  if(!mime) {stream.getTracks().forEach(t=>t.stop());await audio.close();throw new Error('瀏覽器不支援 WebM 音訊錄製');}
  const recorder=new MediaRecorder(stream,{mimeType:mime,audioBitsPerSecond:96000});
  const entry={stream,audio,recorder,chunks:[],title:m.title, tabId:m.tabId,finished:false,meterTimer};
  active=entry;
  recorder.ondataavailable=e=>{if(e.data?.size)entry.chunks.push(e.data);};
  recorder.onerror=e=>{chrome.runtime.sendMessage({type:'RECORDING_ERROR',error:e.error?.message||'MediaRecorder error'}).catch(()=>{});};
  recorder.onstop=()=>finish(entry).catch(e=>chrome.runtime.sendMessage({type:'RECORDING_ERROR',error:e.message}).catch(()=>{}));
  stream.getAudioTracks()[0].onended=()=>{if(recorder.state!=='inactive')recorder.stop();};
  recorder.start(1000);
  return {ok:true};
}
async function finish(entry) {
  if(entry.finished)return;
  entry.finished=true;
  const blob=new Blob(entry.chunks,{type:entry.recorder.mimeType||'audio/webm'});
  clearInterval(entry.meterTimer);entry.stream.getTracks().forEach(t=>t.stop());
  try {await entry.audio.close();} catch {}
  if(active===entry)active=null;
  if(blob.size===0)throw new Error('錄音內容是空的；請確認 YouTube 影片有播放聲音。');
  const id=crypto.randomUUID(),filename=safeFilename(entry.title);
  await transaction('readwrite',s=>s.put({id,filename,blob,bytes:blob.size,createdAt:Date.now(),mime:blob.type}));
  const blobUrl=URL.createObjectURL(blob);
  urls.set(id,blobUrl);
  await chrome.runtime.sendMessage({type:'RECORDING_SAVED',id,filename,bytes:blob.size,blobUrl});
}
async function stop() {
  if(!active)throw new Error('目前沒有錄音');
  if(active.recorder.state==='inactive')return {ok:true};
  active.recorder.stop();return {ok:true};
}
chrome.runtime.onMessage.addListener((m,sender,reply)=>{
  if(m.to!=='offscreen')return false;
  (async()=>{
    switch(m.type) {
      case 'OVERLAY_BEGIN': {if(incomingOverlays.has(m.session))return {ok:false,error:'重複的傳輸'};incomingOverlays.set(m.session,{parts:[],bytes:0,title:m.title});return {ok:true};}
      case 'OVERLAY_CHUNK': {const e=incomingOverlays.get(m.session);if(!e)return {ok:false,error:'錄音接收工作不存在'};const b=atob(m.data);const chunk=new Uint8Array(b.length);for(let i=0;i<b.length;i++)chunk[i]=b.charCodeAt(i);e.parts.push(chunk);e.bytes+=chunk.byteLength;return {ok:true};}
      case 'OVERLAY_FINISH': {const e=incomingOverlays.get(m.session);if(!e)return {ok:false,error:'錄音接收工作不存在'};incomingOverlays.delete(m.session);const blob=new Blob(e.parts,{type:'audio/webm'});if(!blob.size)throw Error('錄音音檔為空');const id=crypto.randomUUID(),filename=safeFilename(e.title);await transaction('readwrite',s=>s.put({id,filename,blob,bytes:blob.size,createdAt:Date.now(),mime:blob.type}));await chrome.runtime.sendMessage({type:'RECORDING_SAVED',id,filename,bytes:blob.size});return {ok:true};}
      case 'OVERLAY_ABORT': incomingOverlays.delete(m.session);return {ok:true};
      case 'START':return await start(m);
      case 'STOP':return await stop();
      case 'LIST': {
        const result=await transaction('readonly',s=>s.getAll());
        return {ok:true,items:result.map(({id,filename,bytes,createdAt})=>({id,filename,bytes,createdAt})).sort((a,b)=>b.createdAt-a.createdAt)};
      }
      case 'GET_INFO': {
        const r=await getRecord(m.id);return r?{ok:true,filename:r.filename,bytes:r.bytes,mime:r.mime}:{ok:false,error:'找不到錄音'};
      }
      case 'CHUNK': {
        const r=await getRecord(m.id);if(!r)return {ok:false,error:'找不到錄音檔案'};
        const offset=Number(m.offset)||0, limit=Math.min(Number(m.length)||524288,524288);
        if(offset<0||offset>r.bytes)return {ok:false,error:'Invalid offset'};
        const buf=await r.blob.slice(offset,offset+limit).arrayBuffer();
        return {ok:true,data:base64(buf),next:offset+buf.byteLength,bytes:r.bytes};
      }
      case 'DELETE_ALL': {
        if(active) return {ok:false,error:'正在錄音，請停止錄音後再清除'};
        const existing=await transaction('readonly',s=>s.count());
        await transaction('readwrite',s=>s.clear());
        for(const url of urls.values())URL.revokeObjectURL(url);
        urls.clear();
        return {ok:true,deleted:existing};
      }
      case 'DELETE': {
        await transaction('readwrite',s=>s.delete(m.id));
        if(urls.has(m.id)){URL.revokeObjectURL(urls.get(m.id));urls.delete(m.id);}
        return {ok:true};
      }
      default:return {ok:false,error:'Unknown message'};
    }
  })().then(reply).catch(e=>reply({ok:false,error:e.message}));
  return true;
});
