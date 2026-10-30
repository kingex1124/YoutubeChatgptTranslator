const $=id=>document.getElementById(id);
const call=m=>chrome.runtime.sendMessage(m);
const label={idle:'待命',starting:'正在啟動錄音',recording:'錄音中',stopping:'正在停止',saved:'已暫存錄音',uploading:'上傳 ChatGPT 中',done:'已送出',sent:'已送出',completed:'已送出',error:'需要處理'};
let current=null,selected=null,loading=false;
function error(text){$('message').textContent=text||'';}
async function refresh(){
 const [a,b]=await Promise.all([call({type:'STATE'}),call({type:'LIST_CHATS'})]);
 current=a.state||{};selected=b.selectedChatId;
 $('state').textContent='狀態：'+(label[current.phase]||current.phase||'未知');
 $('detail').textContent=[current.error, a.queuedCount?`傳送佇列：${a.queuedCount}`:''].filter(Boolean).join(' · ');
 const button=$('toggle');button.textContent=current.phase==='recording'?'停止錄音並傳送 ChatGPT':'開始錄音';
 button.disabled=loading||['starting','stopping'].includes(current.phase);
 const sel=$('chats');sel.replaceChildren();
 for(const c of b.chats||[]){const o=document.createElement('option');o.value=c.id;o.textContent=(c.syncedTitle||c.label)+(c.conversationUrl?' · 已建立對話':' · 尚未首次送出');sel.append(o);}
 if(selected)sel.value=selected;
 $('chatInfo').textContent=(b.chats||[]).find(c=>c.id===selected)?.conversationUrl||'下次停止錄音時，將背景開啟新聊天串。';
 $('new').disabled=!!a.queuedCount;
 $('chats').disabled=!!a.queuedCount;
 $('remove').disabled=!!a.queuedCount || !(b.chats||[]).length;
 $('open').disabled=!(b.chats||[]).length;
}
$('toggle').onclick=async()=>{loading=true;error('');$('toggle').disabled=true;try{const r=await call({type:current?.phase==='recording'?'STOP_RECORDING':'START_RECORDING'});if(!r.ok)error(r.error||'操作未完成');}catch(e){error(e.message);}finally{loading=false;await refresh();}};
$('chats').onchange=async()=>{try{const r=await call({type:'SELECT_CHAT',id:$('chats').value});if(!r.ok)throw Error(r.error);await refresh();}catch(e){error(e.message);await refresh();}};
$('new').onclick=async()=>{try{const r=await call({type:'CREATE_CHAT'});if(!r.ok)throw Error(r.error);await refresh();}catch(e){error(e.message);}};
$('remove').onclick=async()=>{
 const id=$('chats').value;
 if(!id)return;
 const label=$('chats').selectedOptions[0]?.textContent||'選取的聊天室';
 if(!confirm(`確定要從擴充套件清單移除「${label}」嗎？\n\n不會刪除 ChatGPT 網站上的聊天記錄，也不會關閉分頁。`))return;
 try{const r=await call({type:'REMOVE_CHAT',id});if(!r.ok)throw Error(r.error);error('已移除本機綁定。');await refresh();}
 catch(e){error(e.message);await refresh();}
};
$('open').onclick=async()=>{try{const r=await call({type:'OPEN_CHAT',id:$('chats').value});if(!r.ok)throw Error(r.error);}catch(e){error(e.message);}};
$('recordings').onclick=()=>call({type:'OPEN_RECORDINGS'});
async function syncTitles(){
 const b=$('refreshAll');b.disabled=true;
 $('syncStatus').textContent='正在從已開啟的 ChatGPT 頁面讀取標題…';
 try {
   const result=await call({type:'SYNC_CHAT_TITLES'});
   if(!result?.ok)throw new Error(result?.error||'同步失敗');
   await refresh();
   $('syncStatus').textContent=result.reason||`找到 ${result.matched} / ${result.total} 個聊天標題，更新 ${result.updated} 個。未載入的聊天保留原名稱。`;
 }catch(e){$('syncStatus').textContent='標題同步失敗：'+e.message;}
 finally{b.disabled=false;}
}
$('refreshAll').onclick=async()=>{await refresh();await syncTitles();};
refresh().then(syncTitles).catch(e=>error(e.message));


