(() => {
  if(window.__ytTranslationUploaderVersion==='1.25.0')return;
  // 更新擴充套件時，避免同一個分頁殘留舊版接收器。
  if(window.__ytTranslationUploaderListener) chrome.runtime.onMessage.removeListener(window.__ytTranslationUploaderListener);
  window.__ytTranslationUploaderVersion='1.25.0';
  let busy=false;
  let activeTask=null;
  let runToken=0;
  const wait = ms=>new Promise(r=>setTimeout(r,ms));
  const ext = m=>chrome.runtime.sendMessage({...m,to:'offscreen'});
  const diag=(stage,message,taskId)=>chrome.runtime.sendMessage({type:'DIAG_LOG',stage,message,taskId}).catch(()=>{});
  const status=(id,ok,error='')=>chrome.runtime.sendMessage({type:'UPLOAD_STATUS',id,ok,error}).catch(()=>{});
  const visible=el=>Boolean(el && el.getClientRects().length);
  function editor() {
    // 選擇真正能編輯的輸入區，而不是已離開 DOM 的舊元素。
    const candidates=[...document.querySelectorAll('#prompt-textarea,[contenteditable="true"][data-placeholder],div[contenteditable="true"][role="textbox"],div[contenteditable="true"],textarea')]
      .filter(e=>visible(e) && (e.matches('textarea') || e.isContentEditable));
    return candidates.find(e=>e.id==='prompt-textarea') || candidates.find(e=>e.closest('form')) || candidates[0];
  }
  function readEditor(e) {
    if(!e)return '';
    if(e.matches('textarea,input'))return e.value||'';
    // ProseMirror 編輯器的外層可能包含附件晶片；只讀取可編輯的文字段落。
    // 使用 innerText 做備援，避免把附件名稱誤當作草稿文字。
    const paragraphs=[...e.children].filter(n=>n.matches?.('p'));
    if(paragraphs.length)return paragraphs.map(n=>n.innerText||n.textContent||'').join('\n');
    return e.innerText || e.textContent || '';
  }
  function canon(s) {
    // 僅忽略 DOM 換行與不可見空白的呈現差異，並保留全部實際文字字元。
    return String(s||'').normalize('NFC').replace(/[\s\u00a0\u200b\u200c\u200d\ufeff]+/g,'');
  }
  function promptMatches(e,text) {
    return !!e && canon(readEditor(e))===canon(text);
  }
  function sendButton() {
    return [...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="傳送訊息"],button[aria-label="Send message"],button[aria-label="傳送"],button[aria-label="送出"]')].find(visible);
  }
  function findFileInput() {
    return [...document.querySelectorAll('input[type="file"]')].find(e=>!e.disabled && (!e.accept || /audio|\*|webm|mp3|mpeg|m4a|video|\./i.test(e.accept)));
  }
  async function waitUntil(fn,timeout=15000) {
    const start=Date.now();
    while(Date.now()-start<timeout){const result=fn();if(result)return result;await wait(250);}
    throw new Error('等待 ChatGPT 介面逾時。');
  }
  async function getFile(id, filename) {
    const info=await ext({type:'GET_INFO',id});
    if(!info?.ok)throw new Error(info?.error||'找不到錄音資料');
    if(info.bytes>100*1024*1024)throw new Error('超過自動附檔 100 MB 的安全上限，請手動附加檔案。');
    const chunks=[];
    for(let offset=0;offset<info.bytes;) {
      const r=await ext({type:'CHUNK',id,offset,length:524288});
      if(!r?.ok||r.next<=offset)throw new Error(r?.error||'讀取錄音片段失敗');
      const binary=atob(r.data),arr=new Uint8Array(binary.length);
      for(let i=0;i<binary.length;i++)arr[i]=binary.charCodeAt(i);
      chunks.push(arr);offset=r.next;
    }
    return new File(chunks,filename,{type:info.mime||'audio/webm'});
  }
  function setPrompt(el,prompt) {
    el.focus();
    if(el.matches('textarea')) {
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(el,prompt);
      el.dispatchEvent(new Event('input',{bubbles:true}));
    } else {
      const sel=window.getSelection(),range=document.createRange();
      range.selectNodeContents(el);sel.removeAllRanges();sel.addRange(range);
      let inserted=false;
      try { inserted=document.execCommand('insertText',false,prompt); }catch(_){}
      if(!inserted) {
        el.replaceChildren(document.createTextNode(prompt));
        el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
      }
    }
  }
  function attachmentVisible(filename) {
    const name=filename.toLowerCase();
    // 只接受編輯區/附件區，避免對話歷史中同名檔案造成誤判。
    const regions=[...document.querySelectorAll('form,[data-testid="composer"],[data-testid="composer-footer"],#thread-bottom')].filter(visible);
    return regions.some(r=>r.textContent?.toLowerCase().includes(name) || [...r.querySelectorAll('[title],[aria-label]')].some(e=>[e.getAttribute('title'),e.getAttribute('aria-label')].some(s=>s?.toLowerCase().includes(name))));
  }
  function uploadBusy() {
    const roots=[...document.querySelectorAll('form,[data-testid="composer"],#thread-bottom')].filter(visible);
    return roots.some(root=>root.querySelector('[role="progressbar"], [aria-label*="Uploading"], [aria-label*="上傳中"], [data-testid*="upload-progress"]'));
  }
  async function execute(m) {
    // 不在已有文字或附件的聊天室中覆蓋使用者草稿。
    await diag('PAGE','waiting for editor',m.id);
    const edit=await waitUntil(editor,20000);
    await diag('PAGE','editor found',m.id);
    if(typeof m.prompt!=='string'||!m.prompt.trim())throw new Error('翻譯提示詞為空，已停止自動送出。');
    const promptText=m.prompt;
    const existingBefore=readEditor(edit).trim();
    // 上次附檔失敗可能留下同一份提示詞；這不是使用者的其他草稿。
    if(existingBefore && !promptMatches(edit,promptText))
      throw new Error('聊天室有其他未送出的文字，為避免覆蓋，已取消自動送出。');
    if(existingBefore)await diag('PROMPT_REUSE','pre-existing exact prompt preserved',m.id);
    await diag('PAGE','reading audio from local storage',m.id);
    const file=await getFile(m.id,m.filename);
    await diag('PAGE','audio loaded: '+file.size+' bytes',m.id);
    let input=findFileInput();
    if(!input) {
      // ChatGPT 有時在開啟附件選單後才建立 input[type=file]。
      const attach=[...document.querySelectorAll('button')].find(b=>visible(b)&&/attach|add files|upload|附件|新增檔案|附加/i.test([b.getAttribute('aria-label'),b.getAttribute('title'),b.textContent].join(' ')));
      attach?.click();
      input=await waitUntil(findFileInput,9000);
    }
    await diag('PAGE','file input found, attaching',m.id);
    const dt=new DataTransfer();dt.items.add(file);
    input.files=dt.files;
    input.dispatchEvent(new Event('change',{bubbles:true}));
    // 必須先確認附件上傳完成，再填入文字並送出。
    let stableSince=0,ready=false;
    for(let elapsed=0;elapsed<45000;elapsed+=250){
      await wait(250);
      if(attachmentVisible(m.filename) && !uploadBusy()) {
        if(!stableSince)stableSince=Date.now();
        if(Date.now()-stableSince>=750){ready=true;break;}
      } else stableSince=0;
    }
    await diag('PAGE',ready?'attachment ready':'attachment confirmation timed out',m.id);
    if(!ready)throw new Error('無法確認音檔附件已上傳完成，為避免誤送，請在 ChatGPT 手動檢查後送出。');
    // 附檔後 ChatGPT 可能重建輸入框，或保留上次重試留下的完整提示詞。
    let activeEditor=await waitUntil(editor,12000);
    let verified=promptMatches(activeEditor,promptText);
    let after=readEditor(activeEditor).trim();
    await diag('PROMPT_CHECK',`after attachment: editor=${activeEditor.tagName.toLowerCase()} id=${activeEditor.id||'-'} length=${canon(after).length} exact=${verified}`,m.id);
    if(after && !verified){
      // 不覆蓋其他草稿，不因為文字已存在就無條件重試。
      throw new Error('附件完成後輸入框已有不同的草稿，已保留原內容；請檢查聊天室或清除草稿再重試。');
    }
    if(verified){
      await diag('PROMPT_REUSE','identical prompt already present; skipping insertion',m.id);
    }else{
      for(let attempt=1;attempt<=4;attempt++){
        activeEditor=await waitUntil(editor,6000);
        if(promptMatches(activeEditor,promptText)){verified=true;break;}
        const current=readEditor(activeEditor).trim();
        if(current){
          await diag('PROMPT_CHECK',`unexpected draft before attempt ${attempt}: length=${canon(current).length}`,m.id);
          break;
        }
        setPrompt(activeEditor,promptText);
        await wait(400);
        activeEditor=await waitUntil(editor,6000);
        verified=promptMatches(activeEditor,promptText);
        await diag('PROMPT_CHECK',`attempt ${attempt}: expected=${canon(promptText).length} actual=${canon(readEditor(activeEditor)).length} exact=${verified}`,m.id);
        if(verified)break;
        if(readEditor(activeEditor).trim())break;
      }
    }
    if(!verified)throw new Error('提示詞沒有成功寫入編輯器，已保留附件並取消自動送出。請檢視 PROMPT_CHECK 診斷紀錄。');
    await diag('PAGE','full prompt verified: '+promptText.length+' chars',m.id);
    const btn=await waitUntil(()=>{
      const e=editor(),b=sendButton();
      return e && promptMatches(e,promptText) && b && !b.disabled && b.getAttribute('aria-disabled')!=='true' && !uploadBusy() ? b : null;
    },8000);
    if(!promptMatches(editor(),promptText) || !attachmentVisible(m.filename)||uploadBusy())
      throw new Error('送出前檢查失敗：提示詞或附件狀態已變更，已停止送出。');
    await diag('PAGE','click send button',m.id);
    const beforeResponses=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
    const assistantBefore=beforeResponses.length;
    const lastAssistantBefore=beforeResponses.at(-1);
    const lastAssistantTextBefore=(lastAssistantBefore?.innerText||'').trim();
    // Register a durable monitor BEFORE clicking send, so background watches survive
    // navigation/reload and can recognize the reply even if the content script stops.
    const baselineAck=await chrome.runtime.sendMessage({type:'TRANSLATION_BASELINE',id:m.id,baseline:{count:assistantBefore,text:lastAssistantTextBefore}});
    if(!baselineAck?.ok)await diag('COMPLETION_WATCH','background baseline registration unavailable',m.id);
    btn.click();
    await waitUntil(() => {
      const current=editor();
      const text=readEditor(current).trim();
      return current && !canon(text).includes(canon(promptText).slice(0,18));
    },8000).catch(()=>{throw new Error('已嘗試點擊送出，但無法確認提示詞已送出。請先檢查聊天室，避免重複傳送。');});
    // 不要在已點擊送出後持有 busy 鎖等待網址變更。
    // background.js 的 tabs.onUpdated 已負責持續記錄對話 URL。
    if(/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+/.test(location.href)) {
      chrome.runtime.sendMessage({type:'CHAT_CONVERSATION_URL',url:location.href}).catch(()=>{});
    }
    // 點擊不保證伺服器收到；狀態明確標示為已點擊送出而非翻譯成功。
    await diag('PAGE','send button accepted (editor cleared)',m.id);
    // 不延長上傳鎖；另外監看 ChatGPT 回覆完成，若無法確認就維持「已送出，等待翻譯」。
    monitorTranslationCompletion(m.id,assistantBefore,lastAssistantBefore,lastAssistantTextBefore).catch(e=>diag('TRANSLATION_MONITOR',e.message,m.id));
    return true;
  }
  // ChatGPT 可能在既有 assistant 節點中更新回覆，不能只比對節點數量。
  // 必須確實看到「送出後的新內容」，才允許宣告完成。
  async function monitorTranslationCompletion(id,assistantBefore,lastAssistantBefore,lastAssistantTextBefore){
    const deadline=Date.now()+15*60*1000;
    const startedAt=Date.now();
    let observed=false,seenAt=0,stableSince=0,lastSignature='',lastLog=0;
    await diag('TRANSLATION_MONITOR','started; assistant nodes before='+assistantBefore,id);
    while(Date.now()<deadline){
      await wait(1800);
      const responses=[...document.querySelectorAll('[data-message-author-role="assistant"]')];
      const last=responses.at(-1);
      const currentText=(last?.innerText||'').trim();
      const newNode=Boolean(last && (responses.length>assistantBefore || (lastAssistantBefore && last!==lastAssistantBefore)));
      const changedOldNode=Boolean(last && last===lastAssistantBefore && currentText && currentText!==lastAssistantTextBefore);
      if(!observed && (newNode || changedOldNode) && currentText){
        observed=true;seenAt=Date.now();lastSignature='';stableSince=0;
        await diag('TRANSLATION_MONITOR','new assistant content detected; nodes='+responses.length+' chars='+currentText.length,id);
      }
      if(!observed){
        if(Date.now()-lastLog>30000){lastLog=Date.now();await diag('TRANSLATION_MONITOR','waiting for new response; nodes='+responses.length+' baseline='+assistantBefore,id);}
        continue;
      }
      // 防止串流仍在進行時誤判。僅當新回覆文字穩定且無停止生成控制鈕時確認。
      const generating=!!document.querySelector('button[data-testid="stop-button"],button[aria-label*="Stop generating"],button[aria-label*="Stop streaming"],button[aria-label*="停止生成"],button[aria-label*="停止產生"],button[aria-label*="停止回應"]');
      const signature=responses.length+'|'+currentText;
      if(currentText && !generating && signature===lastSignature){
        if(!stableSince)stableSince=Date.now();
        if(Date.now()-stableSince>=9000 && Date.now()-seenAt>=12000){
          const ack=await chrome.runtime.sendMessage({type:'TRANSLATION_COMPLETE',id});
          await diag('TRANSLATION_MONITOR',ack?.ok?'completion acknowledged by background':'completion detected but background rejected update',id);
          if(ack?.ok)return;
          // 背景尚未切換到 sent，可再嘗試；不能無條件視為成功。
          stableSince=Date.now();
        }
      }else{stableSince=0;lastSignature=signature;}
      if(Date.now()-lastLog>30000){
        lastLog=Date.now();await diag('TRANSLATION_MONITOR','response seen; chars='+currentText.length+' generating='+generating+' stableMs='+ (stableSince?Date.now()-stableSince:0),id);
      }
    }
    await diag('TRANSLATION_MONITOR','timeout after '+Math.round((Date.now()-startedAt)/1000)+'s; observed='+observed,id);
  }

  async function sendChatText(m){
    const content=String(m.prompt||'').trim();
    if(!content)throw Error('聊天室翻譯文字為空。');
    await diag('LIVE_CHAT','waiting for composer',m.id);
    let el=await waitUntil(editor,20000);
    const existing=readEditor(el).trim();
    if(existing && !promptMatches(el,content))throw Error('ChatGPT 聊天室有未送出的草稿，已停止以避免覆蓋。');
    if(!promptMatches(el,content))setPrompt(el,content);
    el=await waitUntil(editor,8000);
    if(!promptMatches(el,content))throw Error('無法確認聊天室翻譯提示詞已完整填入。');
    const b=await waitUntil(()=>{const button=sendButton();return button&&!button.disabled?button:null;},8000);
    b.click();
    await waitUntil(()=>!promptMatches(editor(),content),8000);
    if(/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+/.test(location.href))chrome.runtime.sendMessage({type:'CHAT_CONVERSATION_URL',url:location.href}).catch(()=>{});
    await diag('LIVE_CHAT','clicked send for latest chat translation',m.id);
  }

  const messageListener=(m,sender,reply)=>{
    if(m.type==='YT_TRANSLATOR_PING'){reply({ok:true,version:chrome.runtime.getManifest().version,busy});return false;}
    if(m.type==='YT_TRANSLATOR_PREFLIGHT'){
      const e=editor();const draft=readEditor(e).trim();
      const route=location.pathname;
      const blocked=!e || !!document.querySelector('input[type="password"]') || (/\/auth\/|\/login|\/signup/.test(route));
      const stop=!!document.querySelector('button[data-testid="stop-button"]');
      reply(blocked?{ok:false,error:'ChatGPT 尚未登入或輸入框尚未就緒。'}:busy?{ok:false,error:'ChatGPT 仍在處理另一筆傳送。'}:stop?{ok:false,error:'ChatGPT 正在產生回覆，請完成後重試。'}:draft?{ok:false,error:'ChatGPT 聊天室有未送出的草稿，請先處理再傳送。'}:{ok:true});
      return false;
    }
    if(m.type!=='TRANSLATE_AUDIO' && m.type!=='SEND_LIVE_CHAT_TEXT')return false;
    if(busy){reply({ok:false,error:'busy'});return false;}
    busy=true;activeTask=m.id;const token=++runToken;reply({ok:true});
    (async()=>{
      try {if(m.type==='SEND_LIVE_CHAT_TEXT') await sendChatText(m); else await execute(m); await status(m.id,true);}
      catch(e){ await diag('PAGE_ERROR',e.message||String(e),m.id); await status(m.id,false,e.message||String(e)); }
      finally {if(token===runToken){busy=false;activeTask=null;}}
    })();
    return false;
  };
  window.__ytTranslationUploaderListener=messageListener;
  chrome.runtime.onMessage.addListener(messageListener);
})();
