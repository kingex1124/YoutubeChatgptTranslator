(()=>{
 if(window!==window.top||document.getElementById('ytgpt-control-v125'))return;
 const host=document.createElement('div');host.id='ytgpt-control-v125';
 host.style.cssText='position:fixed;bottom:96px;right:22px;z-index:2147483647;display:none;max-width:min(380px,calc(100vw - 30px));';
 const shadow=host.attachShadow({mode:'open'});
 shadow.innerHTML=`<style>
 *{box-sizing:border-box} .shell{display:flex;align-items:center;gap:10px;padding:8px 11px 8px 8px;border-radius:20px;background:linear-gradient(115deg,#122a4a,#203c63);box-shadow:0 10px 32px #0005,0 0 0 1px #ffffff25;color:#fff;font:12px/1.35 system-ui,'Microsoft JhengHei',sans-serif;min-width:180px;max-width:380px;backdrop-filter:blur(8px)}
 button{border:0;border-radius:14px;background:linear-gradient(125deg,#fa5868,#ca2543);padding:10px 12px;color:white;font:700 12px/1.3 system-ui;white-space:nowrap;cursor:pointer;box-shadow:0 3px 12px #f03c5b33;transition:transform .12s,filter .12s}button:hover{filter:none;background:linear-gradient(125deg,#e64b60,#bf2948);box-shadow:0 3px 10px #f03c5b24}button:active{transform:scale(.96)}button:disabled{opacity:.55;cursor:wait} .meta{cursor:grab;touch-action:none;user-select:none} .meta:active{cursor:grabbing} .meta{display:grid;gap:3px;min-width:0;flex:1}.eyebrow{color:#a8c9e7;font-size:10px;font-weight:700;letter-spacing:.3px}.status{font-weight:700;font-variant-numeric:tabular-nums;max-width:205px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dot{width:7px;height:7px;display:inline-block;background:#58d6a5;border-radius:50%;margin-right:5px}.shell[data-phase=recording] .dot{background:#ff6680;animation:pulse 1s infinite}.shell[data-phase=error] .dot{background:#fbbf24}@keyframes pulse{50%{opacity:.25}}
 @media (prefers-reduced-motion:reduce){.dot{animation:none!important}button{transition:none}}
 </style><div class="shell" data-phase="idle"><button id="record" type="button">● 開始錄音</button><div class="meta"><span class="eyebrow">YT 音訊翻譯</span><span id="status" class="status"><span class="dot"></span><span id="text">待命</span></span></div></div>`;
 const button=shadow.getElementById('record'),label=shadow.getElementById('text'),shell=shadow.querySelector('.shell'),grip=shadow.querySelector('.meta');
 (document.body||document.documentElement).append(host);
 let busy=false;
 let permissionHintUntil=0;
 const PERMISSION_HINT='請先點 Chrome 擴充套件圖示，啟用本分頁錄音權限';
 // Drag by the status area. Persist within the extension per computer.
 const positionKey='youtubeOverlayPositionV124';
 let dragging=null;
 const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));
 function applyPosition(pos){
   const w=host.offsetWidth||220,h=host.offsetHeight||58;
   const x=clamp(Number(pos.x)||0,0,Math.max(0,innerWidth-w-8));
   const y=clamp(Number(pos.y)||0,0,Math.max(0,innerHeight-h-8));
   host.style.left=x+'px';host.style.top=y+'px';host.style.right='auto';host.style.bottom='auto';
 }
 chrome.storage.local.get(positionKey).then(obj=>{if(obj[positionKey])applyPosition(obj[positionKey]);}).catch(()=>{});
 grip.title='拖曳以移動浮動錄音工具';
 grip.addEventListener('pointerdown',e=>{
   if(e.button!==0)return;
   const rect=host.getBoundingClientRect();
   dragging={id:e.pointerId,dx:e.clientX-rect.left,dy:e.clientY-rect.top};
   grip.setPointerCapture(e.pointerId);e.preventDefault();
 });
 grip.addEventListener('pointermove',e=>{
   if(!dragging||dragging.id!==e.pointerId)return;
   applyPosition({x:e.clientX-dragging.dx,y:e.clientY-dragging.dy});
 });
 function finishDrag(e){
   if(!dragging||dragging.id!==e.pointerId)return;
   dragging=null;
   const rect=host.getBoundingClientRect();
   chrome.storage.local.set({[positionKey]:{x:Math.round(rect.left),y:Math.round(rect.top)}}).catch(()=>{});
 }
 grip.addEventListener('pointerup',finishDrag);
 grip.addEventListener('pointercancel',finishDrag);
 addEventListener('resize',()=>{if(host.style.left){const rect=host.getBoundingClientRect();applyPosition({x:rect.left,y:rect.top});}});

 button.onclick=async()=>{
   if(busy)return;busy=true;button.disabled=true;
   try{
     const s=await chrome.runtime.sendMessage({type:'STATE'});
     const recording=s.state?.phase==='recording';
     const r=await chrome.runtime.sendMessage({type:recording?'STOP_RECORDING':'START_RECORDING'});
     if(!r?.ok){
       const msg=r?.error||'操作失敗';
       if(/not been invoked|activeTab|Chrome pages cannot be captured/i.test(msg)){
         permissionHintUntil=Date.now()+12000;
         label.textContent=PERMISSION_HINT;
         label.title=PERMISSION_HINT;
       }else{label.textContent=msg;label.title=msg;permissionHintUntil=Date.now()+6000;}
     }else permissionHintUntil=0;
   }catch(e){label.textContent=e.message||'操作失敗';permissionHintUntil=Date.now()+6000;}
   finally{busy=false;button.disabled=false;update();}
 };
 async function update(){try{const [r,setting]=await Promise.all([chrome.runtime.sendMessage({type:'STATE'}),chrome.storage.local.get('youtubeOverlayEnabled')]);
 host.style.display=setting.youtubeOverlayEnabled===true?'block':'none';if(setting.youtubeOverlayEnabled!==true)return;
 const s=r.state||{};shell.dataset.phase=s.phase||'idle';button.textContent=s.phase==='recording'?'■ 停止錄音':'● 開始錄音';button.disabled=busy||['starting','stopping'].includes(s.phase);
 const phaseText={starting:'正在啟動',stopping:'正在結束',saved:'等待上傳',uploading:'上傳 ChatGPT 中',done:'已送出',sent:'已送出',completed:'已送出',error:'失敗，請查看診斷'};
 if(permissionHintUntil>Date.now() && s.phase==='error'){label.textContent=PERMISSION_HINT;label.title=PERMISSION_HINT;return;}
 if(s.phase==='recording'){const seconds=Math.max(0,Math.floor((Date.now()-(s.startedAt||Date.now()))/1000));label.textContent=`錄音中 ${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;}else label.textContent=phaseText[s.phase]||'待命';label.title=s.error||'';
 }catch(e){label.textContent='狀態讀取失敗';}}
 chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.youtubeOverlayEnabled){host.style.display=changes.youtubeOverlayEnabled.newValue===true?'block':'none';}});
 setInterval(update,1000);update();
})();