let templateMode=null,templateEditingId=null;
async function loadTemplates(preferredId){
 const r=await call({type:'GET_TEMPLATES'});
 if(!r.ok)throw Error(r.error||'讀取提示詞範本失敗');
 const select=$('templates');select.replaceChildren();
 for(const t of r.templates){const o=document.createElement('option');o.value=t.id;o.textContent=t.name;select.append(o);}
 const target=preferredId||r.selected;
 select.value=r.templates.some(t=>t.id===target)?target:'original';
 $('editTemplate').disabled=select.value==='original';
 $('deleteTemplate').disabled=select.value==='original';
}
function closeTemplateEditor(){
 $('templateEditor').hidden=true;templateMode=null;templateEditingId=null;
 $('templateName').value='';$('templateText').value='';
}
$('templates').onchange=async()=>{
 try{const r=await call({type:'SELECT_TEMPLATE',id:$('templates').value});if(!r.ok)throw Error(r.error);closeTemplateEditor();await loadTemplates();}
 catch(e){error(e.message);await loadTemplates().catch(()=>{});}
};
$('newTemplate').onclick=()=>{
 templateMode='new';templateEditingId=null;
 $('templateEditorHeading').textContent='新增提示詞範本';
 $('templateEditorHelp').textContent='新增後會自動選用此範本。';
 $('templateName').value='';$('templateText').value='';
 $('saveTemplate').textContent='建立範本';$('templateEditor').hidden=false;$('templateName').focus();
};
$('editTemplate').onclick=async()=>{
 try{
  const id=$('templates').value;
  if(id==='original')throw Error('原始六條提示詞為唯讀範本，不可編輯。你可以按「新增」另存自訂版本。');
  const r=await call({type:'GET_TEMPLATES'});if(!r.ok)throw Error(r.error);
  const t=r.templates.find(x=>x.id===id);if(!t)throw Error('找不到選取的範本');
  templateMode='edit';templateEditingId=t.id;
  $('templateEditorHeading').textContent='編輯選取範本';
  $('templateEditorHelp').textContent='將更新目前選取的範本，不會另外新增。';
  $('templateName').value=t.name;$('templateText').value=t.text;
  $('saveTemplate').textContent='儲存修改';$('templateEditor').hidden=false;$('templateName').focus();
 }catch(e){error(e.message);}
};
$('saveTemplate').onclick=async()=>{
 if(!templateMode)return;
 const button=$('saveTemplate');button.disabled=true;
 try{
  const name=$('templateName').value.trim(),prompt=$('templateText').value.trim();
  if(!name||!prompt)throw Error('請填寫範本名稱與提示詞內容。');
  const msg={type:'SAVE_TEMPLATE',name,prompt};
  if(templateMode==='edit')msg.id=templateEditingId;
  const r=await call(msg);if(!r.ok)throw Error(r.error);
  closeTemplateEditor();await loadTemplates(r.id);error('範本已儲存。');
 }catch(e){error(e.message);}finally{button.disabled=false;}
};
$('cancelTemplate').onclick=closeTemplateEditor;
$('deleteTemplate').onclick=async()=>{
 const id=$('templates').value;
 if(id==='original'){error('原始六條提示詞不可刪除。');return;}
 const name=$('templates').selectedOptions[0]?.textContent||'選取的提示詞範本';
 if(!confirm(`確定刪除「${name}」嗎？\n此動作無法復原。`))return;
 try{const r=await call({type:'DELETE_TEMPLATE',id});if(!r.ok)throw Error(r.error);closeTemplateEditor();await loadTemplates();error('已刪除選取的提示詞範本。');}catch(e){error(e.message);}
};
loadTemplates().catch(e=>error(e.message));
setInterval(async()=>{try{const r=await call({type:'STATE'});const s=r.state||{};if(s.phase==='recording'){const seconds=Math.max(0,Math.floor((Date.now()-s.startedAt)/1000));$('elapsed').textContent='錄音時間：'+String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');}else $('elapsed').textContent='錄音時間：00:00';const m=await call({type:'METER_STATE'});$('volume').value=s.phase==='recording'&&m.meter&&Date.now()-m.meter.at<3500?m.meter.level:0;}catch{}},1000);

// 每台電腦獨立保留顯示偏好，既有版本預設顯示。
(async()=>{
 const r=await call({type:'GET_OVERLAY_SETTING'});
 $('overlayEnabled').checked=r.enabled===true;
})().catch(e=>error(e.message));
$('overlayEnabled').onchange=async()=>{
 const enabled=$('overlayEnabled').checked;
 const r=await call({type:'SET_OVERLAY_SETTING',enabled});
 if(!r.ok){error(r.error||'設定失敗');$('overlayEnabled').checked=!enabled;}
};


const chatLimitKey='liveChatTranslateLimitV133';
function validChatLimit(value){const number=Number(value);return Number.isInteger(number)&&number>=1&&number<=100?number:null;}
async function updateChatLimit(){
 const n=validChatLimit($('chatLimit').value);
 $('translateChat').textContent=`翻譯直播聊天室最新 ${n??15} 則`;
 if(n!==null)await chrome.storage.local.set({[chatLimitKey]:n});
}
chrome.storage.local.get(chatLimitKey).then(r=>{
 const n=validChatLimit(r[chatLimitKey])??15;
 $('chatLimit').value=String(n);
 $('translateChat').textContent=`翻譯直播聊天室最新 ${n} 則`;
});
$('chatLimit').addEventListener('change',()=>updateChatLimit().catch(e=>error(e.message)));
$('translateChat').onclick=async()=>{
 const n=validChatLimit($('chatLimit').value);
 if(n===null){error('請輸入 1～100 的整數訊息數量。');$('chatLimit').focus();return;}
 await updateChatLimit();
 const button=$('translateChat');button.disabled=true;error(`正在擷取直播聊天室最新 ${n} 則訊息…`);
 try{
   const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});
   const r=await call({type:'TRANSLATE_LIVE_CHAT',tabId:tab?.id,chatId:$('chats').value||null,limit:n});
   if(!r?.ok)throw Error(r?.error||'翻譯任務未啟動');
   error(`已擷取 ${r.count} 則直播訊息，正在背景送至 ChatGPT。`);
 }catch(e){error('直播聊天室翻譯失敗：'+e.message)}
 finally{button.disabled=false;}
};

let detectedChannel=null;
$('detectChannel').onclick=async()=>{
 try{
  const r=await call({type:'DETECT_CHANNEL'});if(!r?.ok)throw Error(r?.error||'無法辨識頻道');
  detectedChannel=r.channel;
  const chats=await call({type:'LIST_CHATS'});
  const sel=$('channelChat');sel.replaceChildren();
  const base=document.createElement('option');base.value='';base.textContent='使用預設聊天室（不綁定）';sel.append(base);
  for(const chat of chats.chats||[]){const opt=document.createElement('option');opt.value=chat.id;opt.textContent=chat.syncedTitle||chat.label;sel.append(opt);}
  sel.value=r.boundChatId||'';
  $('channelInfo').textContent=`目前頻道：${r.channel.label} (${r.channel.key})`;
 }catch(e){detectedChannel=null;$('channelInfo').textContent=e.message;}
};
$('saveChannel').onclick=async()=>{
 if(!detectedChannel){$('channelInfo').textContent='請先偵測 YouTube 頻道。';return;}
 try{const r=await call({type:'SET_CHANNEL_BINDING',channelKey:detectedChannel.key,chatId:$('channelChat').value});if(!r?.ok)throw Error(r.error);$('channelInfo').textContent=`${detectedChannel.label}：已儲存頻道設定。`;}catch(e){$('channelInfo').textContent=e.message;}
};
