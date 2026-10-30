const $=id=>document.getElementById(id);
const off=m=>chrome.runtime.sendMessage({...m,to:'offscreen'});
async function ready(){await chrome.runtime.sendMessage({type:'ENSURE_OFFSCREEN'});return off({type:'LIST'});}
function report(message){$('status').textContent=message;}
function row(label,fn,cls){const b=document.createElement('button');b.textContent=label;if(cls)b.className=cls;b.addEventListener('click',fn);return b;}
async function download(id,filename){
  const info=await off({type:'GET_INFO',id});if(!info?.ok)throw new Error(info?.error||'讀取失敗');
  const parts=[];
  for(let offset=0;offset<info.bytes;){
    const r=await off({type:'CHUNK',id,offset,length:524288});if(!r?.ok)throw new Error(r?.error||'讀取失敗');
    const b=atob(r.data),bytes=new Uint8Array(b.length);for(let i=0;i<b.length;i++)bytes[i]=b.charCodeAt(i);
    parts.push(bytes);offset=r.next;
  }
  const url=URL.createObjectURL(new Blob(parts,{type:info.mime}));
  const a=document.createElement('a');a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
async function loadQueue(){
 const r=await chrome.runtime.sendMessage({type:'GET_QUEUE'});if(!r?.ok)throw Error(r?.error||'無法讀取佇列');
 const root=$('queueProgress');root.replaceChildren();
 queueForFilter=r.queue||[];
 const tasks=r.queue||[];
 const busy=tasks.some(t=>t.status==='sending');
 $('clearQueueDone').disabled=!tasks.some(t=>t.status==='done');
 $('clearQueueAll').disabled=busy||!tasks.some(t=>['done','failed','uncertain','queued'].includes(t.status));
 const records=tasks.slice(-30).reverse();if(!records.length){root.textContent='目前沒有傳送任務。';return;}
 for(const task of records){const div=document.createElement('div');div.className='item';const label=document.createElement('div');label.style.overflowWrap='anywhere';label.textContent=`${task.filename||task.id} — ${task.stage||task.status}`+(task.error?' — '+task.error:'');div.append(label);root.append(div);}
}
$('refreshQueue').onclick=()=>loadQueue().catch(e=>report(e.message));
async function clearQueue(mode){
 const isAll=mode==='all';
 const message=isAll
  ?'確定清空傳送佇列？\n\n將取消等待中任務，並清除已送出、失敗與結果不明的紀錄。\n本機錄音與 ChatGPT 聊天紀錄不會刪除。\n已送出的訊息無法撤回。'
  :'確定清除所有「已送出」的佇列紀錄？\n本機錄音與 ChatGPT 對話不會被刪除。';
 if(!confirm(message))return;
 $('clearQueueDone').disabled=true;$('clearQueueAll').disabled=true;
 try{
   const r=await chrome.runtime.sendMessage({type:'CLEAR_QUEUE_HISTORY',mode});
   if(!r?.ok)throw Error(r?.error||'清理失敗');
   $('queueStatus').textContent=`已清理 ${r.removed} 筆佇列紀錄，保留 ${r.remaining} 筆。錄音檔案未刪除。`;
   await loadQueue();await load();
 }catch(e){$('queueStatus').textContent='清理失敗：'+e.message;await loadQueue();}
}
$('clearQueueDone').onclick=()=>clearQueue('done');
$('clearQueueAll').onclick=()=>clearQueue('all');

let retryChatId=null;
let deletingAll=false;
let allRecordingItems=[];let queueForFilter=[];
async function loadChats(sync=false){
  if(sync){const result=await chrome.runtime.sendMessage({type:'SYNC_CHAT_TITLES'});if(!result?.ok)throw Error(result?.error||'同步標題失敗');$('chatStatus').textContent=result.reason||`已比對 ${result.matched||0} / ${result.total||0} 個聊天標題，更新 ${result.updated||0} 個。`;}
  const r=await chrome.runtime.sendMessage({type:'LIST_CHATS'});
  if(!r?.ok)throw Error(r?.error||'無法取得聊天室清單');
  const sel=$('retryChat');const preferred=retryChatId||r.selectedChatId;
  sel.replaceChildren();
  for(const chat of r.chats||[]){const option=document.createElement('option');option.value=chat.id;option.textContent=(chat.syncedTitle||chat.label)+(chat.conversationUrl?' · 已建立對話':' · 新聊天串');sel.append(option);}
  if((r.chats||[]).some(c=>c.id===preferred))sel.value=preferred;
  retryChatId=sel.value||null;
  $('chatStatus').textContent||=retryChatId?'重試音檔將傳送至所選聊天室。':'請先建立聊天室。';
}
$('retryChat').onchange=()=>{retryChatId=$('retryChat').value;};
$('newChat').onclick=async()=>{try{const r=await chrome.runtime.sendMessage({type:'CREATE_RETRY_CHAT'});if(!r?.ok)throw Error(r?.error||'建立失敗');retryChatId=r.chat.id;await loadChats();$('chatStatus').textContent='已建立新綁定；重試時會開啟新的 ChatGPT 對話。';}catch(e){$('chatStatus').textContent=e.message;}};
$('syncChats').onclick=()=>loadChats(true).catch(e=>$('chatStatus').textContent=e.message);
let diagReport='';
async function loadLog(){const r=await chrome.runtime.sendMessage({type:'GET_DIAGNOSTICS'});if(!r?.ok)throw Error(r?.error||'讀取失敗');diagReport='版本: '+r.version+'\n狀態: '+JSON.stringify(r.state)+'\n\n'+(r.entries||[]).map(x=>`[${x.time}] ${x.stage} ${x.message} ${JSON.stringify(x.meta||{})}`).join('\n');$('logOutput').textContent=diagReport;}
$('refreshLog').onclick=()=>loadLog().catch(e=>$('logStatus').textContent=e.message);
$('copyLog').onclick=async()=>{try{await navigator.clipboard.writeText(diagReport);$('logStatus').textContent='已複製診斷紀錄。';}catch(e){$('logStatus').textContent='複製失敗：'+e.message;}};
$('clearLog').onclick=async()=>{if(!confirm('清除診斷紀錄？錄音和聊天室不會被刪除。'))return;await chrome.runtime.sendMessage({type:'CLEAR_DIAGNOSTICS'});await loadLog();};
async function load(){
  const state=await chrome.runtime.sendMessage({type:'STATE'});
  $('current').textContent='目前狀態：'+({idle:'待命',recording:'錄音中',starting:'正在啟動',stopping:'正在結束',saved:'錄音已儲存',uploading:'正在上傳 ChatGPT',done:'已嘗試點擊 ChatGPT 送出',error:'需要處理錯誤'}[state.state?.phase]||'未知')+(state.state?.error?' — '+state.state.error:'');
  const r=await ready();if(!r?.ok)throw new Error(r?.error||'資料庫無法讀取');
  allRecordingItems=r.items||[];
  const container=$('list');container.replaceChildren();
  const bytes=allRecordingItems.reduce((sum,x)=>sum+(Number(x.bytes)||0),0);
  $('storageUsage').textContent=`本機錄音：${allRecordingItems.length} 筆，約 ${(bytes/1024/1024).toFixed(2)} MB（不包含瀏覽器索引與其他儲存資料）`;
  const term=$('searchRecordings').value.trim().toLocaleLowerCase();const filter=$('filterRecordings').value;
  const filtered=allRecordingItems.filter(item=>{
   if(term&&!String(item.filename||'').toLocaleLowerCase().includes(term))return false;
   const tasks=queueForFilter.filter(q=>q.id===item.id);const status=tasks.at(-1)?.status||'';
   if(filter==='sent')return status==='done';
   if(filter==='failed')return ['failed','uncertain'].includes(status);
   if(filter==='pending')return ['queued','sending'].includes(status);
   return true;
  });
  $('recordingCount').textContent=`（${r.items.length} 筆）`;
  $('deleteAll').disabled=!r.items.length||deletingAll;
  if(!r.items.length){container.textContent='目前沒有已完成的錄音。';return;}
  for(const item of filtered){
    const div=document.createElement('div');div.className='item';
    const desc=document.createElement('div'),title=document.createElement('div'),meta=document.createElement('div');title.className='title';title.textContent=item.filename;meta.className='meta';meta.textContent=new Date(item.createdAt).toLocaleString('zh-TW')+' · '+(item.bytes/1024/1024).toFixed(1)+' MB';desc.append(title,meta);
    const buttons=document.createElement('div');buttons.className='buttons';
    buttons.append(row('下載音檔',async()=>{try{report('準備下載中…');await download(item.id,item.filename);report('已要求瀏覽器下載檔案。');}catch(e){report(e.message);}}));
    buttons.append(row('重試 ChatGPT',async()=>{try{report('正在開啟 ChatGPT…');if(!retryChatId)throw Error('請先選擇或建立目標聊天室。');const r=await chrome.runtime.sendMessage({type:'RETRY',id:item.id,chatId:retryChatId});if(!r?.ok)throw new Error(r?.error);report('已開始嘗試附檔，請檢查 ChatGPT 分頁。');}catch(e){report(e.message);}}));
    buttons.append(row('刪除',async()=>{if(!confirm('確定刪除這份本機錄音？此操作無法復原。'))return;try{const r=await off({type:'DELETE',id:item.id});if(!r?.ok)throw new Error(r?.error);report('已刪除。');await load();}catch(e){report(e.message);}},'delete'));
    div.append(desc,buttons);container.append(div);
  }
}
$('deleteAll').onclick=async()=>{
  if(deletingAll)return;
  try{
    const list=await ready();
    if(!list?.ok)throw Error(list?.error||'無法取得錄音清單');
    const count=list.items.length;
    if(!count){report('目前沒有錄音可刪除。');await load();return;}
    const state=await chrome.runtime.sendMessage({type:'STATE'});
    if(['uploading','starting','stopping','recording'].includes(state?.state?.phase)){
      throw Error('目前正在錄音或傳送 ChatGPT。請等作業完成後再刪除全部錄音。');
    }
    if(!confirm(`確定要永久刪除本機所有 ${count} 筆錄音嗎？\n\n刪除後無法復原，請先下載需要保留的音檔。\nChatGPT 的對話內容不會被刪除。`))return;
    deletingAll=true;$('deleteAll').disabled=true;
    report('正在刪除全部錄音…');
    const result=await off({type:'DELETE_ALL'});
    if(!result?.ok)throw Error(result?.error||'刪除失敗');
    report(`已刪除 ${result.deleted} 筆本機錄音，ChatGPT 對話未受影響。`);
  }catch(e){report('刪除失敗：'+e.message);}
  finally{deletingAll=false;await load().catch(e=>report('重新整理失敗：'+e.message));}
};
Promise.all([loadChats(),load(),loadLog(),loadQueue()]).catch(e=>report(e.message));

$('searchRecordings').addEventListener('input',()=>load().catch(e=>report(e.message)));
$('filterRecordings').addEventListener('change',()=>load().catch(e=>report(e.message)));
