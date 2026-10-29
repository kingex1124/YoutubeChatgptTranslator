const $=id=>document.getElementById(id);
let report='';
async function load(){const r=await chrome.runtime.sendMessage({type:'GET_DIAGNOSTICS'});if(!r?.ok)throw Error(r?.error||'無法讀取診斷');report='版本: '+r.version+'\n狀態: '+JSON.stringify(r.state)+'\n\n'+(r.entries||[]).map(x=>`[${x.time}] ${x.stage} ${x.message} ${JSON.stringify(x.meta||{})}`).join('\n');$('output').textContent=report;}
$('refresh').onclick=()=>load().catch(e=>$('notice').textContent=e.message);
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText(report);$('notice').textContent='已複製，請貼到 ChatGPT';}catch(e){$('notice').textContent='複製失敗：'+e.message;}};
$('clear').onclick=async()=>{if(!confirm('確定清除診斷紀錄？不會刪除錄音或聊天室。'))return;await chrome.runtime.sendMessage({type:'CLEAR_DIAGNOSTICS'});await load();};
load().catch(e=>$('notice').textContent=e.message);
