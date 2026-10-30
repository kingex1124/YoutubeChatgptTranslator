const $=id=>document.getElementById(id);
let batch=null,filter='all',selectedKey='',currentRecord=null;
async function call(message){const r=await chrome.runtime.sendMessage(message);if(!r?.ok)throw Error(r?.error||'操作失敗');return r;}
function text(parent,tag,value,cls){const el=document.createElement(tag);if(cls)el.className=cls;el.textContent=value;parent.append(el);return el;}
function render(){
 const rows=(batch?.rows||[]).filter(r=>filter==='all'||r.status===filter);
 $('rows').replaceChildren();$('rows').className=rows.length?'':'empty';
 if(!rows.length){$('rows').textContent=batch?'沒有符合條件的紀錄':'這筆紀錄沒有可顯示的擷取明細';return;}
 for(const r of rows){const box=document.createElement('div');box.className='message';const head=text(box,'div','','message-head');text(head,'span',r.author||'未知發言者','author');text(head,'span',r.status==='sent'?'本次已送出':r.status==='skipped'?'已略過重複':r.status==='failed'?'傳送失敗':'尚未確認送出','status '+r.status);text(box,'div',r.text||'','message-text');if(r.reason)text(box,'div','原因：'+r.reason,'reason');$('rows').append(box);}
}
function updateDetails(r){
 currentRecord=r;batch=r?.batch||null;
 $('reset').disabled=!(r?.seenCount>0);$('clearBatch').disabled=!batch;
 const summary=batch?.summary||{};
 $('scope').replaceChildren();
 text($('scope'),'div','直播：'+(batch?.scope?.title||'舊版直播（沒有保存標題）'));
 text($('scope'),'div','目標 ChatGPT 聊天室：'+(r?.chatTitle||'未知'));
 text($('scope'),'div','已記錄去重識別碼：'+(r?.seenCount||0)+' 筆');
 $('captured').textContent=String(summary.captured||0);$('skipped').textContent=String(summary.skipped||0);$('sent').textContent=String(summary.sent||0);
 $('time').textContent=batch?'上次擷取：'+new Date(summary.time).toLocaleString('zh-TW')+(batch.resetAt?'（去重紀錄曾重設）':'')+(summary.result==='failed'?'（傳送失敗：'+(summary.error||'未知原因')+'）':summary.result==='pending'?'（尚未確認送出）':''):'這是僅有去重識別碼的舊紀錄，沒有可還原的訊息明細。';render();
}
async function loadSelected(){
 if(!selectedKey){updateDetails(null);$('reset').disabled=true;$('clearBatch').disabled=true;return;}
 const r=await call({type:'GET_LIVE_CHAT_RECORD',key:selectedKey});updateDetails(r);
}
async function refresh(preferredKey){
 try{
  const result=await call({type:'LIST_LIVE_CHAT_RECORDS'});
  const list=result.records||[],select=$('recordSelect');
  const previous=preferredKey??selectedKey;
  const valid=list.some(x=>x.key===previous);
  selectedKey=valid?previous:(list.some(x=>x.key===result.lastKey)?result.lastKey:list[0]?.key||'');
  select.replaceChildren();
  if(!list.length){const o=document.createElement('option');o.value='';o.textContent='目前沒有任何直播紀錄';select.append(o);}
  for(const item of list){const o=document.createElement('option');o.value=item.key;o.textContent=`${item.title} ｜ ${item.chatTitle} ｜ 去重 ${item.seenCount} 筆${item.hasBatch?'':'（無明細）'}`;select.append(o);}
  select.value=selectedKey;select.disabled=!list.length;
  if(selectedKey)await loadSelected();else {updateDetails(null);$('scope').textContent='尚無任何直播去重紀錄。';}
 }catch(e){$('notice').textContent=e.message;$('reset').disabled=true;$('clearBatch').disabled=true;}
}
$('recordSelect').onchange=async()=>{selectedKey=$('recordSelect').value;$('notice').textContent='';try{await loadSelected();}catch(e){$('notice').textContent=e.message;}};
$('refresh').onclick=()=>{$('notice').textContent='';refresh();};
$('clearBatch').onclick=async()=>{
 if(!selectedKey||!currentRecord?.batch)return;
 const title=currentRecord.batch.scope?.title||'舊版直播';
 if(!confirm(`確定清除「${title}」
目標聊天室：${currentRecord.chatTitle}
上一次擷取的 ${currentRecord.batch.rows?.length||0} 則訊息明細？

這不會清除去重識別碼。`))return;
 try{await call({type:'CLEAR_LIVE_CHAT_BATCH_SELECTED',key:selectedKey});await refresh(selectedKey);$('notice').textContent='已清除選取直播的擷取明細；去重紀錄保持不變。';}catch(e){$('notice').textContent=e.message;}
};
$('reset').onclick=async()=>{
 if(!selectedKey||!currentRecord?.seenCount)return;
 const title=currentRecord.batch?.scope?.title||$('recordSelect').selectedOptions[0]?.textContent?.split(' ｜ ')[0]||'舊版直播';
 const chat=currentRecord.chatTitle;
 const count=currentRecord.seenCount;
 if(!confirm(`確定重設以下去重紀錄？

直播：${title}
目標 ChatGPT 聊天室：${chat}
將刪除：${count} 筆去重識別碼

下次可能重新翻譯相同訊息；原本擷取明細會保留。`))return;
 try{await call({type:'RESET_LIVE_CHAT_DEDUPE_SELECTED',key:selectedKey,expectedCount:count});await refresh(selectedKey);$('notice').textContent=`已清除 ${count} 筆去重識別碼，訊息明細仍保留。`;}catch(e){$('notice').textContent=e.message;await refresh(selectedKey);}
};
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));render();});
refresh();
