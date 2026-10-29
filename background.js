const DEFAULT_PROMPT = "請將附加音訊的內容完整翻譯成臺灣使用的正體中文。\n\n要求：\n1. 自動辨識日文、英文或其他語言，逐段完整翻譯，不要僅提供摘要。\n2. 保留原本語氣、情緒、玩笑與口語表達，使用自然的臺灣用語。\n3. 人名、專有名詞、遊戲與歌曲名稱盡量保留原文，必要時補充翻譯。\n4. 若能辨識不同說話者，請適當標示。\n5. 聽不清楚之處請標示「（聽不清楚）」，不要自行編造內容。\n6. 若內容很長，請依順序盡量完整翻譯，不要省略。\n\n請直接開始完整翻譯。";

const diagnosticKey='diagnosticLogV19';
// Completion monitor is independent from the tab's long-running content script.
// Keep a small checkpoint so service-worker suspension does not lose the job.
const monitorKey = 'translationCompletionChecksV122';
let monitorChecking = false;
async function readMonitors(){return (await chrome.storage.local.get(monitorKey))[monitorKey]||{};}
async function saveMonitors(items){await chrome.storage.local.set({[monitorKey]:items});}
function digestText(s){let h=2166136261;for(let i=0;i<s.length;i++){h=Math.imul(h^s.charCodeAt(i),16777619);}return (h>>>0).toString(16);}
// A fresh completion snapshot uses multiple UI signals. The blue voice button is an
// idle-composer indicator, NOT by itself proof that a new answer has arrived.
async function captureChatSnapshot(tabId){
 const results=await chrome.scripting.executeScript({target:{tabId},func:()=>{
   // ChatGPT changes its DOM frequently. Read assistant turns through several independent paths,
   // choosing the most recent DOM position rather than the first nonempty selector.
   const selectors=['[data-message-author-role="assistant"]','[data-testid="conversation-turn-assistant"]','article[data-turn="assistant"]','[data-testid^="conversation-turn-"]'];
   const seen=new Set(),candidates=[];
   for(const sel of selectors)for(const node of document.querySelectorAll(sel)){
     if(seen.has(node))continue;
     const role=node.getAttribute('data-message-author-role')||node.getAttribute('data-turn')||'';
     const nested=node.querySelector('[data-message-author-role="assistant"]');
     const test=node.getAttribute('data-testid')||'';
     if(!/assistant/i.test(role+test)&&!nested)continue;
     const actual=nested||node;
     if(seen.has(actual))continue;
     seen.add(actual);
     const t=(actual.innerText||actual.textContent||'').trim();
     if(t)candidates.push({node:actual,text:t});
   }
   candidates.sort((a,b)=>a.node===b.node?0:(a.node.compareDocumentPosition(b.node)&Node.DOCUMENT_POSITION_FOLLOWING?-1:1));
   const last=candidates.at(-1),buttons=[...document.querySelectorAll('button')];
   const aria=b=>(b.getAttribute('aria-label')||b.getAttribute('data-testid')||b.getAttribute('title')||'').toLowerCase();
   const visible=b=>!!b.getClientRects().length && getComputedStyle(b).visibility!=='hidden';
   const stop=buttons.some(b=>visible(b)&&/stop-button|stop generating|stop streaming|停止生成|停止產生|停止回應|停止回覆/.test(aria(b)));
   const voice=buttons.some(b=>visible(b)&&/voice-mode|voice-button|start voice|voice mode|語音模式|啟動語音|開始語音|語音對話/.test(aria(b)));
   const send=buttons.some(b=>visible(b)&&/send-button|send prompt|send message|傳送訊息|送出/.test(aria(b)));
   const turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"],[data-message-author-role]')];
   const lastTurn=turns.at(-1);
   return {count:candidates.length,text:(last?.text||'').slice(-8000),stop,voice,send,url:location.href,selectorUsed:'multi-dom',totalTurns:turns.length,lastTurnRole:lastTurn?.getAttribute('data-message-author-role')||lastTurn?.getAttribute('data-testid')||'',assistantFound:!!last};
 }});
 return results?.[0]?.result||null;
}
async function registerMonitor(id,tabId,baseline){
 try {const fresh=await captureChatSnapshot(tabId);if(fresh?.assistantFound)baseline={count:fresh.count,text:fresh.text};}catch(e){await logEvent('COMPLETION_WATCH','baseline snapshot failed: '+e.message,{id});}
 const monitors=await readMonitors();
 monitors[id]={id,tabId,baselineCount:baseline?.count||0,baselineDigest:digestText(String(baseline?.text||'').slice(-4000)),createdAt:Date.now(),lastDigest:'',stableAt:0,checks:0,stopSeen:false,voiceSeen:false};
 await saveMonitors(monitors);
 await logEvent('COMPLETION_WATCH','monitor disabled by user preference',{id});
}
async function pollTranslationCompletion(){
 if(monitorChecking)return;
 monitorChecking=true;
 try{
  const items=await readMonitors();let changed=false;
  for(const [id,m] of Object.entries(items)){
   if(Date.now()-m.createdAt>20*60*1000){await logEvent('COMPLETION_WATCH','monitor timed out',{id});delete items[id];changed=true;continue;}
   let snap;
   try{snap=await captureChatSnapshot(m.tabId);}catch(e){
    m.checks++;changed=true;
    if(m.checks%4===1)await logEvent('COMPLETION_WATCH','snapshot unavailable: '+e.message,{id,tabId:m.tabId});
    continue;
   }
   if(!snap)continue;
   const hash=digestText(snap.text||'');
   const isNew=!!snap.text && (snap.count>m.baselineCount || hash!==m.baselineDigest);
   // Voice-mode returns after generation ends on current ChatGPT layouts.
   // Do NOT treat voice alone as completion: it can be present before submission.
   if(snap.stop)m.stopSeen=true;
   if(snap.voice)m.voiceSeen=true;
   const composerIdle=!snap.stop && (snap.voice || snap.send);
   const observedReply=isNew && (snap.count>m.baselineCount || snap.text.length>0);
   const canComplete=observedReply && composerIdle;
   
   m.checks++;changed=true;
   if(!canComplete){m.stableAt=0;m.lastDigest='';}
   else if(m.lastDigest!==hash){m.lastDigest=hash;m.stableAt=Date.now();}
   else if(Date.now()-m.stableAt>=8000){
    const cur=await getState();
    if(cur.lastId===id && ['sent','done','uploading','completed'].includes(cur.phase)){
      await setState({...cur,phase:'sent',error:''});
      await logEvent('COMPLETION_WATCH','completed via background snapshot',{id,tabId:m.tabId,chars:snap.text.length,voice:snap.voice,stopSeen:m.stopSeen});
      delete items[id];continue;
    }
    if(cur.lastId!==id){await logEvent('COMPLETION_WATCH','older response completed, active recording unchanged',{id});delete items[id];continue;}
   }
   if(m.checks%2===1)await logEvent('COMPLETION_WATCH','poll',{id,count:snap.count,baseline:m.baselineCount,newResponse:isNew,stop:snap.stop,voice:snap.voice,send:snap.send,selector:snap.selectorUsed,chars:snap.text.length,turns:snap.totalTurns,lastRole:snap.lastTurnRole,stableAt:m.stableAt});
  }
  if(changed)await saveMonitors(items);
 }finally{monitorChecking=false;}
}

async function logEvent(stage,message,meta={}) {
  try {
    const raw=(await chrome.storage.local.get(diagnosticKey))[diagnosticKey]||[];
    raw.push({time:new Date().toISOString(),stage,message:String(message||''),meta});
    await chrome.storage.local.set({[diagnosticKey]:raw.slice(-180)});
  } catch(e) { console.warn('diagnostic log failed',e); }
}
const stateKey = 'recordingState';
const taskKey='persistentTransferTasksV113';
const templateKey='promptTemplatesV113';
const selectedTemplateKey='selectedPromptTemplateV113';
async function getTemplates(){return (await chrome.storage.local.get(templateKey))[templateKey]||[{id:'original',name:'原始完整翻譯（六條）',text:DEFAULT_PROMPT}];}
async function selectedPrompt(){const a=await chrome.storage.local.get(selectedTemplateKey);const list=await getTemplates();return list.find(t=>t.id===(a[selectedTemplateKey]||'original'))?.text||DEFAULT_PROMPT;}
async function queueSnapshot(){return (await chrome.storage.local.get(taskKey))[taskKey]||[];}
async function writeQueue(items){await chrome.storage.local.set({[taskKey]:items});}
async function markQueue(id,fields){const list=await queueSnapshot();const i=list.findIndex(t=>t.id===id);if(i>=0){list[i]={...list[i],...fields};await writeQueue(list);}}
let restoringQueue=false;
async function restoreQueue(){
 if(restoringQueue||queuedCount)return;restoringQueue=true;
 try {const list=await queueSnapshot();
 for(const t of list.filter(t=>t.status==='queued'))queueTransfer(t.id,t.filename,t.chatId,true).catch(e=>logEvent('QUEUE_RESTORE_ERROR',e.message,{id:t.id}));
 const interrupted=list.filter(t=>t.status==='sending');
 if(interrupted.length){for(const t of interrupted){t.status='uncertain';t.error='背景程序曾重新啟動，請先確認 ChatGPT 是否已收到，再手動重試。';}await writeQueue(list);}
 }finally{restoringQueue=false;}
}
async function refreshBadge(){
 const s=await getState();const q=(await queueSnapshot()).filter(t=>['queued','sending'].includes(t.status));
 const text=s.phase==='recording'?'REC':s.phase==='starting'||s.phase==='stopping'?'…':q.some(t=>t.status==='sending')?'UP':q.length?String(Math.min(q.length,99)):s.phase==='error'?'ERR':'';
 await chrome.action.setBadgeText({text});await chrome.action.setBadgeBackgroundColor({color:s.phase==='error'?'#b91c1c':s.phase==='recording'?'#dc2626':text==='OK'?'#15803d':'#2563eb'});
}

const chatKey = 'dedicatedChat'; // 舊版目前選取的聊天室
const chatsKey = 'translationChats'; // 本機聊天室清單
let starting = false;
let transferTail = Promise.resolve();
let queuedCount = 0;
let activeTransferId = null;
const transferWaiters = new Map();
const transferTimeoutMs = 65000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function queueTransfer(id, filename, chatId = null, restored = false) {
  queuedCount++;
  const register = restored ? Promise.resolve() : (async()=>{const list=await queueSnapshot();const index=list.findIndex(t=>t.id===id);if(index>=0)list.splice(index,1);list.push({id,filename,chatId,status:'queued',createdAt:Date.now()});await writeQueue(list);})();
  const task = transferTail.catch(() => {}).then(async () => {
    await register;
    await markQueue(id,{status:'sending'});activeTransferId=id;await refreshBadge();
    try {await openChatAndTransfer(id,filename,chatId);await markQueue(id,{status:'done',error:null});}
    catch(e){await markQueue(id,{status:'failed',error:e.message});throw e;}
    finally {activeTransferId=null;await refreshBadge();}
  }).finally(()=>{queuedCount=Math.max(0,queuedCount-1);});
  transferTail=task.catch(()=>{});return task;
}
let creatingOffscreen;
async function getState() {
  return (await chrome.storage.local.get(stateKey))[stateKey] || { phase: 'idle' };
}
async function setState(data) {
  await chrome.storage.local.set({[stateKey]: data});
  await logEvent('STATE',data.phase,{error:data.error||null,lastId:data.lastId||null});
  const phase = data.phase;
  const badge = phase === 'recording' ? 'REC' : phase === 'starting' || phase === 'stopping' ? '…' : phase === 'error' ? 'ERR' : '';
  await refreshBadge();
  await chrome.action.setBadgeBackgroundColor({color: phase === 'error' ? '#b91c1c' : '#dc2626'});
  await chrome.action.setTitle({title: phase === 'recording' ? '錄音中：開啟控制面板可停止' : phase === 'error' ? '發生錯誤，請到控制面板檢查' : '點擊開啟錄音與聊天管理面板'});
}
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL('offscreen.html')]});
    if (!contexts.length) {
      await chrome.offscreen.createDocument({url:'offscreen.html', reasons:['USER_MEDIA'], justification:'在背景錄製使用者指定 YouTube 分頁的音訊，暫存在本機並傳送 ChatGPT。'});
    }
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
function msgOffscreen(message) { return chrome.runtime.sendMessage({...message, to:'offscreen'}); }
async function notify(title, message) {
  try { await chrome.notifications.create({type:'basic', iconUrl:'icon.png', title, message}); } catch (e) { console.warn('Notification:',e); }
}
async function startRecording(tab) {
  if (starting) return;
  starting = true;
  try {
    if (!tab?.id || !/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url || '')) {
      throw new Error('請先切換到 YouTube 影片或直播分頁，再點擊擴充套件圖示。');
    }
    const current = await getState();
    if (['recording','starting','stopping'].includes(current.phase)) return;
    await setState({phase:'starting', tabId:tab.id, title:tab.title});
    await ensureOffscreen();
    // Chrome 規定在使用者點擊工具列圖示所觸發的執行流程中擷取分頁。
    await logEvent('REC','tabCapture request',{tabId:tab.id});
    const streamId = await chrome.tabCapture.getMediaStreamId({targetTabId:tab.id});
    await logEvent('REC','stream captured; starting MediaRecorder');
    const r = await msgOffscreen({type:'START', streamId, tabId:tab.id, title:tab.title});
    if (!r?.ok) throw new Error(r?.error || '無法開始錄製。');
    await setState({phase:'recording', tabId:tab.id, title:tab.title, startedAt:Date.now()});
  } catch(e) {
    await logEvent('REC_ERROR',e.message);
    await setState({phase:'error', error:e.message});
    await notify('無法開始錄音',e.message);
  } finally { starting = false; }
}
async function stopRecording() {
  const current = await getState();
  if (current.phase !== 'recording') return;
  try {
    await setState({...current,phase:'stopping'});
    await ensureOffscreen();
    const result = await msgOffscreen({type:'STOP'});
    if (!result?.ok) throw new Error(result?.error || '停止錄音失敗');
    // offscreen 會另外發出 RECORDING_SAVED；不依賴 stop 回覆中的時間順序。
  } catch(e) {
    await logEvent('STOP_ERROR',e.message);
    await setState({phase:'error',error:e.message});
    await notify('停止錄音失敗',e.message);
  }
}
async function waitForTabComplete(tabId, timeoutMs=30000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const tab=await chrome.tabs.get(tabId);
    if(tab.status==='complete') return;
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw new Error('ChatGPT 分頁載入逾時，請確認網路連線及登入狀態。');
}
async function connectChatScript(tabId) {
  // 既有 ChatGPT 分頁可能早於擴充套件安裝／更新，因此不會自動載入 content script。
  // 主動注入目前版本，並用 PING 確認接收端真的存在。
  let lastError='';
  for(let attempt=0;attempt<5;attempt++) {
    try {
      const ping=await chrome.tabs.sendMessage(tabId,{type:'YT_TRANSLATOR_PING'});
      await logEvent('CHAT_CONNECT','PING returned',{version:ping?.version||null,expected:chrome.runtime.getManifest().version});
      if(ping?.ok && ping.version===chrome.runtime.getManifest().version)return;
    } catch(e) {lastError=e.message;}
    try {
      await logEvent('CHAT_CONNECT','injecting content script',{tabId});
      await chrome.scripting.executeScript({target:{tabId},files:['chatgpt.js']});
      const pong=await chrome.tabs.sendMessage(tabId,{type:'YT_TRANSLATOR_PING'});
      if(pong?.ok && pong.version===chrome.runtime.getManifest().version) return;
      lastError='ChatGPT 上傳腳本未回覆版本檢查';
    } catch(e) {lastError=e.message;}
    await new Promise(resolve=>setTimeout(resolve,650));
  }
  await logEvent('CHAT_CONNECT_ERROR',lastError,{tabId});
  throw new Error('ChatGPT 頁面連線失敗：'+lastError+'。請確認頁面不是瀏覽器內部錯誤頁面。');
}
// 清單與目前選擇分開管理；每台電腦各自儲存，不同步。
async function getChats() {
  const stored=await chrome.storage.local.get([chatsKey,chatKey]);
  let chats=stored[chatsKey];
  if(!Array.isArray(chats)) {
    const old=stored[chatKey];
    chats=old ? [{id:crypto.randomUUID(),label:'原有翻譯聊天室',tabId:old.tabId||null,conversationUrl:old.conversationUrl||null,createdAt:Date.now()}] : [];
    await chrome.storage.local.set({[chatsKey]:chats,selectedChatId:chats[0]?.id||null});
  }
  return chats;
}
async function getSelectedChat() {
  const chats=await getChats();
  const {selectedChatId}=await chrome.storage.local.get('selectedChatId');
  return chats.find(c=>c.id===selectedChatId)||chats[0]||null;
}
async function saveChat(updated) {
  const chats=await getChats();
  const i=chats.findIndex(c=>c.id===updated.id);
  if(i<0)return;
  chats[i]={...chats[i],...updated};
  await chrome.storage.local.set({[chatsKey]:chats});
  const selection=(await chrome.storage.local.get('selectedChatId')).selectedChatId;
  if(selection===updated.id)await chrome.storage.local.set({[chatKey]:{tabId:chats[i].tabId,conversationUrl:chats[i].conversationUrl}});
}
async function createChat(select = true) {
  const chats=await getChats();
  const chat={id:crypto.randomUUID(),label:`翻譯聊天室 ${Math.max(0,...chats.map(c=>Number(c.label?.match(/^翻譯聊天室 (\d+)$/)?.[1])||0))+1}`,tabId:null,conversationUrl:null,createdAt:Date.now()};
  chats.push(chat);
  if(select)await chrome.storage.local.set({[chatsKey]:chats,selectedChatId:chat.id,[chatKey]:{tabId:null,conversationUrl:null}});
  else await chrome.storage.local.set({[chatsKey]:chats});
  return chat;
}
const isConversationUrl = url => /^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+(?:[/?#]|$)/.test(url || '');

// 僅讀取已開啟 ChatGPT 頁面中的對話導覽連結，不切換頁籤或修改對話。
// 網站未載入某筆聊天的側邊欄項目時，保留已儲存標題。
async function syncChatTitles() {
  const chats = await getChats();
  const ids = [...new Set(chats.map(c => (c.conversationUrl || '').match(/\/c\/([a-zA-Z0-9-]+)/)?.[1]).filter(Boolean))];
  if (!ids.length) return {ok:true,updated:0,total:0,reason:'尚無已建立的聊天室可同步'};
  const tabs = await chrome.tabs.query({url:['https://chatgpt.com/*']});
  const found = new Map();
  for (const tab of tabs) {
    if (!tab.id || !tab.url?.startsWith('https://chatgpt.com/')) continue;
    try {
      const result = await chrome.scripting.executeScript({target:{tabId:tab.id},func:(targetIds)=>{
        const values = {};
        const wanted = new Set(targetIds);
        for (const anchor of document.querySelectorAll('a[href*="/c/"]')) {
          let id;
          try { const url = new URL(anchor.getAttribute('href'),location.href); if(url.origin !== 'https://chatgpt.com')continue; id=url.pathname.match(/^\/c\/([a-zA-Z0-9-]+)/)?.[1]; } catch {continue;}
          if (!id || !wanted.has(id)) continue;
          const content = (anchor.innerText || anchor.getAttribute('aria-label') || anchor.getAttribute('title') || '').trim().replace(/\s+/g,' ');
          if (!content || content.length > 180) continue;
          // 排除常見操作按鈕名稱與隱藏控制項文字。
          if (/^(更多|More|開啟選單|ChatGPT)$/i.test(content)) continue;
          values[id]=content;
        }
        return values;
      },args:[ids]});
      for(const [id,title] of Object.entries(result?.[0]?.result||{})) if(!found.has(id))found.set(id,title);
    } catch(e) { await logEvent('TITLE_SYNC_TAB_SKIP',e.message,{tabId:tab.id}); }
  }
  let updated=0;
  const next=chats.map(c=>{
    const id=(c.conversationUrl||'').match(/\/c\/([a-zA-Z0-9-]+)/)?.[1];
    const title=id&&found.get(id);
    if(!title || title===c.syncedTitle)return c;
    updated++;
    return {...c,syncedTitle:title,titleSyncedAt:Date.now()};
  });
  if(updated)await chrome.storage.local.set({[chatsKey]:next});
  await logEvent('TITLE_SYNC','同步完成',{updated,matched:found.size,total:ids.length,tabs:tabs.length});
  return {ok:true,updated,matched:found.size,total:ids.length,tabs:tabs.length};
}

async function acquireDedicatedTab(chatId = null) {
  const saved=chatId ? (await getChats()).find(c=>c.id===chatId) : (await getSelectedChat()||await createChat());
  if(!saved)throw new Error("指定的聊天室綁定已不存在，請重新選擇。");
  let tab=null;
  if(saved.tabId) {
    try {tab=await chrome.tabs.get(saved.tabId);} catch {}
    if(tab && !/^https:\/\/chatgpt\.com\//.test(tab.url||''))tab=null;
  }
  if(tab && saved.conversationUrl && tab.url?.split(/[?#]/)[0]!==saved.conversationUrl)tab=null;
  if(!tab) {
    // 背景開分頁，不改變使用者目前的 YouTube 分頁。
    tab=await chrome.tabs.create({url:saved.conversationUrl||'https://chatgpt.com/',active:false});
    await saveChat({...saved,tabId:tab.id});
  } else if(!saved.conversationUrl && isConversationUrl(tab.url)) {
    await saveChat({...saved,conversationUrl:tab.url.split(/[?#]/)[0]});
  }
  await waitForTabComplete(tab.id);
  return tab;
}
async function getDedicatedChat() {return getSelectedChat();}
async function saveDedicatedChat(c) {const old=await getSelectedChat(); if(old)await saveChat({...old,...c});}
async function openChatAndTransfer(id, filename, chatId = null) {
  await ensureOffscreen();
  await logEvent('TRANSFER','acquire dedicated tab',{id});
  const target=await acquireDedicatedTab(chatId);
  await logEvent('TRANSFER','dedicated tab acquired',{tabId:target.id});
  await connectChatScript(target.id);
  await logEvent('TRANSFER','content script connected',{tabId:target.id});
  const now=await getState();
  if(!['recording','starting','stopping'].includes(now.phase)) await setState({phase:'uploading',lastId:id,filename});
  // 只等待本次任務的最終狀態，不再靠網頁 busy 無限輪詢。
  let resolveWaiter;
  const done=new Promise(resolve=>{resolveWaiter=resolve;});
  const timer=setTimeout(()=>{
    const waiter=transferWaiters.get(id);
    if(waiter?.resolve===resolveWaiter){ transferWaiters.delete(id); resolveWaiter({ok:false,error:'本次上傳超過 65 秒，已解除鎖定。請先確認聊天室是否已送出，再決定是否重試。'}); }
  },transferTimeoutMs);
  transferWaiters.set(id,{resolve:resolveWaiter,timer,tabId:target.id,chatId});
  try {
    await logEvent('TRANSFER','send TRANSLATE_AUDIO command',{id});
    const prompt=await selectedPrompt();
    if(!prompt.trim())throw new Error('翻譯提示詞內容為空，禁止傳送。');
    await logEvent('PROMPT','prompt prepared',{id,length:prompt.length});
    const resp=await Promise.race([chrome.tabs.sendMessage(target.id,{type:'TRANSLATE_AUDIO',id,filename,prompt}),sleep(10000).then(()=>({ok:false,error:'ChatGPT 頁面 10 秒內未回應啟動要求'}))]);
    await logEvent('TRANSFER',resp?.ok?'accepted':'rejected',{error:resp?.error||null});
    if(!resp?.ok)throw new Error(resp?.error||'ChatGPT 未接受上傳任務。');
    const result=await done;
    await logEvent('TRANSFER',result.ok?'completed':'failed',{error:result.error||null});
    if(!result.ok) throw new Error(result.error||'附件上傳未完成');
  } finally {
    const waiter=transferWaiters.get(id);
    if(waiter?.resolve===resolveWaiter){clearTimeout(waiter.timer);transferWaiters.delete(id);}
  }
}

// Read the latest currently rendered messages from YouTube live chat frames.
async function readRecentLiveChat(tabId, limit=15){
 const frames=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{
   const selectors=['yt-live-chat-text-message-renderer','yt-live-chat-paid-message-renderer','yt-live-chat-membership-item-renderer'];
   const nodes=[...document.querySelectorAll(selectors.join(','))];
   return {frame:location.href,items:nodes.slice(-60).map(n=>{
     const name=n.querySelector('#author-name')?.textContent?.trim()||'';
     const msg=n.querySelector('#message')?.innerText?.trim()||n.querySelector('#message')?.textContent?.trim()||'';
     return {author:name||'未知發言者',text:msg};
   }).filter(x=>x.text)};
 }});
 const candidates=frames.map(f=>f.result).filter(Boolean);
 // Prefer the live-chat iframe, not comments or the main video page.
 const live=candidates.filter(x=>/youtube\.com\/(live_chat|live_chat_replay)/.test(x.frame));
 const chosen=(live.length?live:candidates.filter(x=>x.items.length)).sort((a,b)=>b.items.length-a.items.length)[0];
 return (chosen?.items||[]).slice(-limit);
}
async function sendLiveChatToGpt(tabId,chatId){
 if(queuedCount||activeTransferId)throw Error('目前正在傳送錄音，請完成後再翻譯聊天室訊息。');
 const tab=await chrome.tabs.get(tabId);
 if(!/^https:\/\/(www\.|m\.)?youtube\.com\//.test(tab.url||''))throw Error('請先切換到 YouTube 直播頁面。');
 await logEvent('LIVE_CHAT','reading latest live messages',{tabId});
 const msgs=await readRecentLiveChat(tabId);
 if(!msgs.length)throw Error('無法讀取直播聊天室訊息。請確認聊天室已展開、正在顯示訊息，且不是獨立的其他網站聊天室。');
 const text='請將以下 YouTube 直播聊天室最新 '+msgs.length+' 則訊息完整翻譯為臺灣使用的正體中文。保留發言者名稱及每則訊息的順序，保留語氣、玩笑、表情符號與專有名詞；已經是中文的內容可保留原文。不要只做摘要。\n\n'+msgs.map((m,i)=>`${i+1}. ${m.author}：${m.text}`).join('\n');
 if(text.length>18000)throw Error('聊天室訊息過長，已取消傳送。');
 const target=await acquireDedicatedTab(chatId||null);
 await connectChatScript(target.id);
 const id=crypto.randomUUID();
 const r=await chrome.tabs.sendMessage(target.id,{type:'SEND_LIVE_CHAT_TEXT',id,prompt:text});
 if(!r?.ok)throw Error(r?.error||'ChatGPT 未接受聊天室翻譯任務');
 await logEvent('LIVE_CHAT','translation started',{count:msgs.length,id,tabId:target.id});
 return {ok:true,count:msgs.length};
}

async function completeRecording(info) {
  // 單次保存只能觸發一次後處理；避免重複下載與送出。
  const key = 'processed_' + info.id;
  const prev = await chrome.storage.local.get(key);
  if (prev[key]) return;
  await chrome.storage.local.set({[key]:true});
  // 不自動下載音檔；IndexedDB 本機暫存供 ChatGPT 附件傳輸與失敗重試。
  await logEvent('RECORDING_SAVED','audio saved',{id:info.id,bytes:info.bytes});
  await setState({phase:'saved', lastId:info.id,filename:info.filename});
  try {
    if (info.bytes > 100*1024*1024) throw new Error('錄音超過自動附檔的安全上限 100 MB，請從錄音管理頁面手動處理。');
    await queueTransfer(info.id,info.filename);
  } catch(e) {
    await logEvent('TRANSFER_ERROR',e.message,{id:info.id});
    await setState({phase:'error',lastId:info.id,filename:info.filename,error:e.message});
    await notify('錄音已暫存，上傳未完成',e.message+'（可至錄音管理頁面重試）');
  }
}
// 首次送出時 ChatGPT 可能立刻跳轉並卸載 content script；背景仍追蹤專用分頁網址。
chrome.tabs.onUpdated.addListener((tabId,changeInfo,tab)=>{
  if (!isConversationUrl(changeInfo.url || tab.url)) return;
  (async()=>{
    const saved=(await getChats()).find(c=>c.tabId===tabId);
    if(!saved)return;
    const url=(changeInfo.url || tab.url).split(/[?#]/)[0];
    if(saved.conversationUrl!==url)await saveChat({...saved,conversationUrl:url});
  })().catch(e=>console.warn('儲存專用 ChatGPT 對話網址失敗',e));
});
// 點擊工具列圖示由 default_popup 接管。
chrome.runtime.onMessage.addListener((m,sender,sendResponse)=>{
  if (m.to === 'offscreen' || m.to === 'chatgpt') return false;
  (async()=>{
    switch(m.type) {
      case 'TRANSLATE_LIVE_CHAT': return await sendLiveChatToGpt(m.tabId,m.chatId);
      case 'RECORDING_SAVED': await completeRecording(m); return {ok:true};
      case 'RECORDING_ERROR': await logEvent('REC_ERROR',m.error||'unknown'); await setState({phase:'error',error:m.error}); await notify('錄音失敗',m.error); return {ok:true};
      case 'CHAT_CONVERSATION_URL': {
        const chat=(await getChats()).find(c=>c.tabId===sender.tab?.id);
        if (!chat || !isConversationUrl(m.url)) return {ok:false};
        await saveChat({...chat,conversationUrl:m.url.split(/[?#]/)[0]});
        return {ok:true};
      }
      case 'TRANSLATION_BASELINE': {
        const tabId=sender.tab?.id;
        const known=(await getChats()).some(c=>c.tabId===tabId);
        if(!known||!m.id)return {ok:false,error:'unknown chat tab'};
        // Completion monitor skipped
        return {ok:true};
      }
      case 'UPLOAD_STATUS': {
        await logEvent('UPLOAD_STATUS',m.ok?'sent':'failed',{id:m.id,error:m.error||null,tabId:sender.tab?.id});
        const waiter=transferWaiters.get(m.id);
        if(waiter && sender.tab?.id === waiter.tabId){ clearTimeout(waiter.timer); transferWaiters.delete(m.id); waiter.resolve({ok:m.ok,error:m.error}); }
        const cur=await getState();
        if(!waiter || sender.tab?.id !== waiter.tabId || cur.lastId !== m.id || ['recording','starting','stopping'].includes(cur.phase)) return {ok:true};
        await setState({...cur,phase:m.ok?'sent':'error',error:m.ok?'':m.error});
        if(!m.ok) await notify('ChatGPT 自動處理未完成',m.error+'（請先確認專用聊天室的草稿狀態，再到錄音管理重試）');
        return {ok:true};
      }
      case 'TRANSLATION_COMPLETE': {
        const chat=(await getChats()).find(c=>c.tabId===sender.tab?.id);
        const cur=await getState();
        if(!chat || !m.id || cur.lastId!==m.id || !['sent','done','uploading','completed'].includes(cur.phase)){await logEvent('TRANSLATION_COMPLETE_SKIPPED','state mismatch',{id:m.id,tabId:sender.tab?.id,phase:cur.phase,lastId:cur.lastId,chatFound:!!chat});return {ok:false};}
        if(cur.phase==='completed')return {ok:true};
        const watches=await readMonitors();if(watches[m.id]){delete watches[m.id];await saveMonitors(watches);}
        await logEvent('TRANSLATION_COMPLETE','assistant response completed',{id:m.id,tabId:sender.tab.id});
        await setState({...cur,phase:'sent',error:''});
        return {ok:true};
      }
      case 'GET_OVERLAY_SETTING': {
        const r=await chrome.storage.local.get('youtubeOverlayEnabled');return {ok:true,enabled:r.youtubeOverlayEnabled===true};
      }
      case 'SET_OVERLAY_SETTING': {
        await chrome.storage.local.set({youtubeOverlayEnabled:!!m.enabled});
        return {ok:true};
      }
      case 'DIAG_LOG': await logEvent('PAGE',m.stage||'PAGE',m.message||'',{taskId:m.taskId||null}); return {ok:true};
      case 'GET_DIAGNOSTICS': return {ok:true,entries:(await chrome.storage.local.get(diagnosticKey))[diagnosticKey]||[],state:await getState(),version:chrome.runtime.getManifest().version};
      case 'CLEAR_DIAGNOSTICS': await chrome.storage.local.set({[diagnosticKey]:[]}); return {ok:true};
      case 'OPEN_DIAGNOSTICS': await chrome.tabs.create({url:chrome.runtime.getURL('diagnostics.html')});return {ok:true};
      case 'RETRY': {
        const r=await msgOffscreen({type:'GET_INFO',id:m.id});
        if(!r?.ok) return r;
        const target=(await getChats()).find(c=>c.id===m.chatId);
        if(!target)return {ok:false,error:'請先在錄音管理頁面選擇有效的目標聊天室。'};
        await logEvent('RETRY_TARGET','selected destination',{recordingId:m.id,chatId:target.id,conversationUrl:target.conversationUrl||null});
        try {await queueTransfer(m.id,r.filename,target.id);return {ok:true};} catch(e){await logEvent('RETRY_ERROR',e.message,{id:m.id});return {ok:false,error:e.message};}
      }
      case 'OPEN_RECORDINGS': await chrome.tabs.create({url:chrome.runtime.getURL('recordings.html')});return {ok:true};
      case 'ENSURE_OFFSCREEN': await ensureOffscreen(); return {ok:true};
      case 'STATE': return {ok:true,state:await getState(),queuedCount,activeTransferId,queue:(await queueSnapshot()).filter(t=>['queued','sending'].includes(t.status))};
      case 'METER': {
        const v=Math.max(0,Math.min(1,Number(m.level)||0));await chrome.storage.session.set({audioMeter:{level:v,at:Date.now()}});return {ok:true};
      }
      case 'METER_STATE': return {ok:true,meter:(await chrome.storage.session.get('audioMeter')).audioMeter||null};
      case 'GET_TEMPLATES': return {ok:true,templates:await getTemplates(),selected:(await chrome.storage.local.get(selectedTemplateKey))[selectedTemplateKey]||'original'};
      case 'SAVE_TEMPLATE': {
        const name=String(m.name||'').trim().slice(0,60),prompt=String(m.prompt||'').trim();
        if(!name||!prompt||prompt.length>12000)throw Error('請填寫範本名稱與提示詞（最多 12,000 字）。');
        const templates=await getTemplates(),id=m.id&&m.id!=='original'?m.id:crypto.randomUUID();
        const i=templates.findIndex(t=>t.id===id);const obj={id,name,text:prompt};if(i>=0)templates[i]=obj;else templates.push(obj);
        await chrome.storage.local.set({[templateKey]:templates,[selectedTemplateKey]:id});return {ok:true,id};
      }
      case 'DELETE_TEMPLATE': {
        if(m.id==='original')throw Error('原始六條提示詞不可刪除。');
        await chrome.storage.local.set({[templateKey]:(await getTemplates()).filter(t=>t.id!==m.id),[selectedTemplateKey]:'original'});return {ok:true};
      }
      case 'SELECT_TEMPLATE': {
        if(!(await getTemplates()).some(t=>t.id===m.id))throw Error('找不到範本');
        await chrome.storage.local.set({[selectedTemplateKey]:m.id});return {ok:true};
      }
      case 'OVERLAY_STATE': return {ok:true,state:await getState(),queue:queuedCount};
      case 'START_RECORDING': {
        const tabs= m.tabId ? [await chrome.tabs.get(m.tabId)] : await chrome.tabs.query({active:true,lastFocusedWindow:true});
        await startRecording(tabs[0]);
        const state=await getState();return {ok:state.phase==='recording',state,error:state.error};
      }
      case 'STOP_RECORDING': {
        await stopRecording();const state=await getState();return {ok:state.phase==='stopping'||state.phase==='saved'||state.phase==='uploading',state,error:state.error};
      }
      case 'SYNC_CHAT_TITLES': return await syncChatTitles();
      case 'LIST_CHATS': {const chats=await getChats();const selected=await getSelectedChat();return {ok:true,chats,selectedChatId:selected?.id||null};}
      case 'CREATE_CHAT': {if(activeTransferId||queuedCount)throw new Error('正在上傳音檔，請完成後再切換聊天室。');const chat=await createChat();return {ok:true,chat};}
      case 'CREATE_RETRY_CHAT': {if(activeTransferId||queuedCount)throw new Error('正在上傳音檔，請完成後再建立聊天室。');const chat=await createChat(false);return {ok:true,chat};}
      case 'REMOVE_CHAT': {
        // 只移除擴充套件的本機綁定，不關閉分頁，也不刪除 ChatGPT 的真實對話。
        if(activeTransferId||queuedCount)throw new Error('正在上傳音檔，請完成後再移除聊天室。');
        const chats=await getChats();
        const index=chats.findIndex(c=>c.id===m.id);
        if(index<0)throw new Error('找不到要移除的聊天室。');
        const removed=chats[index];
        const remaining=chats.filter(c=>c.id!==m.id);
        const selected=await getSelectedChat();
        const next=selected?.id===m.id ? (remaining[0]||null) : selected;
        await chrome.storage.local.set({
          [chatsKey]:remaining,
          selectedChatId:next?.id||null,
          [chatKey]:{tabId:next?.tabId||null,conversationUrl:next?.conversationUrl||null}
        });
        return {ok:true,removedId:removed.id,selectedChatId:next?.id||null};
      }
      case 'SELECT_CHAT': {
        if(activeTransferId||queuedCount)throw new Error('正在上傳音檔，請完成後再切換聊天室。');
        const chats=await getChats();const chat=chats.find(c=>c.id===m.id);if(!chat)throw new Error('找不到此聊天室。');
        await chrome.storage.local.set({selectedChatId:chat.id,[chatKey]:{tabId:chat.tabId,conversationUrl:chat.conversationUrl}});
        return {ok:true};
      }
      case 'OPEN_CHAT': {
        const chat=(await getChats()).find(c=>c.id===m.id);if(!chat)throw new Error('找不到聊天室');
        if(chat.tabId){try{const t=await chrome.tabs.get(chat.tabId);if(t.url?.startsWith('https://chatgpt.com/')){await chrome.tabs.update(t.id,{active:true});await chrome.windows.update(t.windowId,{focused:true});return {ok:true};}}catch{}}
        await chrome.tabs.create({url:chat.conversationUrl||'https://chatgpt.com/',active:true});return {ok:true};
      }
      default:return {ok:false,error:'Unknown message'};
    }
  })().then(sendResponse).catch(e=>sendResponse({ok:false,error:e.message}));
  return true;
});
chrome.runtime.onInstalled.addListener(async()=>{
  const s=await getState();
  if(s.phase==='recording'||s.phase==='starting'||s.phase==='stopping') await setState({phase:'idle'});
  else await setState(s);
});
chrome.runtime.onStartup.addListener(async()=>{
  const s=await getState();
  if(['recording','starting','stopping'].includes(s.phase)) await setState({phase:'error',error:'瀏覽器重新啟動，未完成的錄音可能沒有儲存。'});
  else await setState(s);
});

chrome.alarms.create('queue-recover',{periodInMinutes:1});
// Completion detection disabled by user request: only report 'sent'.
chrome.alarms.onAlarm.addListener(async a=>{if(a.name==='queue-recover'&&!queuedCount)await restoreQueue();});
restoreQueue().catch(e=>logEvent('QUEUE_INIT_ERROR',e.message));


