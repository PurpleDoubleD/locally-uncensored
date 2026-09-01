/*@@LU_TOOLING_ONLY@@*/
// Not part of the page. `src-tauri/build.rs` cuts this block out before the
// file becomes the <script> a phone runs, and splices the three modules in
// at the three //@@LU_…@@ marker lines below — the result is byte for byte
// what this file used to be as a Rust string.
//
// The block is here so tsc, eslint and an editor resolve the same names the
// browser resolves. Take a name off a module's export list and this import
// goes red before the page ever ships.
import { CAVEMAN_PROMPTS, CAVEMAN_REMINDERS } from './caveman.js'
import {
  CODEX_PROMPT,
  PERSONAS,
  THINKING_COMPATIBLE,
  isPlainTextPlanner,
  stripNonCanonicalTags,
} from './personas.js'
import {
  AGENT_ALL_TOOLS,
  AGENT_TOOLS,
  CODEX_TOOLS,
  DECAY_RESULT_CHARS,
  RESTORE_RESULT_CHARS,
  buildToolDefs,
  capToolResult,
  compactApiMessages,
  decayToolResults,
  extractToolCallsFromContent,
  isDecayedAt,
  isSystemPromptEcho,
  repairToolCallArgs,
  stripRanges,
  stripThinkTags,
} from './agent-core.js'
/*@@LU_END@@*/
(function(){
  var TOKEN = localStorage.getItem('lu-remote-token');
  // #73 (ossobucco): the server slides the session — when any authed request
  // comes back with a fresh token header, adopt it so an actively used /
  // open session never hits the 60-minute JWT cliff. The Set-Cookie on the
  // same response keeps /comfyui asset loads working too.
  function absorbRefresh(r){
    try{
      var t = r && r.headers && r.headers.get ? r.headers.get('x-lu-refreshed-token') : null;
      if(t){ TOKEN = t; localStorage.setItem('lu-remote-token', t); }
    }catch(_){}
    return r;
  }
  var currentModel = '';
  var dispatchedSystemPrompt = '';
  var availableModels = [];
  // The DESKTOP's platform sentence, handed over by /remote-api/config.
  // Never navigator.platform: the tools run on the machine that serves this
  // page, not on the phone holding it, so the phone's own OS is the one
  // answer that is always wrong here. Empty until config lands, and an empty
  // line is simply left out rather than guessed at.
  var hostPlatformLine = '';

  // ── Inline SVG icons (Lucide-style). Replaces the Material Symbols
  //    font download to keep the mobile page free of third-party requests.
  var ICON_SVG_OPEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
  var ICON_SVG_CLOSE = '</svg>';
  var ICONS = {
    menu:'<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
    close:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    add:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
    check:'<polyline points="20 6 9 17 4 12"/>',
    expand_more:'<polyline points="6 9 12 15 18 9"/>',
    arrow_upward:'<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    attach_file:'<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66L9.41 17.41a2 2 0 01-2.83-2.83L15.07 6.1"/>',
    content_copy:'<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>',
    terminal:'<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    chat_bubble:'<path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>',
    logout:'<path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
    extension:'<path d="M20 12V8h-4a2 2 0 10-4 0H8v4a2 2 0 110 4v4h4a2 2 0 104 0h4v-4a2 2 0 110-4z"/>',
    auto_awesome:'<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z"/><path d="M19 13l.9 2.1L22 16l-2.1.9L19 19l-.9-2.1L16 16l2.1-.9z"/>',
    // Bug #7: redesigned thinking icon — proper Lucide Brain glyph (parity
    // with desktop ThinkingBlock.tsx which imports Brain from lucide-react).
    // The old psychology / psychology_alt SVGs looked like a half-drawn head;
    // the new Brain has two clear hemispheres so the meaning reads at 20px.
    brain:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    // Aliases — old call sites (psychology / psychology_alt) keep working
    // by mapping to the same Brain glyph so we don't have to rewrite every
    // string template that uses them. The redesign comment above stays
    // accurate: there is now exactly one mental-icon shape on mobile.
    psychology:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    psychology_alt:'<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/><path d="M9 13a4.5 4.5 0 0 0 3-4 4.5 4.5 0 0 0 3 4"/>',
    // smart_toy = our agent icon (kept across all states — see Bug #6).
    smart_toy:'<rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/><circle cx="8.5" cy="16" r="1" fill="currentColor"/><circle cx="15.5" cy="16" r="1" fill="currentColor"/>',
    stop:'<rect x="6" y="6" width="12" height="12" rx="1"/>',
    pencil:'<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/>',
    refresh:'<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10"/><path d="M20.49 15A9 9 0 015.64 18.36L1 14"/>',
    tune:'<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
    trash:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>',
    delete_sweep:'<polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 01-2 2H9a2 2 0 01-2-2L5 6"/>',
    // Feature #8: HTML preview chip glyphs.
    play_arrow:'<polygon points="6 3 20 12 6 21 6 3" fill="currentColor"/>',
    open_in_new:'<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    code_brackets:'<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    eye:'<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
  };
  function svgIcon(name){return ICONS[name] ? ICON_SVG_OPEN + ICONS[name] + ICON_SVG_CLOSE : '';}
  // Expose for inline handlers (rare path, but keeps symmetry with prev API)
  window._svgIcon = svgIcon;

  // ── Das Hauszeichen ──
  //
  // Zeigt den <symbol id="lu-monogram"> aus index.html. Bis 01.09.2026 stand
  // an den vier Stellen darunter je ein <img src="/LU-monogram-white.png"> —
  // dieselbe 512x512-Bitmap, heruntergerechnet auf 18, 22, 64 und 82 Pixel,
  // waehrend die Desktop-App laengst public/LU-monogram.svg zeigte (0b9c0f66).
  //
  // Warum <use> und kein <img src="/LU-monogram.svg">: der Remote-Server
  // liefert keine Dateien aus mobile-client/ aus. Er baut EINE Seite
  // (src-tauri/src/mobile_page.rs) und hielt daneben bis KF-33 genau eine Bildroute (jetzt keine),
  // `/LU-monogram-white.png`. Ein SVG-Pfad waere ein 404 gewesen. Inline
  // gebraucht die Seite gar keine Route mehr.
  //
  // `label` leer heisst dekorativ: das Zeichen steht dann neben einer
  // Textmarke, die dasselbe schon sagt, und wird ausgeblendet statt doppelt
  // vorgelesen.
  function monogram(cls, label){
    var a11y = label ? 'role="img" aria-label="' + label + '"' : 'aria-hidden="true"';
    return '<svg class="' + cls + '" ' + a11y + ' focusable="false"><use href="#lu-monogram"/></svg>';
  }

  //@@LU_CAVEMAN@@

  // Cached copy of the desktop's RemotePermissions (filesystem / downloads /
  // process_control). Read-only: loaded from /remote-api/permissions on
  // demand and displayed. The server ignores a permissions POST from a paired
  // device, so there is nothing to write back. Sampling knobs (temperature
  // etc.) are NOT exposed here — user explicitly asked for permissions only.
  var remotePerms = { filesystem: false, downloads: false, process_control: false };

  //@@LU_PERSONAS@@

  // ── Runtime state ──
  var chats = [];
  var currentChatId = '';
  var msgs = [];
  var streaming = false;
  var abortCtrl = null;
  var pendingImages = []; // [{data: base64, mimeType, name}]
  // Thinking toggle removed from mobile — see renderShell() comment.
  // Hardcoded false so every "is thinking on?" call site sees the same
  // answer and the stripper drops reasoning tokens silently.
  var thinking = false;
  var drawerOpen = false;
  // Agent mode is per-chat; toggled via the brain icon next to Plugins.
  // When active, _doSend runs the ReAct loop instead of plain chat.
  var agentRunning = false;
  var agentAbort = false;

  //@@LU_AGENT_CORE@@

  // Non-streaming POST to /api/chat with native `tools` array.
  // Returns a Promise that resolves to {content, thinking, toolCalls}.
  // `apiMessages` = [{role, content, ...}], `tools` = Ollama tool defs.
  function nativeToolChat(apiMessages, tools){
    var body = {
      model: currentModel,
      messages: apiMessages,
      tools: tools,
      stream: false,
      // v2.4.6 Bug L: dropped hardcoded num_gpu:99 (forced all layers to GPU,
      // killed 8 GB-VRAM laptop chat speed). Ollama auto-decides layer count.
      options: {num_predict: 16384}
    };
    // Tri-state think flag — same logic as _doSend.
    if(isThinkingCompatible(currentModel)){
      if(thinking){
        body.think = true;
      } else if(!isPlainTextPlanner(currentModel)){
        body.think = false;
      }
    }

    function doPost(b){
      return fetch('/api/chat',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body: JSON.stringify(b),
        signal: abortCtrl ? abortCtrl.signal : undefined
      }).then(absorbRefresh);
    }

    return doPost(body).then(function(r){
      if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
      if(!r.ok){
        if(r.status===400 && ('think' in body)){
          var retry = {}; for(var k in body) retry[k]=body[k]; delete retry.think;
          return doPost(retry).then(function(rr){
            if(!rr.ok) return rr.text().then(function(t){throw new Error('HTTP '+rr.status+': '+t);});
            return rr.json();
          });
        }
        return r.text().then(function(t){
          // Detect "model does not support tools" errors
          if(t.indexOf('does not support tools') >= 0 || t.indexOf('does not support tool') >= 0){
            throw new Error('TOOLS_NOT_SUPPORTED');
          }
          throw new Error('HTTP '+r.status+': '+t);
        });
      }
      return r.json();
    }).then(function(data){
      var msg = data.message || {};
      var rawContent = msg.content || '';
      var rawThinking = msg.thinking || '';
      var toolCalls = [];
      if(Array.isArray(msg.tool_calls)){
        for(var i=0;i<msg.tool_calls.length;i++){
          var tc = msg.tool_calls[i];
          if(tc && tc.function){
            // repairToolCallArgs handles the case where Ollama returns
            // `arguments` as a JSON-stringified blob — without this the
            // mobile agent saw `{}` and the Rust handler errored out
            // with "file_write needs argument".
            toolCalls.push({function:{name:tc.function.name, arguments:repairToolCallArgs(tc.function.arguments)}});
          }
        }
      }
      return {content: rawContent, thinking: rawThinking, toolCalls: toolCalls};
    });
  }

  // Run a single tool against the desktop via /remote-api/agent-tool.
  // Returns a stringified observation suitable for the next loop turn.
  // The Rust bridge returns 200 OK with {error:"..."} for every failure
  // (missing arg, permission, underlying tool error). We surface those
  // as clean observations instead of "HTTP 500: ..." red errors.
  function runAgentTool(tool, args){
    // todo_write never leaves the browser: it writes the plan strip and nothing
    // else. Sending it to the desktop bridge would need a Rust dispatcher and a
    // permission gate for something that touches no file and no process, and it
    // would put a network round trip in front of a UI update.
    if(tool === 'todo_write'){
      return Promise.resolve(applyTodoWrite(args && args.todos));
    }
    return fetch('/remote-api/agent-tool',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      // `chatId` → per-chat workspace on the desktop side. Each mobile
      // chat gets its own isolated `~/agent-workspace/<chatId>/` folder
      // so agents across chats don't trample each other's files.
      body: JSON.stringify({tool:tool, args:args||{}, chatId: currentChatId || ''})
    }).then(absorbRefresh).then(function(r){
      if(r.status===401){ clearAuthAndReload(); return 'Auth required'; }
      return r.text().then(function(text){
        // Try to parse JSON regardless of status — the new bridge always
        // responds with a JSON body.
        var data = null;
        try{ data = JSON.parse(text); }catch(_){ /* leave null */ }

        // Old-style HTTP errors (e.g. 400 from a malformed payload) — fall
        // back to plain text so the agent still sees something useful.
        if(!r.ok && !data){ return 'Error '+r.status+': '+text; }

        if(data){
          // Surface permission-denied with an actionable hint to enable it.
          if(data.needs_permission){
            // Give the user a one-tap path: bump the header plugins icon
            // pulse so they know to open Settings → Permissions.
            try{ window._flagPermissionGap && window._flagPermissionGap(data.permission); }catch(_){}
            return 'Permission denied: '+data.error;
          }
          // Generic tool error — clean observation.
          if(typeof data.error === 'string') return 'Error: '+data.error;
          if(typeof data === 'string') return data;
          // web_search returns {results:[{title,url,snippet},...]}
          if(Array.isArray(data.results)){
            if(!data.results.length) return 'No results.';
            return data.results.map(function(it,i){return (i+1)+'. '+(it.title||'')+'\n   '+(it.url||'')+'\n   '+(it.snippet||'');}).join('\n\n');
          }
          // web_fetch returns {url, status, contentType, title, text, truncated}
          if(typeof data.text === 'string' && (data.url || data.status !== undefined)){
            var parts = [];
            if(data.title) parts.push('Title: '+data.title);
            if(data.url) parts.push('URL: '+data.url);
            if(data.status !== undefined) parts.push('Status: '+data.status);
            parts.push('');
            parts.push(data.text || '(empty body)');
            if(data.truncated) parts.push('\n…(truncated to 24 000 chars)');
            return parts.join('\n');
          }
          // file_read returns {content:"..."}
          if(typeof data.content === 'string') return data.content;
          // file_write returns {status:"saved", path:"..."}
          if(data.status==='saved') return 'File saved: '+(data.path||args.path||'');
          // code_execute / shell_execute returns {stdout, stderr, exitCode, timedOut}
          if(data.exitCode!==undefined || data.stdout!==undefined){
            var out = data.stdout || '';
            var err = data.stderr || '';
            if(data.timedOut) return 'Execution timed out.';
            if(data.exitCode && data.exitCode!==0) return 'Error ('+data.exitCode+'):\n'+(err||out);
            return out || (err ? 'stderr: '+err : 'Done.');
          }
          return JSON.stringify(data);
        }
        return text || 'Done.';
      });
    }).catch(function(e){ return 'Network error: '+(e && e.message || e); });
  }

  // Highlights the Settings (cog) icon in the drawer when an agent tool
  // got blocked by a permission. Best-effort — we just toggle a class so
  // the user notices the dot. No-op if the drawer isn't mounted yet.
  window._flagPermissionGap = function(_perm){
    var sb = document.querySelector('.settings-btn');
    if(sb){ sb.classList.add('perm-gap'); }
  };

  function H(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
  function el(id){return document.getElementById(id);}
  function uid(){return 'c-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mid(){return 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);}
  function mkMsg(role, content, extra){
    var m = {id: mid(), role: role, content: content||'', thinking:'', thinkingOpen:false, agentSteps:[]};
    if(extra && typeof extra === 'object'){ for(var k in extra) if(Object.prototype.hasOwnProperty.call(extra,k)) m[k]=extra[k]; }
    return m;
  }

  function isThinkingCompatible(modelName){
    if(!modelName) return false;
    var name = String(modelName).toLowerCase();
    var baseName = name.replace(/^[^/]+\//,'').replace(/:.*$/,'').replace(/-abliterated/g,'').replace(/-uncensored/g,'');
    for(var i=0;i<THINKING_COMPATIBLE.length;i++){
      if(baseName.indexOf(THINKING_COMPATIBLE[i])===0) return true;
    }
    return false;
  }

  // ── Persistence ──
  function loadPersisted(){
    try{
      chats = JSON.parse(localStorage.getItem('lu-mobile-chats')||'[]') || [];
      if(!Array.isArray(chats)) chats = [];
      // Backfill caveman/persona/agent defaults on legacy chats
      for(var i=0;i<chats.length;i++){
        if(!chats[i].caveman) chats[i].caveman = 'off';
        if(!chats[i].personaId) chats[i].personaId = 'unrestricted';
        if(typeof chats[i].personaEnabled === 'undefined') chats[i].personaEnabled = false;
        if(typeof chats[i].agentEnabled === 'undefined') chats[i].agentEnabled = false;
        // Backfill message ids + empty thinking/agentSteps on legacy msgs
        if(Array.isArray(chats[i].msgs)){
          for(var j=0;j<chats[i].msgs.length;j++){
            var mm = chats[i].msgs[j];
            if(!mm.id) mm.id = 'm-'+Date.now()+'-'+Math.random().toString(36).slice(2,7)+'-'+j;
            if(mm.thinking === undefined) mm.thinking = '';
            if(!Array.isArray(mm.agentSteps)) mm.agentSteps = [];
            if(typeof mm.thinkingOpen === 'undefined') mm.thinkingOpen = false;
          }
        }
      }
      currentChatId = localStorage.getItem('lu-mobile-current-chat') || '';
      // `thinking` is always false now (UI toggle removed).
      thinking = false;
    }catch(_){chats=[];currentChatId='';thinking=false;}
  }
  function persistChats(){
    try{localStorage.setItem('lu-mobile-chats', JSON.stringify(chats));}catch(_){}
  }
  function persistState(){
    try{
      localStorage.setItem('lu-mobile-current-chat', currentChatId);
    }catch(_){}
  }
  function getCaveman(){var c=findChat(currentChatId); return c && c.caveman ? c.caveman : 'off';}
  function getPersonaId(){var c=findChat(currentChatId); return c && c.personaId ? c.personaId : 'unrestricted';}
  function getPersonaEnabled(){var c=findChat(currentChatId); return !!(c && c.personaEnabled);}
  function getAgentEnabled(){var c=findChat(currentChatId); return !!(c && c.agentEnabled);}
  function setAgentEnabled(v){var c=findChat(currentChatId); if(c){ c.agentEnabled = !!v; persistChats(); }}

  // ── Chat management ──
  function findChat(id){for(var i=0;i<chats.length;i++){if(chats[i].id===id) return chats[i];}return null;}
  function syncCurrentChat(){
    var c = findChat(currentChatId); if(!c) return;
    c.msgs = msgs.slice();
    // Title auto-derive from first user message
    if((!c.title || c.title==='New Chat' || c.title==='New Code') && msgs.length){
      var firstUser = msgs.find(function(m){return m.role==='user';});
      if(firstUser){
        var t = firstUser.content.replace(/\s+/g,' ').trim().slice(0,32);
        if(t) c.title = t;
      }
    }
    persistChats();
  }
  function createChat(mode){
    var c = {id:uid(), title: mode==='codex'?'New Code':'New Chat', mode:mode||'lu', caveman:'off', personaId:'unrestricted', personaEnabled:false, agentEnabled:false, createdAt:Date.now(), msgs:[], model: currentModel||''};
    chats.unshift(c);
    currentChatId = c.id;
    msgs = [];
    pendingImages = [];
    persistChats();
    persistState();
    return c;
  }
  function loadChat(id){
    var c = findChat(id); if(!c) return;
    // Save outgoing first
    syncCurrentChat();
    currentChatId = id;
    msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    pendingImages = [];
    persistState();
  }
  function deleteChat(id){
    chats = chats.filter(function(c){return c.id!==id;});
    if(currentChatId===id){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); return; }
    }
    persistChats(); persistState();
  }
  function getCurrentMode(){
    var c = findChat(currentChatId);
    return c ? (c.mode||'lu') : 'lu';
  }

  // Aggressive AUTONOMY CONTRACT for the regular Agent toggle on mobile.
  // Without this, gemma4 / llama3 / qwen2.5-instruct routinely emit code
  // blocks in chat with "save this as index.html" instead of calling
  // file_write. Codex already had its own prompt; this matches the
  // strictness for the LU-mode + Agent-on path.
  var AGENT_PROMPT = 'You are an autonomous AI agent inside LU. You execute tasks end-to-end via tools — you do NOT just describe what to do.\n\n=== HARD RULES ===\n\n1. AFTER EVERY TOOL RESULT, your very next message MUST be EITHER (a) another tool call to continue the work, OR (b) the final user-facing summary. There is no middle ground. Empty messages are a FAILURE.\n\n2. DO NOT stop after the FIRST tool. Real tasks take 3-10 tool calls. If the user said "build X" you write the files. If the user said "use every tool" you keep going through every tool. Stopping after one shell_execute or one web_search without producing a useful artefact = FAILURE.\n\n3. NEVER produce a code block followed by "save this as X". That is FAILURE — call file_write yourself.\n\n4. NEVER say "Now I will create X" / "Next I will write Y" as plain prose and stop. Do the next step right now as a concrete tool call.\n\n5. The ONLY reasons to stop calling tools: (a) the user task is FULLY done with concrete artefacts on disk / web results returned / etc., OR (b) you are stuck in a way that genuinely needs user input. "I have called one tool, that should be enough" is NOT a valid stop reason.\n\n=== WORKFLOW ===\n\n- Build / create tasks: file_write each artefact directly, chain ALL writes, then write a 1-3 sentence final answer.\n- Read / explore tasks: file_list / file_read first, then proceed.\n- Web tasks: web_search → web_fetch on the best URL → summarize.\n- Multi-tool / "use every tool" tasks: plan the order, then call each tool one at a time, recording the partial result in a final summary file before the visible reply.\n\n=== FILE RULES ===\n\n- file_write AUTOMATICALLY creates missing parent directories — do NOT shell out to mkdir / New-Item / md / os.makedirs first. Just file_write the target path.\n- Relative paths resolve to the current chat workspace folder. Use relative paths (e.g. `index.html`, `src/app.py`); do not hard-code absolute drive letters.\n- After 2-3 failures of the same approach, switch strategy — do not repeat the same broken command. Do not introduce yourself again.\n\nBe concise in prose. All real work happens in tool calls. Respond in the same language the user used in their message.';

  // ── Clock line (2.6.6, plan A5) ──
  // The volatile half of the environment block. Word for word the desktop's
  // hostClockLine() in src/lib/host-platform.ts, because a relay that phrases
  // the date differently is a second prompt to keep in your head. Built fresh
  // on every turn, so a session that runs for hours does not quote the time
  // the page was opened.
  function hostClockLine(now){
    var tz = '';
    try{ tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; }catch(_){ }
    var stamp = (now || new Date()).toLocaleString('en-GB', {dateStyle:'full', timeStyle:'short'});
    return 'Date and time at the start of this run: ' + stamp + (tz ? ' (' + tz + ')' : '') +
           '. Trust this line; there is no clock tool.';
  }

  // ── System prompt builder ──
  function buildSystemPrompt(){
    var parts = [];
    var cm = getCaveman();
    if(cm!=='off' && CAVEMAN_PROMPTS[cm]) parts.push(CAVEMAN_PROMPTS[cm]);
    var isCodex = getCurrentMode()==='codex';
    var agentOn = getAgentEnabled();
    // ── Persona / dispatched prompt come FIRST, so the autonomy
    // contract is the LAST thing the model reads. Otherwise a persona
    // like "Devil's Advocate" appended after AGENT_PROMPT silently
    // overrides the tool-use rules and the model goes off-topic.
    var pid = getPersonaId();
    var p = PERSONAS.find(function(x){return x.id===pid;});
    if(getPersonaEnabled() && p && p.prompt){
      parts.push(p.prompt);
    } else if(dispatchedSystemPrompt && !agentOn && !isCodex){
      // Only apply the desktop-dispatched system prompt in plain chat
      // mode. In agent / codex mode any extra prompt fights with the
      // autonomy rules and breaks tool calling — David's "Devil's
      // Advocate hijack" repro. The desktop side now also defaults
      // personaEnabled to false, so dispatchedSystemPrompt should
      // typically be empty here anyway. Defense in depth.
      parts.push(dispatchedSystemPrompt);
    }
    // ── Autonomy contract LAST so HARD RULES dominate ──
    if(isCodex){
      parts.push(CODEX_PROMPT);
    } else if(agentOn){
      parts.push(AGENT_PROMPT);
    }
    // ── Environment block, on the two surfaces that own tools ──
    // Task 215: the relay ran its agent loop without ever saying which machine
    // it stands on, so a phone run on a Mac guessed `explorer` and burned a
    // step on `uname`. Plain chat has no tools and gets neither line.
    //
    // The split follows plan A5. The platform sentence reads the same on every
    // turn and rides in front, where a prefix cache can match it. The clock
    // changes every minute and closes the prompt, so a miss costs the last
    // line instead of everything above it.
    if(isCodex || agentOn){
      if(hostPlatformLine) parts.push(hostPlatformLine);
      parts.push(hostClockLine());
    }
    return parts.join('\n\n');
  }

  // ── Auth Screen ──
  if(!TOKEN){
    el('app').innerHTML =
      '<div class="auth-screen">' +
        monogram('auth-mark') +
        '<div class="auth-logo">LU</div>' +
        '<div class="auth-sub">Remote</div>' +
        '<form class="auth-form" id="auth-form">' +
          '<div>' +
            '<div class="auth-label">Access Code</div>' +
            '<input class="auth-input" id="auth-code" type="tel" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="off" autofocus>' +
          '</div>' +
          '<button class="auth-btn" type="submit">Connect</button>' +
          '<div class="auth-err" id="auth-err"></div>' +
        '</form>' +
      '</div>';
    el('auth-form').onsubmit = function(e){
      e.preventDefault();
      var code = el('auth-code').value.trim();
      var errEl = el('auth-err');
      if(code.length < 6){errEl.textContent='Enter 6-digit code';return;}
      errEl.textContent = '';
      fetch('/remote-api/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({passcode:code})})
      .then(function(r){
        if(r.ok) return r.json().then(function(d){localStorage.setItem('lu-remote-token',d.token);location.reload();});
        if(r.status===429) return r.text().then(function(t){errEl.textContent=t;});
        errEl.textContent='Invalid access code';
      })
      .catch(function(){errEl.textContent='Connection failed';});
    };
    return;
  }

  // ── Load config + models then render ──
  function clearAuthAndReload(){
    // #73: keep whatever the user had typed across the re-pairing round-trip.
    // The reload lands on the passcode view; the draft is restored after auth.
    try{
      var inp = document.getElementById('msg-input');
      if(inp && inp.value && inp.value.trim()) localStorage.setItem('lu-remote-draft', inp.value);
    }catch(_){}
    localStorage.removeItem('lu-remote-token');
    location.reload();
  }
  function authJson(url){
    return fetch(url,{headers:{'Authorization':'Bearer '+TOKEN}})
      .then(absorbRefresh)
      .then(function(r){
        if(r.status===401){clearAuthAndReload();throw new Error('401');}
        if(!r.ok) throw new Error('HTTP '+r.status);
        return r.json();
      })
      .catch(function(){return null;});
  }

  loadPersisted();

  // #73: restore a message that survived a re-pairing (stashed on 401 /
  // clearAuthAndReload). The composer is rendered asynchronously, so poll
  // briefly for it instead of racing the first render.
  (function(){
    var savedDraft = '';
    try{ savedDraft = localStorage.getItem('lu-remote-draft') || ''; }catch(_){}
    if(!savedDraft) return;
    try{ localStorage.removeItem('lu-remote-draft'); }catch(_){}
    var tries = 0;
    var timer = setInterval(function(){
      tries++;
      var inp = document.getElementById('msg-input');
      if(inp){
        if(!inp.value) inp.value = savedDraft;
        clearInterval(timer);
      } else if(tries > 40){
        clearInterval(timer);
      }
    }, 250);
  })();

  // #73: while the tab is open and visible, ping an authed endpoint every
  // 10 minutes. Each ping runs through the auth middleware, which slides the
  // token once it is past half its TTL — so a session stays alive as long as
  // the tab is actually kept open. A closed/backgrounded tab still expires
  // after the full 60 min and needs re-pairing (deliberate: this surface can
  // reach the whole bridge, an unbounded offline token would be worse).
  // A failed/401 ping stays silent — no surprise reload while reading; the
  // next real action shows the passcode view and the draft is preserved.
  setInterval(function(){
    if(document.visibilityState && document.visibilityState !== 'visible') return;
    fetch('/remote-api/status/full',{headers:{'Authorization':'Bearer '+TOKEN}})
      .then(absorbRefresh)
      .catch(function(){});
  }, 10*60*1000);

  // ── Keyboard / viewport tracking ────────────────────────────────
  // iOS Safari + some Android browsers do NOT resize `window.innerHeight`
  // when the software keyboard opens. The page sits at full height behind
  // the keyboard and the top of the chat scrolls off-screen. `dvh` CSS
  // units fix most cases; for the holdouts we sync an explicit
  // `--kb-height` custom prop and apply it as bottom-padding on the
  // input bar so it never hides behind the keyboard.
  (function setupViewportTracking(){
    if(typeof window.visualViewport === 'undefined') return;
    var vv = window.visualViewport;
    function sync(){
      // Height difference = keyboard + safe-area chrome on the bottom.
      var kb = Math.max(0, (window.innerHeight || 0) - vv.height - vv.offsetTop);
      document.documentElement.style.setProperty('--kb-height', kb + 'px');
      // Also pin the scroll position to the bottom of the current chat
      // when the keyboard animates in, so the latest message stays visible.
      var cm = document.getElementById('chat-msgs');
      if(cm && kb > 0){ cm.scrollTop = cm.scrollHeight; }
    }
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    sync();
  })();
  Promise.all([authJson('/remote-api/config'), authJson('/api/tags')]).then(function(res){
    var cfg = res[0] || {};
    var tags = res[1] || {};
    availableModels = (tags.models || [])
      .map(function(m){return m.name || m.model || '';})
      .filter(function(n){return !!n;});
    var stored = localStorage.getItem('lu-mobile-model') || '';
    currentModel = (stored && availableModels.indexOf(stored) >= 0) ? stored
                 : (cfg.model && availableModels.indexOf(cfg.model) >= 0) ? cfg.model
                 : (cfg.model || availableModels[0] || '');
    dispatchedSystemPrompt = cfg.systemPrompt || '';
    hostPlatformLine = cfg.platformLine || '';

    // Ensure we have a current chat
    if(!currentChatId || !findChat(currentChatId)){
      if(chats.length){ currentChatId = chats[0].id; msgs = Array.isArray(chats[0].msgs) ? chats[0].msgs.slice() : []; }
      else{ createChat('lu'); }
    }else{
      var c = findChat(currentChatId);
      msgs = Array.isArray(c.msgs) ? c.msgs.slice() : [];
    }

    renderShell();
  });

  function renderShell(){
    var mode = getCurrentMode();
    var isCodex = mode === 'codex';
    var modeTag = isCodex ? '<span class="header-mode-tag">Code</span>' :
                  (getAgentEnabled() ? '<span class="header-mode-tag">Agent</span>' : '');
    var pluginsActive = (getCaveman()!=='off' || getPersonaEnabled()) ? ' active' : '';
    var agentActive = getAgentEnabled() ? ' active' : '';
    // Agent icon STAYS smart_toy regardless of state. The button class
    // flips to `active` (purple) while running, click routes to _stopAgent.
    var agentClickHandler = agentRunning ? 'window._stopAgent()' : 'window._toggleAgent()';
    var agentLabel = agentRunning ? 'Stop agent' : 'Agent';
    var agentTitle = agentRunning ? 'Stop agent' : 'Agent mode (native tool calling)';
    var agentBtnCls = agentRunning ? 'active' : agentActive.trim();
    // Hidden in Codex chats (Codex on mobile is a coding-focused plain
    // chat, no phone-side tool execution).
    var agentBtn = isCodex ? '' :
      ('<button class="icon-btn '+agentBtnCls+'" id="agent-btn" onclick="'+agentClickHandler+'" aria-label="'+agentLabel+'" title="'+agentTitle+'">'+
         '<span class="material-symbols-outlined">'+svgIcon('smart_toy')+'</span>'+
       '</button>');

    // Thinking-toggle button REMOVED from mobile (user request): wasn't
    // working reliably and confused users. Thinking is now fully handled
    // under-the-hood: stripper silently drops any reasoning tokens regardless
    // of whether the model emitted canonical <think> or non-canonical tags.
    // The `thinking` variable stays as a constant `false` internally for the
    // few code paths that still reference it.

    el('app').innerHTML =
      '<div class="app-shell">' +
        '<div class="app-header">' +
          '<button class="icon-btn" onclick="window._toggleDrawer()" aria-label="Menu"><span class="material-symbols-outlined">'+svgIcon('menu')+'</span></button>' +
          '<span class="header-brand" aria-label="LU">' +
            monogram('header-mark', 'LU') +
          '</span>' +
          modeTag +
          '<button class="model-badge" onclick="window._openModelPicker()" aria-label="Select model">' +
            '<span class="material-symbols-outlined" style="font-size:13px">'+svgIcon('auto_awesome')+'</span>' +
            '<span class="model-name">'+H(currentModel || 'Select model')+'</span>' +
            '<span class="material-symbols-outlined chev">'+svgIcon('expand_more')+'</span>' +
          '</button>' +
          agentBtn +
          '<button class="icon-btn'+pluginsActive+'" id="plugins-btn" onclick="window._openPluginsPicker()" aria-label="Plugins">' +
            '<span class="material-symbols-outlined">'+svgIcon('extension')+'</span>' +
          '</button>' +
        '</div>' +
        '<div class="chat-area" id="chat-area"></div>' +
        '<div class="input-bar">' +
          '<div class="img-preview-row" id="img-preview-row" style="display:none"></div>' +
          '<div class="input-row">' +
            '<button class="attach-btn" id="attach-btn" onclick="window._triggerAttach()" aria-label="Attach file"><span class="material-symbols-outlined">'+svgIcon('attach_file')+'</span></button>' +
            '<input type="file" id="file-input" accept="image/*" multiple style="display:none">' +
            '<textarea id="msg-input" rows="1" placeholder="'+(getAgentEnabled()?'Give the agent a goal…':'Message...')+'"></textarea>' +
            // Send-Button flips to a red Stop chip while a response is
            // in flight (streaming chat OR native tool loop). Without
            // this the only "stop" control was hidden in the header,
            // which users kept missing. Single id so CSS + handler both
            // route to the right action.
            (function(){
              var busy = streaming || agentRunning;
              var btnCls = busy ? 'send-btn cancel' : 'send-btn';
              var handler = busy ? 'window._cancelSend()' : 'window._doSend()';
              var label = busy ? 'Stop' : 'Send';
              var icon = busy ? 'stop' : 'arrow_upward';
              return '<button class="'+btnCls+'" id="send-btn" onclick="'+handler+'" aria-label="'+label+'" title="'+label+'"><span class="material-symbols-outlined">'+svgIcon(icon)+'</span></button>';
            })() +
          '</div>' +
        '</div>' +
      '</div>' +
      renderDrawer();

    setupInput();
    setupFileInput();
    renderChat();
    renderAttachments();
  }

  // ── Drawer ──
  function renderDrawer(){
    var chatHtml = '';
    if(!chats.length){
      chatHtml = '<div class="chat-empty">No chats yet</div>';
    }else{
      for(var i=0;i<chats.length;i++){
        var c = chats[i];
        var isActive = c.id===currentChatId;
        var tag = c.mode==='codex' ? '<span class="chat-item-mode">code</span>' : '';
        var icon = c.mode==='codex' ? 'terminal' : 'chat_bubble';
        chatHtml += '<div class="chat-item'+(isActive?' active':'')+'" onclick="window._loadChat(\''+c.id+'\')">' +
                      '<span class="material-symbols-outlined">'+svgIcon(icon)+'</span>' +
                      '<span class="chat-item-title">'+H(c.title||'Untitled')+'</span>' +
                      tag +
                      '<button class="chat-item-del" onclick="event.stopPropagation();window._deleteChat(\''+c.id+'\')" aria-label="Delete"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
                    '</div>';
      }
    }

    return '<div class="drawer-backdrop'+(drawerOpen?' open':'')+'" onclick="window._toggleDrawer()"></div>' +
           '<aside class="drawer'+(drawerOpen?' open':'')+'">' +
             '<div class="drawer-header">' +
               '<span class="drawer-brand">' +
                 monogram('drawer-mark') +
                 '<span class="drawer-logo">LU</span>' +
               '</span>' +
               '<button class="drawer-close" onclick="window._toggleDrawer()" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
             '</div>' +
             '<div class="drawer-body">' +
               '<div class="new-row">' +
                 '<button class="new-btn primary" onclick="window._newChat(\'lu\')"><span class="material-symbols-outlined">'+svgIcon('add')+'</span>Chat</button>' +
                 '<button class="new-btn" onclick="window._newChat(\'codex\')"><span class="material-symbols-outlined">'+svgIcon('terminal')+'</span>Code</button>' +
               '</div>' +
               '<div class="section-label">Chats</div>' +
               chatHtml +
             '</div>' +
             '<div class="drawer-footer">' +
               '<button class="settings-btn" onclick="window._openSettingsSheet()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('tune')+'</span>Settings' +
               '</button>' +
               '<button class="disconnect-btn" onclick="window._disconnect()">' +
                 '<span class="material-symbols-outlined">'+svgIcon('logout')+'</span>Disconnect' +
               '</button>' +
             '</div>' +
           '</aside>';
  }

  // ── Model picker ──
  window._openModelPicker = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    var items = availableModels.length
      ? availableModels.map(function(name){
          var active = name === currentModel;
          return '<button class="picker-item'+(active?' active':'')+'" data-model="'+H(name)+'">' +
                   '<span>'+H(name)+'</span>' +
                   (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
                 '</button>';
        }).join('')
      : '<div class="picker-empty">No models found. Make sure your desktop backend is running with a model loaded.</div>';
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Select Model</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + items + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    var buttons = overlay.querySelectorAll('.picker-item[data-model]');
    for(var i=0;i<buttons.length;i++){
      buttons[i].onclick = function(){
        var name = this.getAttribute('data-model');
        if(name){
          currentModel = name;
          try{localStorage.setItem('lu-mobile-model', name);}catch(_){}
          renderShell();
        }
        document.body.removeChild(overlay);
      };
    }
  };

  function setupInput(){
    var inp = el('msg-input');
    if(!inp) return;
    inp.addEventListener('input', function(){inp.style.height='auto';inp.style.height=Math.min(inp.scrollHeight,220)+'px';});
    inp.addEventListener('keydown', function(e){if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();window._doSend();}});
  }

  function setupFileInput(){
    var input = el('file-input');
    if(!input) return;
    input.onchange = function(e){
      var files = e.target.files;
      if(!files || !files.length) return;
      addFiles(files);
      input.value = '';
    };
  }

  function addFiles(fileList){
    var imageFiles = [];
    for(var i=0;i<fileList.length;i++){
      if(fileList[i].type && fileList[i].type.indexOf('image/')===0) imageFiles.push(fileList[i]);
    }
    if(!imageFiles.length) return;
    var promises = imageFiles.map(function(f){
      return new Promise(function(resolve){
        var reader = new FileReader();
        reader.onload = function(){
          var dataUrl = reader.result;
          var base64 = String(dataUrl).split(',')[1] || '';
          resolve({data:base64, mimeType:f.type||'image/png', name:f.name||'image.png'});
        };
        reader.onerror = function(){resolve(null);};
        reader.readAsDataURL(f);
      });
    });
    Promise.all(promises).then(function(items){
      items = items.filter(Boolean);
      pendingImages = pendingImages.concat(items).slice(0, 5);
      renderAttachments();
    });
  }

  function renderAttachments(){
    var row = el('img-preview-row');
    if(!row) return;
    if(!pendingImages.length){ row.style.display='none'; row.innerHTML=''; return; }
    row.style.display='flex';
    var html = '';
    for(var i=0;i<pendingImages.length;i++){
      var im = pendingImages[i];
      html += '<div class="img-preview">' +
                '<img src="data:'+H(im.mimeType)+';base64,'+im.data+'" alt="">' +
                '<button class="img-preview-del" onclick="window._removeImage('+i+')" aria-label="Remove"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
              '</div>';
    }
    row.innerHTML = html;
  }

  // ── Plan strip (todo_write) ───────────────────────────────────
  // Mirrors the desktop PlanBar. On a phone this matters more than on the
  // desktop: the screen is small, the transcript scrolls away in three tool
  // calls, and the whole reason to watch a run from a phone is to know where it
  // is. Per chat, in memory only — a plan outlives neither the run nor a reload.
  var todosByChat = {};

  function applyTodoWrite(raw){
    var key = currentChatId || '';
    var out = [];
    if(Object.prototype.toString.call(raw) === '[object Array]'){
      for(var i=0;i<raw.length && out.length<40;i++){
        var e = raw[i];
        if(!e || typeof e !== 'object') continue;
        var content = typeof e.content === 'string' ? e.content.trim() : '';
        if(!content) continue;
        // Anything unrecognised counts as not started: a typo must never mark
        // work done that was never done. Same rule as the desktop store.
        var st = (e.status === 'completed' || e.status === 'in_progress') ? e.status : 'pending';
        out.push({content: content.slice(0,200), status: st});
      }
    }
    todosByChat[key] = out;
    renderChat();
    if(out.length === 0) return 'Plan cleared.';
    var done = 0, current = null, lines = [];
    for(var j=0;j<out.length;j++){
      if(out[j].status === 'completed') done++;
      if(out[j].status === 'in_progress' && !current) current = out[j].content;
      lines.push((out[j].status==='completed'?'[x] ':out[j].status==='in_progress'?'[>] ':'[ ] ')+out[j].content);
    }
    return 'Plan updated ('+done+'/'+out.length+' done'+(current?', now: '+current:'')+').\n'+lines.join('\n');
  }

  function renderPlanStrip(){
    var t = todosByChat[currentChatId || ''];
    if(!t || !t.length) return '';
    var done = 0, items = '';
    for(var i=0;i<t.length;i++){
      if(t[i].status === 'completed') done++;
      var mark = t[i].status==='completed' ? '&#10003;' : t[i].status==='in_progress' ? '&#9654;' : '&#9675;';
      items += '<div class="plan-item plan-'+t[i].status+'">'+mark+' '+H(t[i].content)+'</div>';
    }
    return '<div class="plan-strip"><div class="plan-head">PLAN '+done+'/'+t.length+'</div>'+items+'</div>';
  }

  function renderChat(){
    var p = el('chat-area');
    if(!p) return;
    if(!msgs.length){
      var mode = getCurrentMode();
      var tag = mode==='codex' ? 'Coding Agent'
              : getAgentEnabled() ? 'Agent Mode'
              : (currentModel ? 'Ready' : 'Select a model');
      p.innerHTML =
        '<div class="chat-welcome">' +
          monogram('chat-welcome-mark') +
          '<div class="chat-welcome-logo">LU</div>' +
          '<div class="chat-welcome-tag">'+H(tag)+'</div>' +
        '</div>';
      return;
    }
    var html = '<div class="chat-messages" id="chat-msgs">';
    html += renderPlanStrip();
    for(var i=0;i<msgs.length;i++){
      var m = msgs[i];
      // Skip hidden tool-call history (persisted for continue capability
      // but not user-visible). The model sees them on the next turn.
      if(m.hidden) continue;
      var isUser = m.role==='user';
      var isLast = i===msgs.length-1;
      var typingCls = (streaming && isLast && !isUser) ? ' msg-typing' : '';
      html += '<div class="msg-group '+(isUser?'user':'bot')+'" data-msg-idx="'+i+'">';
      if(isUser && Array.isArray(m.images) && m.images.length){
        html += '<div class="msg-imgs">';
        for(var ii=0; ii<m.images.length; ii++){
          var im = m.images[ii];
          html += '<img src="data:'+H(im.mimeType||'image/png')+';base64,'+im.data+'" alt="">';
        }
        html += '</div>';
      }
      // Thinking block never rendered on mobile — the toggle was removed
      // (user request: "thinking toggle im Mobile ersetzt / rausgenommen").
      // Any accidentally captured reasoning text lives in `m.thinking` but
      // is NOT shown; the stripper drops incoming reasoning bytes at the
      // source so `m.thinking` usually stays empty anyway.
      // Agent steps (transient, during / after a run). These stay visible
      // but they are NOT part of msg.content — so the next user turn does
      // not see the ReAct scaffolding and cannot drift into that style.
      // Collapsed by default. The active (last) step of a running agent
      // is auto-opened so the user sees live progress.
      if(!isUser && Array.isArray(m.agentSteps) && m.agentSteps.length){
        html += '<div class="agent-steps">';
        for(var si=0; si<m.agentSteps.length; si++){
          var st = m.agentSteps[si];
          var stIcon = st.type==='thought' ? 'brain'
                     : st.type==='action' ? 'smart_toy'
                     : st.type==='observation' ? 'check'
                     : st.type==='error' ? 'close'
                     : 'auto_awesome';
          var openCls = st.open ? ' open' : '';
          // Live = step is still in flight (model streaming its JSON, or
          // the tool hasn't returned yet). Triggers the pulsing stripe CSS.
          var liveCls = st.live ? ' live' : '';
          var summary = String(st.content||'').replace(/\s+/g,' ').slice(0, 80);
          if((st.content||'').length > 80) summary += '…';
          var stepKey = m.id + ':' + si;
          html += '<div class="agent-step agent-'+H(st.type||'info')+openCls+liveCls+'">' +
                    '<button class="agent-step-toggle" onclick="window._toggleAgentStep(\''+H(stepKey)+'\')">' +
                      '<span class="material-symbols-outlined agent-step-icon">'+svgIcon(stIcon)+'</span>' +
                      '<span class="agent-step-label">'+H(st.type||'info')+'</span>' +
                      '<span class="agent-step-summary">'+H(summary)+'</span>' +
                      '<span class="material-symbols-outlined agent-step-chev">'+svgIcon('expand_more')+'</span>' +
                    '</button>' +
                    '<div class="agent-step-content">'+renderMd(st.content||'')+'</div>' +
                  '</div>';
        }
        html += '</div>';
      }
      if(m.content || !isUser){
        html += '<div class="msg-bubble '+(isUser?'user':'bot')+typingCls+'">';
        html += isUser ? H(m.content) : renderMd(m.content);
        html += '</div>';
      }
      if(isUser){
        html += '<div class="msg-actions msg-actions-user">';
        html += '<button class="msg-action-btn" title="Edit" onclick="window._editMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('pencil')+'</span></button>';
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        html += '</div>';
      } else {
        html += '<div class="msg-model">'+H(currentModel)+'</div>';
        html += '<div class="msg-actions">';
        var canRegen = !streaming && !agentRunning;
        html += '<button class="msg-action-btn" title="Copy" onclick="window._copyMsg('+i+')"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span></button>';
        if(canRegen){
          html += '<button class="msg-action-btn" title="Regenerate" onclick="window._regenMsg(\''+m.id+'\')"><span class="material-symbols-outlined">'+svgIcon('refresh')+'</span></button>';
        }
        html += '</div>';
      }
      html += '</div>';
    }
    // 3-dot loading indicator — visible the whole time the model is
    // working (plain streaming OR native tool loop), parity with the
    // desktop TypingIndicator so users on mobile see the same "still
    // thinking" cue across iterations instead of staring at a frozen
    // chat. Hides as soon as `streaming` and `agentRunning` are both
    // false (= final answer landed or agent stopped).
    if(streaming || agentRunning){
      html += '<div class="typing-dots"><span></span><span></span><span></span></div>';
    }
    html += '</div>';
    p.innerHTML = html;
    var cm = el('chat-msgs');
    if(cm) cm.scrollTop = cm.scrollHeight;
  }

  // Persistent expand/collapse state for individual code blocks. Keyed by
  // a stable hash of (language + content) so the state survives re-renders
  // of the chat. Same hash is used for the HTML-preview blob lookup.
  var codeBlockOpen = {};
  // Cache of code payloads — Preview button reads from here without having
  // to re-extract from the rendered DOM. Keyed by the same djb2 hash.
  var codeBlockSource = {};

  function djb2(str){
    var h = 5381;
    for(var i=0;i<str.length;i++){ h = ((h << 5) + h) ^ str.charCodeAt(i); h |= 0; }
    // Force unsigned + base36 for short stable ID
    return (h >>> 0).toString(36);
  }
  // Heuristic: this code block IS a renderable HTML document.
  function isHtmlSnippet(lang, raw){
    var l = (lang || '').toLowerCase();
    if(l === 'html' || l === 'htm' || l === 'xhtml' || l === 'svg') return true;
    var t = raw.trim().toLowerCase();
    if(!t) return false;
    if(t.indexOf('<!doctype html') === 0) return true;
    if(t.indexOf('<html') === 0) return true;
    if(t.indexOf('<svg') === 0 && t.indexOf('xmlns') > 0) return true;
    return false;
  }
  // Bug #4 / Feature #8: code blocks are collapsed by default if longer
  // than COLLAPSE_THRESHOLD lines (parity with desktop CodeBlock.tsx).
  // Renderable HTML/SVG also gets a "Preview" chip → opens a sandboxed
  // iframe overlay in `_openHtmlPreview`.
  var COLLAPSE_THRESHOLD = 4;

  function renderMd(text){
    var s = H(text);
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, function(_, lang, code){
      var rawCode = code.replace(/\n$/, ''); // trim trailing newline
      var rawHtmlEscaped = H(rawCode);
      var lines = rawCode.split('\n');
      var lineCount = lines.length;
      var langLabel = (lang || 'code').toLowerCase();
      var key = djb2(langLabel + '\n' + rawCode);
      // Cache the original source so the Preview button can read it back.
      codeBlockSource[key] = { lang: langLabel, code: rawCode };
      var isLong = lineCount > COLLAPSE_THRESHOLD;
      var expanded = !isLong || codeBlockOpen[key] === true;
      var displayCode = expanded
        ? rawHtmlEscaped
        : H(lines.slice(0, COLLAPSE_THRESHOLD).join('\n'));
      var htmlPreview = isHtmlSnippet(langLabel, rawCode);
      var previewBtn = htmlPreview
        ? '<button class="cb-action" onclick="window._openHtmlPreview(\''+key+'\')" aria-label="Preview HTML"><span class="material-symbols-outlined">'+svgIcon('eye')+'</span><span class="cb-action-label">Preview</span></button>'
        : '';
      var toggleBtn = isLong
        ? '<button class="cb-toggle" onclick="window._toggleCodeBlock(\''+key+'\')"><span class="material-symbols-outlined cb-chev">'+svgIcon('expand_more')+'</span>'+(expanded?'Collapse':('Show all '+lineCount+' lines'))+'</button>'
        : '';
      return ''+
        '<div class="cb-wrap'+(expanded?' open':'')+'" data-cb-id="'+key+'">'+
          '<div class="cb-head">'+
            '<span class="cb-lang">'+H(langLabel)+'</span>'+
            '<div class="cb-actions">'+
              previewBtn +
              '<button class="cb-action" onclick="window._copyCodeKey(\''+key+'\')" aria-label="Copy"><span class="material-symbols-outlined">'+svgIcon('content_copy')+'</span><span class="cb-action-label">Copy</span></button>'+
            '</div>'+
          '</div>'+
          '<pre class="cb-pre"><code>'+displayCode+'</code></pre>'+
          toggleBtn +
        '</div>';
    });
    s = s.replace(/`([^`]+)`/g,'<code>$1</code>');
    s = s.replace(/\*\*(.+?)\*\*/g,'<b>$1</b>');
    return s;
  }

  // Toggle handler for the "Show all N lines" / "Collapse" button.
  window._toggleCodeBlock = function(key){
    codeBlockOpen[key] = !codeBlockOpen[key];
    renderChat();
  };
  // Copy handler that reads from our cache (no DOM scraping → handles
  // collapsed blocks correctly).
  window._copyCodeKey = function(key){
    var src = codeBlockSource[key];
    if(src && src.code) navigator.clipboard.writeText(src.code).catch(function(){});
  };
  // Feature #8: full-screen sandboxed HTML preview. Opens an iframe with
  // `srcdoc` + sandbox flags so user-supplied JS can't reach the parent
  // page. "Open in new tab" button hands the data: URL to the host
  // browser for full inspection. Tap backdrop or close icon to dismiss.
  window._openHtmlPreview = function(key){
    var src = codeBlockSource[key];
    if(!src) return;
    var raw = src.code || '';
    var lang = (src.lang || '').toLowerCase();
    var doc = raw;
    // Bare SVG → wrap so the iframe centres it.
    if(lang === 'svg' || (raw.trim().toLowerCase().indexOf('<svg') === 0 && raw.indexOf('xmlns') > 0)){
      doc = '<!doctype html><html><head><meta charset="utf-8"><title>SVG Preview</title>' +
            '<style>html,body{margin:0;padding:0;background:#0e0e0e;color:#ffffff;height:100%;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif}svg{max-width:100%;max-height:100%}</style>' +
            '</head><body>'+raw+'</body></html>';
    } else if(raw.trim().toLowerCase().indexOf('<!doctype') !== 0 &&
              raw.trim().toLowerCase().indexOf('<html') !== 0){
      // Snippet-only HTML → wrap in a minimal doc so meta-charset is set.
      doc = '<!doctype html><html><head><meta charset="utf-8"><title>HTML Preview</title>' +
            '<style>body{margin:0;padding:16px;font-family:system-ui,-apple-system,sans-serif}</style>' +
            '</head><body>'+raw+'</body></html>';
    }
    var overlay = document.createElement('div');
    overlay.className = 'html-preview-overlay';
    overlay.onclick = function(e){ if(e.target === overlay) document.body.removeChild(overlay); };
    var dataUrl = 'data:text/html;charset=utf-8;base64,' + btoa(unescape(encodeURIComponent(doc)));
    overlay.innerHTML =
      '<div class="html-preview-shell">' +
        '<div class="html-preview-header">' +
          '<span class="html-preview-title"><span class="material-symbols-outlined">'+svgIcon('eye')+'</span>HTML Preview</span>' +
          '<div class="html-preview-actions">' +
            '<button class="html-preview-action" id="hpv-open" aria-label="Open in new tab"><span class="material-symbols-outlined">'+svgIcon('open_in_new')+'</span></button>' +
            '<button class="html-preview-action" id="hpv-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
          '</div>' +
        '</div>' +
        '<iframe class="html-preview-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>' +
      '</div>';
    document.body.appendChild(overlay);
    var iframe = overlay.querySelector('.html-preview-frame');
    if(iframe){
      // srcdoc is the most reliable cross-mobile way to push HTML in
      // without escaping pain. Falls back to data URL if browser blocks.
      try{ iframe.srcdoc = doc; }
      catch(_){ iframe.src = dataUrl; }
    }
    var openBtn = overlay.querySelector('#hpv-open');
    if(openBtn) openBtn.onclick = function(){ window.open(dataUrl, '_blank'); };
    var closeBtn = overlay.querySelector('#hpv-close');
    if(closeBtn) closeBtn.onclick = function(){ document.body.removeChild(overlay); };
  };

  // ── Exposed handlers ──
  window._toggleDrawer = function(){
    drawerOpen = !drawerOpen;
    var d = document.querySelector('.drawer');
    var b = document.querySelector('.drawer-backdrop');
    if(d) d.classList.toggle('open', drawerOpen);
    if(b) b.classList.toggle('open', drawerOpen);
  };
  window._newChat = function(mode){
    syncCurrentChat();
    createChat(mode==='codex'?'codex':'lu');
    drawerOpen = false;
    renderShell();
  };
  window._loadChat = function(id){
    loadChat(id);
    drawerOpen = false;
    renderShell();
  };
  window._deleteChat = function(id){
    deleteChat(id);
    renderShell();
    var d=document.querySelector('.drawer'); if(d) d.classList.add('open');
    var bd=document.querySelector('.drawer-backdrop'); if(bd) bd.classList.add('open');
    drawerOpen = true;
  };
  // _toggleThinking removed — mobile has no thinking toggle anymore.
  // Kept as a no-op stub so stale handlers (any lingering cached page)
  // don't throw when clicked.
  window._toggleThinking = function(){};
  window._toggleAgent = function(){
    if(streaming || agentRunning) return;
    setAgentEnabled(!getAgentEnabled());
    renderShell();
  };
  window._stopAgent = function(){ agentAbort = true; };

  // Single-button cancel: stops whichever mode is currently running.
  // Streaming chat → abort the fetch. Agent loop → flip the agentAbort
  // flag so the next iteration bails cleanly. User can hit this from
  // the input-bar Send (which flips to Stop while busy) OR from the
  // header Agent icon (also flips to Stop while an agent is running).
  window._cancelSend = function(){
    if(streaming && abortCtrl){
      try{ abortCtrl.abort(); }catch(_){}
    }
    if(agentRunning){
      agentAbort = true;
    }
  };
  window._triggerAttach = function(){
    var f = el('file-input'); if(f) f.click();
  };
  window._removeImage = function(idx){
    pendingImages.splice(idx,1);
    renderAttachments();
  };
  window._setCaveman = function(lv){
    var c = findChat(currentChatId); if(c){ c.caveman = lv; persistChats(); }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  window._setPersona = function(id){
    var c = findChat(currentChatId);
    if(c){
      c.personaId = id;
      c.personaEnabled = true; // picking a persona turns it on
      persistChats();
    }
    updatePluginsPicker();
    updatePluginsHeaderBadge();
  };
  function updatePluginsHeaderBadge(){
    var btn = el('plugins-btn');
    if(!btn) return;
    if(getCaveman()!=='off' || getPersonaEnabled()) btn.classList.add('active');
    else btn.classList.remove('active');
  }
  function updatePluginsPicker(){
    var overlay = document.querySelector('.picker-overlay.plugins-picker');
    if(!overlay) return;
    overlay.querySelector('.picker-list').innerHTML = pluginsPickerBodyHtml();
    bindPluginsPicker(overlay);
  }
  // Each time the sheet opens, both sections start collapsed
  var pluginsOpen = {caveman:false, persona:false};
  function pluginsPickerBodyHtml(){
    var cm = getCaveman();
    var pid = getPersonaId();
    var penabled = getPersonaEnabled();
    var chips = ['off','lite','full','ultra'].map(function(lv){
      var label = lv==='off' ? 'Off' : lv.charAt(0).toUpperCase()+lv.slice(1);
      return '<button class="caveman-chip'+(cm===lv?' active':'')+'" data-caveman="'+lv+'">'+label+'</button>';
    }).join('');
    var personas = PERSONAS.map(function(p){
      var active = penabled && pid===p.id;
      return '<button class="picker-item'+(active?' active':'')+'" data-persona="'+H(p.id)+'">' +
               '<span>'+H(p.name)+'</span>' +
               (active ? '<span class="material-symbols-outlined">'+svgIcon('check')+'</span>' : '') +
             '</button>';
    }).join('');
    var cavemanLabel = cm==='off' ? '' : cm.charAt(0).toUpperCase()+cm.slice(1);
    var activePersona = PERSONAS.find(function(p){return p.id===pid;});
    var personaLabel = penabled && activePersona ? activePersona.name : '';

    return '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.caveman?' open':'')+'" data-toggle="caveman">' +
               '<span class="plug-name">Caveman Mode</span>' +
               (cavemanLabel ? '<span class="plug-value">'+H(cavemanLabel)+'</span>' : '') +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.caveman ? '<div class="caveman-row">'+chips+'</div>' : '') +
           '</div>' +
           '<div class="plug-folder">' +
             '<div class="plug-row'+(pluginsOpen.persona?' open':'')+'" data-toggle="persona">' +
               '<span class="plug-name">Persona</span>' +
               (personaLabel ? '<span class="plug-value">'+H(personaLabel)+'</span>' : '') +
               '<label class="plug-switch" onclick="event.stopPropagation()" aria-label="Toggle persona">' +
                 '<input type="checkbox" data-persona-enabled'+(penabled?' checked':'')+'>' +
                 '<span class="plug-switch-track"></span>' +
               '</label>' +
               '<span class="material-symbols-outlined plug-chev">'+svgIcon('expand_more')+'</span>' +
             '</div>' +
             (pluginsOpen.persona ? '<div class="plugins-persona-list">'+personas+'</div>' : '') +
           '</div>';
  }
  function bindPluginsPicker(overlay){
    var chips = overlay.querySelectorAll('.caveman-chip[data-caveman]');
    for(var i=0;i<chips.length;i++){
      chips[i].onclick = function(){ window._setCaveman(this.getAttribute('data-caveman')); };
    }
    var pitems = overlay.querySelectorAll('.picker-item[data-persona]');
    for(var j=0;j<pitems.length;j++){
      pitems[j].onclick = function(){ window._setPersona(this.getAttribute('data-persona')); };
    }
    var toggles = overlay.querySelectorAll('.plug-row[data-toggle]');
    for(var k=0;k<toggles.length;k++){
      toggles[k].onclick = function(){
        var key = this.getAttribute('data-toggle');
        pluginsOpen[key] = !pluginsOpen[key];
        updatePluginsPicker();
      };
    }
    var pswitch = overlay.querySelector('[data-persona-enabled]');
    if(pswitch){
      pswitch.onchange = function(){
        var c = findChat(currentChatId);
        if(c){
          c.personaEnabled = !!this.checked;
          // If enabling without a picked persona, auto-open the list so user can pick
          if(c.personaEnabled && c.personaId==='unrestricted'){ pluginsOpen.persona = true; }
          persistChats();
        }
        updatePluginsPicker();
        updatePluginsHeaderBadge();
      };
    }
  }
  window._openPluginsPicker = function(){
    pluginsOpen = {caveman:false, persona:false}; // always open collapsed
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay plugins-picker';
    overlay.onclick = function(e){if(e.target===overlay) document.body.removeChild(overlay);};
    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Plugins</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list">' + pluginsPickerBodyHtml() + '</div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){document.body.removeChild(overlay);};
    bindPluginsPicker(overlay);
  };

  // ── Settings sheet — Remote Permissions only ──
  // Mirrors the desktop's Settings → Remote Access → Permissions section.
  // READS /remote-api/permissions; it cannot write. Each row gates a category
  // of endpoints server-side (see proxy_ollama / proxy_comfyui in remote.rs),
  // and the server ignores a permissions POST from a paired device — a scope a
  // phone can grant itself is not a scope. The rows are shown anyway because
  // this is the only place the phone can see what it is allowed to do.
  var PERMISSION_META = [
    {key:'filesystem',      label:'Filesystem',       desc:'Agent can read/write files + run code on the desktop.'},
    {key:'downloads',       label:'Downloads',        desc:'Agent can trigger model pulls / installs (Ollama + ComfyUI).'},
    {key:'process_control', label:'Process Control',  desc:'Reach ComfyUI and Ollama on the desktop, and start or stop them.'}
  ];

  function fetchRemotePerms(){
    return fetch('/remote-api/permissions',{
      headers:{'Authorization':'Bearer '+TOKEN}
    }).then(absorbRefresh).then(function(r){
      if(r.status===401){ clearAuthAndReload(); throw new Error('401'); }
      if(!r.ok) throw new Error('HTTP '+r.status);
      return r.json();
    }).then(function(p){
      remotePerms = {
        filesystem: !!p.filesystem,
        downloads: !!p.downloads,
        process_control: !!p.process_control
      };
      return remotePerms;
    });
  }

  window._openSettingsSheet = function(){
    var overlay = document.createElement('div');
    overlay.className = 'picker-overlay';
    overlay.onclick = function(e){ if(e.target===overlay) document.body.removeChild(overlay); };

    function renderBody(){
      var rows = PERMISSION_META.map(function(m){
        var on = !!remotePerms[m.key];
        return '<label class="perm-row" data-key="'+m.key+'">' +
                 '<div class="perm-text">' +
                   '<div class="perm-label">'+H(m.label)+'</div>' +
                   '<div class="perm-desc">'+H(m.desc)+'</div>' +
                 '</div>' +
                 '<span class="plug-switch">' +
                   '<input type="checkbox" data-pk="'+m.key+'" disabled'+(on?' checked':'')+'>' +
                   '<span class="plug-switch-track"></span>' +
                 '</span>' +
               '</label>';
      }).join('');
      return '<div class="settings-section-label">Remote Permissions</div>' +
             '<div class="perm-note">What this session is allowed to do on the desktop. Set on the desktop, in Settings &rarr; Remote Access &mdash; a phone cannot grant itself access.</div>' +
             rows;
    }

    overlay.innerHTML =
      '<div class="picker-sheet">' +
        '<div class="picker-header">' +
          '<span class="picker-title">Settings</span>' +
          '<button class="picker-close" aria-label="Close"><span class="material-symbols-outlined">'+svgIcon('close')+'</span></button>' +
        '</div>' +
        '<div class="picker-list" id="settings-body"><div class="perm-loading">Loading…</div></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.querySelector('.picker-close').onclick = function(){ document.body.removeChild(overlay); };

    fetchRemotePerms().then(function(){
      var body = overlay.querySelector('#settings-body');
      if(!body) return;
      body.innerHTML = renderBody();
    }).catch(function(e){
      var body = overlay.querySelector('#settings-body');
      if(body) body.innerHTML = '<div class="perm-loading" style="color:var(--error)">Failed to load: '+H(String(e && e.message || e))+'</div>';
    });
  };

  window._copyMsg = function(idx){
    if(msgs[idx]) navigator.clipboard.writeText(msgs[idx].content).catch(function(){});
  };
  window._copyCode = function(btn){
    var pre = btn.parentElement;
    if(!pre) return;
    var code = pre.querySelector('code');
    if(code) navigator.clipboard.writeText(code.textContent).catch(function(){});
  };
  window._toggleThink = function(msgId){
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        msgs[i].thinkingOpen = !msgs[i].thinkingOpen;
        renderChat();
        return;
      }
    }
  };
  window._toggleAgentStep = function(stepKey){
    var parts = stepKey.split(':');
    if(parts.length < 2) return;
    var msgId = parts[0], idx = Number(parts[1]);
    for(var i=0;i<msgs.length;i++){
      if(msgs[i].id === msgId){
        if(Array.isArray(msgs[i].agentSteps) && msgs[i].agentSteps[idx]){
          msgs[i].agentSteps[idx].open = !msgs[i].agentSteps[idx].open;
          renderChat();
        }
        return;
      }
    }
  };
  // ── Regenerate: drop the given assistant msg + everything after, resend the preceding user msg.
  // Parity with desktop useChat.ts regenerateMessage().
  window._regenMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 1) return;
    var userMsg = msgs[idx-1];
    if(!userMsg || userMsg.role !== 'user') return;
    // Truncate to just-before-user, then replay the user text
    msgs.splice(idx-1);
    syncCurrentChat();
    renderChat();
    // Reuse the send path by re-injecting the user text.
    var input = el('msg-input'); if(input){ input.value = userMsg.content; window._doSend(); }
    else {
      // Fallback: manually push and dispatch
      var u = mkMsg('user', userMsg.content, userMsg.images ? {images: userMsg.images} : null);
      msgs.push(u); msgs.push(mkMsg('assistant',''));
      renderChat();
    }
  };
  // ── Edit: turn user bubble into inline textarea, save rewrites + resends from that point.
  // Parity with desktop useChat.ts editAndResend().
  window._editMsg = function(msgId){
    if(streaming || agentRunning) return;
    var idx = -1;
    for(var i=0;i<msgs.length;i++){ if(msgs[i].id === msgId){ idx = i; break; } }
    if(idx < 0 || msgs[idx].role !== 'user') return;
    var node = document.querySelector('.msg-group[data-msg-idx="'+idx+'"] .msg-bubble.user');
    if(!node) return;
    var original = msgs[idx].content;
    node.classList.add('editing');
    node.innerHTML =
      '<textarea class="msg-edit-area" id="msg-edit-ta">'+H(original)+'</textarea>' +
      '<div class="msg-edit-row">' +
        '<button class="msg-edit-btn" id="msg-edit-cancel">Cancel</button>' +
        '<button class="msg-edit-btn primary" id="msg-edit-save">Save &amp; Resend</button>' +
      '</div>';
    var ta = el('msg-edit-ta');
    if(ta){ ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
    el('msg-edit-cancel').onclick = function(){ renderChat(); };
    el('msg-edit-save').onclick = function(){
      var newVal = el('msg-edit-ta').value.trim();
      if(!newVal){ renderChat(); return; }
      // Drop this message and everything after, then resend with the new content.
      msgs.splice(idx);
      syncCurrentChat();
      renderChat();
      var inp = el('msg-input'); if(inp){ inp.value = newVal; window._doSend(); }
    };
  };
  window._disconnect = function(){
    localStorage.removeItem('lu-remote-token');
    location.reload();
  };

  // ── Mirror to desktop ──
  // LU mode       → appends to the desktop's dispatched Remote conversation.
  // Codex mode    → creates / appends to a desktop Codex conversation named
  //                 after the mobile chat title. That way "codex chat on
  //                 mobile must also show up in Codex in the app with
  //                 content" (user request).
  function postChatEvent(role, content){
    if(!content) return;
    // Safety filter: never mirror bare "Continue." to the desktop.
    // Legacy from the old ReAct loop; kept as defense in depth.
    if(role === 'user' && /^\s*continue\.?\s*$/i.test(content)) return;
    var c = findChat(currentChatId);
    if(!c) return;
    var mode = c.mode === 'codex' ? 'codex' : 'lu';
    try{
      fetch('/remote-api/chat-event',{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
        body:JSON.stringify({
          role:role,
          content:content,
          model:currentModel||'',
          mode:mode,
          chat_id:c.id||'',
          chat_title:c.title||''
        })
      }).catch(function(){});
    }catch(_){}
  }

  // ── Send ──
  window._doSend = function(){
    var inp = el('msg-input');
    var text = inp.value.trim();
    var hasImages = pendingImages.length > 0;
    if((!text && !hasImages) || streaming || agentRunning) return;
    if(!currentModel){window._openModelPicker();return;}

    var userMsg = mkMsg('user', text, hasImages ? {images: pendingImages.slice()} : null);
    msgs.push(userMsg);
    msgs.push(mkMsg('assistant', ''));

    inp.value='';inp.style.height='auto';
    pendingImages = [];
    renderAttachments();

    // Mirror user message to desktop (text only)
    postChatEvent('user', text);

    // Agent / Codex mode? Use native Ollama tool calling instead of
    // plain streaming chat. Codex chats ALWAYS run tools (no toggle),
    // matching desktop Codex which is agentic by design. Plain LU chats
    // only run tools when the user toggled Agent on in the header.
    var isCodexChat = getCurrentMode() === 'codex';
    if(getAgentEnabled() || isCodexChat){
      var toolNames = isCodexChat ? CODEX_TOOLS : AGENT_ALL_TOOLS;
      var sysPrompt = buildSystemPrompt();
      var kindLabel = isCodexChat ? 'Coding Agent' : 'Agent';
      runToolLoop(sysPrompt, toolNames, kindLabel);
      return;
    }

    streaming=true;
    // Re-render the input bar so the Send-Button flips to the red Stop
    // chip. Without this the user has no visible way to cancel a chat
    // that hangs on an over-eager thinking model.
    renderShell();
    renderChat();

    // Build API messages
    var apiMsgs = [];
    var sys = buildSystemPrompt();
    if(sys) apiMsgs.push({role:'system',content:sys});
    var cm = getCaveman();
    for(var i=0;i<msgs.length-1;i++){
      var m = msgs[i];
      var content = m.content;
      // Caveman per-message reminder — prepend on every user message.
      // Parity with desktop (useChat.ts line 142): the reminder fires
      // unconditionally so the model doesn't drift on turn 2+. Without
      // this, thinking-compatible models silently dropped Caveman style
      // after the first response (was: only !isThinkingCompatible).
      if(m.role==='user' && cm!=='off' && CAVEMAN_REMINDERS[cm]){
        content = CAVEMAN_REMINDERS[cm] + '\n' + content;
      }
      var apiMsg = {role:m.role, content:content};
      if(m.images && m.images.length){ apiMsg.images = m.images.map(function(im){return im.data;}); }
      apiMsgs.push(apiMsg);
    }

    // Token budget: 16 384 is a balance between "no truncation of the
    // assistant's visible message" (previous default of 4000 was too low)
    // and "don't let tagged-thinking models loop forever" (true `-1`
    // caused Gemma 3/4 to think without ever emitting an answer). 16 k is
    // enough for the longest reasonable agent reply plus deep thinking.
    // v2.4.6 Bug L: dropped num_gpu:99 — see nativeToolChat() comment above.
    var body = {model:currentModel, messages:apiMsgs, stream:true, options:{num_predict:16384}};
    // Tri-state: for thinking-capable models we normally send explicit
    // true|false. Explicit `false` tells Ollama to SKIP thinking (saves
    // tokens) instead of silently letting the model emit <think> tags we'd
    // then have to hide. Non-thinking models: omit the field entirely.
    //
    // Bug #80 parity: Gemma 3/4 with `think:false` drops into PLAIN-TEXT
    // structured planning ("Plan:" / "Constraint Checklist:" …) that no
    // tag-stripper can clean. For these models with the toggle OFF we
    // instead OMIT `think`, which makes Ollama emit tagged thinking that
    // our stripper handles cleanly. UX is the same (clean answer) — the
    // trade-off is hidden token spend on internal reasoning.
    if(isThinkingCompatible(currentModel)){
      if(thinking){
        body.think = true;
      } else if(!isPlainTextPlanner(currentModel)){
        body.think = false;
      }
      // else: leave body.think undefined → Ollama default = tagged thinking,
      // stripped at render time.
    }

    abortCtrl = new AbortController();
    fetch('/api/chat',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},
      body:JSON.stringify(body),
      signal:abortCtrl.signal
    })
    .then(absorbRefresh)
    .then(function(r){
      if(r.status===401){
        // #73: without this the reload swallowed the just-sent message —
        // stash it so it is back in the composer after re-pairing.
        try{
          var lastUser = null;
          for(var qi=msgs.length-1; qi>=0; qi--){ if(msgs[qi].role==='user'){ lastUser=msgs[qi].content; break; } }
          if(lastUser) localStorage.setItem('lu-remote-draft', lastUser);
        }catch(_){}
        clearAuthAndReload();
        return;
      }
      if(!r.ok){
        // Retry without the think field at all if the server rejects it
        // (old Ollama or model that refuses the flag).
        if(r.status===400 && ('think' in body)){
          delete body.think;
          return fetch('/api/chat',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+TOKEN},body:JSON.stringify(body),signal:abortCtrl.signal}).then(absorbRefresh).then(streamResponse);
        }
        msgs[msgs.length-1].content='Error: HTTP '+r.status;
        finishStream();
        return;
      }
      streamResponse(r);
    })
    .catch(function(ex){
      if(ex.name!=='AbortError') msgs[msgs.length-1].content='Connection error';
      finishStream();
    });
  };

  // ── Native tool-calling loop ─────────────────────────────────────
  //
  // Replaces the old ReAct JSON loop with Ollama's native /api/chat
  // `tools` parameter. The model returns structured `tool_calls[]`
  // instead of freeform JSON we had to parse. Reliability goes from
  // ~60% to ~99% because the model uses its trained tool-call format
  // instead of trying to emit valid JSON in its content.
  // Append a structured agent step to the current assistant message.
  // Steps render as small colored cards ABOVE the bubble; they are NOT
  // part of msg.content, so the next user turn does NOT see tool-call
  // scaffolding and the model cannot drift into that style.
  function appendAgentStep(type, content, meta){
    var idx = msgs.length-1;
    if(idx < 0 || msgs[idx].role !== 'assistant') return;
    if(!Array.isArray(msgs[idx].agentSteps)) msgs[idx].agentSteps = [];
    // ALL steps always start collapsed (user request). Pulsing CSS stripe
    // on `.live` rows shows in-flight status; the content itself stays
    // behind the chevron until the user taps to expand.
    for(var p=0; p<msgs[idx].agentSteps.length; p++){ msgs[idx].agentSteps[p].open = false; }
    var step = {type:type, content:content, ts:Date.now(), open:false, live:false};
    if(meta && typeof meta === 'object'){ for(var k in meta) if(Object.prototype.hasOwnProperty.call(meta,k)) step[k]=meta[k]; }
    msgs[idx].agentSteps.push(step);
    renderChat();
  }

  // ── Native tool-calling loop ──
  //
  // Uses Ollama's /api/chat with `tools` parameter (non-streaming,
  // stream:false). The model returns structured `tool_calls[]` that we
  // execute via the existing runAgentTool() bridge, then feed results
  // back as `role:'tool'` messages. Loop until the model responds with
  // no tool_calls (= final answer) or we hit maxIter.
  //
  // Why non-streaming? Ollama's tool calling requires stream:false to
  // return structured tool_calls[]. The trade-off vs the old streaming
  // ReAct loop: no live token-by-token display, but near-100% tool-call
  // reliability instead of ~60% JSON parse success.
  function runToolLoop(systemPrompt, toolNames, kindLabel){
    agentRunning = true;
    agentAbort = false;
    abortCtrl = new AbortController();
    renderShell(); // flips Send button to Stop
    renderChat();

    var maxIter = 50; // matches desktop v24 AgentBudget default
    var iter = 0;
    var target = msgs[msgs.length-1]; // the empty assistant slot
    var tools = buildToolDefs(toolNames);
    // Cap silent echo retries so a model fully wedged on the echo
    // can't burn the whole iteration budget on the same drift.
    var echoRetriesRemaining = 3;
    // Cap consecutive tool failures. Without this a model with broken
    // shell-syntax assumptions (e.g. `mkdir client public` on PowerShell)
    // can burn 50 iters cycling the same error before the iter cap kicks
    // in. Reset on every successful tool result.
    var consecutiveErrors = 0;
    var maxConsecutiveErrors = 5;
    // Stop-too-early nudges. Smaller models (gemma4:e4b confirmed) often
    // bail after 3 tool calls — their reply is non-empty ("How can I
    // help?") so the simple empty-content guard doesn't catch it. We
    // also push when (a) reply is empty, (b) reply asks for help, or
    // (c) user explicitly listed many tools but few were called.
    // Cap kept generous since a 13-tool task with gemma4 may need
    // 4-5 nudges to walk the full list.
    var stopRetriesRemaining = 8;

    // Build the LLM message history from the conversation.
    // Include system prompt + all msgs except the last empty assistant.
    // Hidden messages (tool-call history from previous turns) are included
    // so the model sees what it did before (continue capability, parity
    // with original Codex CLI).
    var apiMessages = [];
    var apiStartLen = 0; // track where loop-generated messages begin
    if(systemPrompt) apiMessages.push({role:'system', content:systemPrompt});
    var cm = getCaveman();
    for(var k=0; k<msgs.length-1; k++){
      var m = msgs[k];
      var content = m.content;
      if(m.role==='user' && cm!=='off' && CAVEMAN_REMINDERS[cm]){
        content = CAVEMAN_REMINDERS[cm] + '\n' + content;
      }
      // A restored tool result is a PREVIOUS turn's work, already summarised
      // by the answer the user can see, so it comes back tighter than the
      // in-run cap. One exception, and it is the stability rule: a result the
      // run already sent capped at 4k is restored at exactly those 4k bytes,
      // otherwise the same result would arrive with different bytes depending
      // on which turn asked for it.
      if(m.role === 'tool' && !isDecayedAt(content, DECAY_RESULT_CHARS)){
        content = capToolResult(content, RESTORE_RESULT_CHARS);
      }
      var apiMsg = {role: m.role, content: content};
      // Carry over tool_calls on assistant messages so Ollama sees the
      // full native tool-call history (assistant→tool pairs).
      if(m.tool_calls) apiMsg.tool_calls = m.tool_calls;
      if(m.images && m.images.length){ apiMsg.images = m.images.map(function(im){return im.data;}); }
      apiMessages.push(apiMsg);
    }

    apiStartLen = apiMessages.length; // everything after this was added during the loop

    // Show a "thinking" step while the first call is in flight
    appendAgentStep('thought', kindLabel+' is thinking...', {live:true});
    var thinkingStepIdx = (target.agentSteps || []).length - 1;

    function step(){
      if(agentAbort){
        appendAgentStep('error', kindLabel+' stopped by user.');
        finishToolLoop(null);
        return;
      }
      if(iter >= maxIter){
        appendAgentStep('error', kindLabel+' stopped: max iterations reached.');
        finishToolLoop(null);
        return;
      }
      iter++;

      // Decay first, then compaction, and the order is the point (plan A1). A
      // decayed history is what the budget check should be looking at;
      // measuring full results and then dropping whole messages throws away
      // old context that would have fitted at 4k.
      decayToolResults(apiMessages, iter);

      // Compaction — keeps Ollama from silently truncating the system
      // prompt + first user message after a few iterations of file reads
      // (the symptom: "I'm ready to receive the task" appearing mid-loop).
      // Conservative budget tuned to fit comfortably inside an 8K-token
      // context with room to spare for the model's reply.
      apiMessages = compactApiMessages(apiMessages, 24000);

      nativeToolChat(apiMessages, tools).then(function(res){
        // Remove the initial "thinking" placeholder on the first
        // successful response (only matters for iter === 1).
        if(thinkingStepIdx >= 0 && target.agentSteps && target.agentSteps[thinkingStepIdx]){
          target.agentSteps.splice(thinkingStepIdx, 1);
          thinkingStepIdx = -1;
          renderChat();
        }

        // Handle thinking content (native Ollama field + inline tags)
        var keepThinking = thinking && isThinkingCompatible(currentModel);
        var stripped = stripThinkTags(res.content, keepThinking);
        var turnContent = stripped.content;
        var turnThinking = stripped.thinking;
        // Also pick up the native thinking field from Ollama
        if(res.thinking){
          if(keepThinking){
            turnThinking = turnThinking ? turnThinking+'\n'+res.thinking : res.thinking;
          }
        }
        if(turnThinking && target){
          target.thinking = (target.thinking ? target.thinking+'\n' : '') + turnThinking;
        }

        // Fallback content-fence extractor — qwen2.5-coder + small Gemma
        // builds sometimes emit ```json {"name":"file_write",...} ```
        // INSIDE content instead of native tool_calls. Pull those out so
        // the loop continues rather than treating raw JSON as the final
        // answer.
        if((!res.toolCalls || res.toolCalls.length === 0) && turnContent){
          var pulled = extractToolCallsFromContent(turnContent, toolNames);
          if(pulled.calls.length){
            res.toolCalls = pulled.calls;
            turnContent = stripRanges(turnContent, pulled.ranges);
          }
        }

        // Silent retry on system-prompt echo. Without this the user
        // would see "Hello, I'm ready to assist…" after a tool error
        // mid-loop. Drop the content, push a synthetic nudge and let
        // the loop take another swing — same shape as the desktop
        // guard in useCodex.ts. Once retries are exhausted the echo
        // is replaced with an empty content so finishToolLoop builds
        // a step-summary instead of leaking the literal greeting to
        // the user (this was Bug 2 reported by David — after several
        // failures the model ended the turn with the greeting as the
        // final answer).
        if(isSystemPromptEcho(turnContent)){
          if(echoRetriesRemaining > 0){
            echoRetriesRemaining--;
            apiMessages.push({
              role: 'user',
              content: 'Continue the task. Do not introduce yourself again. Resume from the last successful step using the appropriate tool call.'
            });
            step();
            return;
          }
          // Retries spent — drop the echo. Falls through to the
          // "no toolCalls → finishToolLoop" path below, which builds
          // a clean fallback summary from the agent steps.
          turnContent = '';
        }

        // No tool calls → model is done, set final content.
        // #29 follow-up: previously we passed `'(done)'` as the fallback
        // when the model emitted no closing prose. That literal string
        // bypassed finishToolLoop()'s summary builder (which only kicks
        // in when finalAnswer is falsy), so the user saw the bubble
        // contain just `(done)` instead of a real summary like "Task
        // completed: 3 file(s) written.". Pass null so the summary
        // path runs.
        if(!res.toolCalls || res.toolCalls.length === 0){
          // STOP-TOO-EARLY GUARD. Three trigger conditions, in order of
          // confidence:
          //   (a) empty content    → model gave up silently
          //   (b) "how can I help" / "what would you like"  → model is
          //       asking for guidance instead of executing
          //   (c) user explicitly listed N tool names but only some
          //       fraction were called → model bailed mid-list
          // Push a one-shot nudge up to stopRetriesRemaining times. After
          // retries are spent, the loop accepts the model's reply as final.
          var anySteps = (target && target.agentSteps) ? target.agentSteps.filter(function(s){return s.type==='action';}).length : 0;
          var trimmed = (turnContent || '').trim();
          var asksForHelp = /^(how can i help|what (do you|would you like|task)|please (let me know|tell me|provide))/i.test(trimmed);
          // "Promised-but-no-summary" detector: model says it WILL
          // summarize / WILL list / WILL provide… and then stops without
          // actually doing it. Mostly Gemma 4 — the visible chat ends
          // with the announcement and the user sees no real reply.
          // Triggers regardless of length when the trailing sentence
          // matches "i will provide/write/summarize…", "let me summarize",
          // "now i will…", etc.
          var promisesNoDelivery = /(i will (provide|write|summarize|create|make|list|finish|complete|do|show|give|tell)|i'?ll (provide|write|summarize|create|list|now)|let me summarize|let me (provide|give|list)|here is the summary:?\s*$|now i'?ll|next i'?ll)/i
            .test(trimmed.slice(-260));
          // Empty-summary check: trailing colon/dash with nothing after it.
          var emptyAfterColon = /(:\s*|—\s*|-\s*)$/.test(trimmed) && trimmed.length < 400;
          // Probe the FIRST user msg (= the original task) for explicit
          // tool mentions. Using the LAST user msg fails after a nudge —
          // the nudge text doesn't repeat the tool list, so mentionedTools
          // would drop to 0 and the coverage-gap check would never fire on
          // subsequent iterations.
          var firstUserContent = '';
          for(var li2 = 0; li2 < apiMessages.length; li2++){
            if(apiMessages[li2].role === 'user'){ firstUserContent = String(apiMessages[li2].content || ''); break; }
          }
          var mentionedTools = 0;
          var allKnownToolNames = (typeof AGENT_TOOLS !== 'undefined') ? AGENT_TOOLS.map(function(t){return t.name;}) : [];
          var distinctToolsCalled = {};
          for(var ti=0; ti<allKnownToolNames.length; ti++){
            if(firstUserContent.indexOf(allKnownToolNames[ti]) !== -1) mentionedTools++;
          }
          // Also count how many DISTINCT tools were actually called.
          if(target && target.agentSteps){
            for(var ts=0; ts<target.agentSteps.length; ts++){
              var s = target.agentSteps[ts];
              if(s.type === 'action' && s.toolName) distinctToolsCalled[s.toolName] = true;
            }
          }
          var distinctCalledCount = Object.keys(distinctToolsCalled).length;
          // If the user mentioned ≥5 tools and we've called fewer DISTINCT
          // tools than that, push. Using distinct (not total) count means
          // calling get_current_time twice doesn't satisfy the gap check.
          var coverageGap = mentionedTools >= 5 && distinctCalledCount < mentionedTools;
          var shouldNudge = stopRetriesRemaining > 0 && (
            (!trimmed && anySteps > 0) ||                  // (a) empty content
            (asksForHelp && anySteps < 5) ||               // (b) "how can I help"
            coverageGap ||                                  // (c) user listed N tools, < N called
            promisesNoDelivery ||                           // (d) "I will provide a summary" then stops
            emptyAfterColon                                 // (e) trailing colon with nothing after
          );
          if(shouldNudge){
            stopRetriesRemaining--;
            var nudgeText;
            if(coverageGap){
              // List the tools that were NOT yet called by name, so the
              // model has a concrete next-step target.
              var missingNames = [];
              for(var mn=0; mn<allKnownToolNames.length; mn++){
                var name = allKnownToolNames[mn];
                if(firstUserContent.indexOf(name) !== -1 && !distinctToolsCalled[name]){
                  missingNames.push(name);
                }
              }
              nudgeText = 'You\'ve only called ' + distinctCalledCount + ' DISTINCT tools so far but the user explicitly listed ' +
                mentionedTools + ' tools. Still missing: ' + missingNames.slice(0, 6).join(', ') + '. ' +
                'Call the NEXT one from that list right now as a tool call. Do NOT write a summary yet — keep going.';
            } else if(promisesNoDelivery || emptyAfterColon){
              // Model said "I will provide a summary" / ended on a colon
              // and stopped. Force it to deliver the actual content NOW.
              nudgeText = 'You announced a summary but never wrote it. The user sees nothing useful. ' +
                'Write the actual summary RIGHT NOW in this turn — concrete bullet list of what each tool returned, ' +
                'plus a 1-sentence conclusion. No more announcements, no more "I will".';
            } else if(asksForHelp){
              nudgeText = 'Do not ask the user "how can I help" — the task was already given. Resume executing it now ' +
                'with the next tool call. The user already told you exactly what to do.';
            } else if(anySteps < 3){
              nudgeText = 'You stopped after only ' + anySteps + ' tool call(s) and your last message was empty. ' +
                'The task is not finished. Call the NEXT tool to continue. Do not stop yet.';
            } else {
              nudgeText = 'You completed ' + anySteps + ' tool calls but your last message was empty — the user sees nothing. ' +
                'Write the final user-facing summary right now: 1-3 sentences listing what you did and any concrete results. ' +
                'Do not introduce yourself again.';
            }
            apiMessages.push({ role: 'user', content: nudgeText });
            step();
            return;
          }
          finishToolLoop(turnContent || null);
          return;
        }

        // Push the assistant message with tool_calls into the history
        // so Ollama sees the proper assistant→tool message pairs.
        apiMessages.push({
          role: 'assistant',
          content: turnContent || '',
          tool_calls: res.toolCalls.map(function(tc){
            return {function:{name:tc.function.name, arguments:tc.function.arguments}};
          })
        });

        // Execute each tool call sequentially, show steps in UI
        var tcIndex = 0;
        function execNext(){
          if(agentAbort){
            appendAgentStep('error', kindLabel+' stopped by user.');
            finishToolLoop(null);
            return;
          }
          if(tcIndex >= res.toolCalls.length){
            // All tools executed — loop back for next model turn
            renderChat();
            step();
            return;
          }

          var tc = res.toolCalls[tcIndex];
          var toolName = tc.function.name;
          var toolArgs = tc.function.arguments || {};
          var argsPretty = '';
          try{ argsPretty = JSON.stringify(toolArgs); }catch(_){ argsPretty = '{}'; }

          // Show "running" action step
          appendAgentStep('action', '`'+toolName+'` '+argsPretty, {toolName:toolName, args:toolArgs, live:true});
          var actionIdx = (target.agentSteps || []).length - 1;

          runAgentTool(toolName, toolArgs).then(function(observation){
            var obs = String(observation || '');

            // Mark action as completed
            if(target.agentSteps && target.agentSteps[actionIdx]){
              target.agentSteps[actionIdx].live = false;
            }
            appendAgentStep('observation', obs);

            // Push tool result into the LLM history. The iteration rides with
            // it so decayToolResults can tell the newest results (kept whole)
            // from the ones that have done their job (A1).
            apiMessages.push({role:'tool', content:obs, iter:iter});

            // runAgentTool resolves on graceful 200+{error} too — we have
            // to inspect the observation text to know whether the tool
            // really succeeded. If it didn't, bump the consecutive-error
            // counter; on success, reset.
            if(/^(Error|Permission denied|Network error)/i.test(obs)){
              consecutiveErrors++;
            } else {
              consecutiveErrors = 0;
            }

            if(consecutiveErrors >= maxConsecutiveErrors){
              appendAgentStep('error',
                kindLabel + ' stopped: ' + consecutiveErrors +
                ' consecutive tool errors. Try rephrasing the task or fixing the tool arguments.');
              finishToolLoop(null);
              return;
            }

            tcIndex++;
            execNext();
          }).catch(function(e){
            var errMsg = String(e && e.message || e);
            if(target.agentSteps && target.agentSteps[actionIdx]){
              target.agentSteps[actionIdx].live = false;
            }
            appendAgentStep('error', errMsg);

            // Push error as tool result so the model can adapt
            apiMessages.push({role:'tool', content:'Error: '+errMsg, iter:iter});

            consecutiveErrors++;
            if(consecutiveErrors >= maxConsecutiveErrors){
              appendAgentStep('error',
                kindLabel + ' stopped: ' + consecutiveErrors +
                ' consecutive tool errors. Try rephrasing the task or fixing the tool arguments.');
              finishToolLoop(null);
              return;
            }

            tcIndex++;
            execNext();
          });
        }

        execNext();
      }).catch(function(e){
        // Remove the thinking placeholder if still present
        if(thinkingStepIdx >= 0 && target.agentSteps && target.agentSteps[thinkingStepIdx]){
          target.agentSteps.splice(thinkingStepIdx, 1);
          thinkingStepIdx = -1;
        }

        if(e && e.name === 'AbortError'){
          appendAgentStep('error', 'Stopped.');
          finishToolLoop(null);
          return;
        }
        var errMsg = (e && e.message) || String(e);
        if(errMsg === 'TOOLS_NOT_SUPPORTED'){
          appendAgentStep('error', 'This model does not support tool calling. Pick a tool-capable model (Qwen 3, Llama 3.1+, Gemma 4).');
          finishToolLoop(null);
          return;
        }
        appendAgentStep('error', kindLabel+' error: '+errMsg);
        finishToolLoop(null);
      });
    }

    function finishToolLoop(finalAnswer){
      agentRunning = false;
      agentAbort = false;
      abortCtrl = null;

      // ── Continue capability (parity with original Codex CLI) ────────
      // Persist the tool-call history from THIS turn as hidden messages
      // in msgs[]. On the NEXT turn, the history builder (line ~2802)
      // includes them in apiMessages so the model sees what it did before.
      // Hidden messages are skipped by renderChat() — the user only sees
      // the final answer, but the model sees the full tool-call chain.
      var toolHistory = [];
      for(var hi = apiStartLen; hi < apiMessages.length; hi++){
        var am = apiMessages[hi];
        toolHistory.push(mkMsg(am.role, am.content || '', {
          hidden: true,
          tool_calls: am.tool_calls || undefined
        }));
      }
      if(toolHistory.length > 0){
        // Splice BEFORE target (the visible final-answer message) so
        // the conversation order is: user → hidden tool chain → answer.
        var targetIdx = msgs.indexOf(target);
        if(targetIdx >= 0){
          // splice(targetIdx, 0, ...items) — Array.prototype.splice.apply
          // for ES5 compat (mobile JS can't use spread in all engines).
          var spliceArgs = [targetIdx, 0];
          for(var si = 0; si < toolHistory.length; si++) spliceArgs.push(toolHistory[si]);
          Array.prototype.splice.apply(msgs, spliceArgs);
        }
      }

      // The visible answer — if finalAnswer is null/empty and no prior
      // content, build a fallback summary from agent steps so the bubble
      // is never blank (parity with desktop useCodex.ts fix).
      var answer = finalAnswer || '';
      if(!answer && target && !target.content){
        var steps = target.agentSteps || [];
        var writes = 0, reads = 0, otherOk = 0, fails = 0;
        for(var si2 = 0; si2 < steps.length; si2++){
          var s = steps[si2];
          if(s.type === 'action'){
            if(s.toolName === 'file_write') writes++;
            else if(s.toolName === 'file_read') reads++;
            else otherOk++;
          } else if(s.type === 'error' && s.content && s.content.indexOf('stopped') < 0){
            fails++;
          }
        }
        var summaryParts = [];
        if(writes) summaryParts.push(writes + ' file(s) written');
        if(reads) summaryParts.push(reads + ' file(s) read');
        if(otherOk) summaryParts.push(otherOk + ' other operation(s) completed');
        if(fails) summaryParts.push(fails + ' operation(s) failed');
        answer = summaryParts.length > 0
          ? 'Task completed: ' + summaryParts.join(', ') + '.'
          : 'Task completed.';
      }
      if(target){ target.content = answer || target.content || ''; }
      renderShell();
      renderChat();
      var finalText = target ? (target.content || '') : '';
      postChatEvent('assistant', finalText);
      syncCurrentChat();
    }

    step();
  }

  // Character-state-machine for inline <think>...</think> tags.
  // Parity with desktop useChat.ts lines 205-219. When the user has
  // thinking TOGGLED OFF, the bytes inside <think>...</think> are
  // discarded instead of being stored — same for Ollama's native
  // `message.thinking` field. That way the toggle is the single source
  // of truth ("thinking visible or not").
  var inThinkTag = false;
  var discardedThinkBuf = '';
  function pushChunkContent(target, text, keepThinking){
    if(!text) return;
    for(var k=0;k<text.length;k++){
      var ch = text[k];
      if(!inThinkTag){
        target.content += ch;
        if(target.content.length >= 7 && target.content.slice(-7) === '<think>'){
          target.content = target.content.slice(0,-7);
          inThinkTag = true;
          discardedThinkBuf = '';
        }
      } else {
        if(keepThinking){
          target.thinking += ch;
          if(target.thinking.length >= 8 && target.thinking.slice(-8) === '</think>'){
            target.thinking = target.thinking.slice(0,-8);
            inThinkTag = false;
          }
        } else {
          discardedThinkBuf += ch;
          if(discardedThinkBuf.length >= 8 && discardedThinkBuf.slice(-8) === '</think>'){
            discardedThinkBuf = '';
            inThinkTag = false;
          }
        }
      }
    }
  }

  function streamResponse(r){
    if(!r) return;
    var reader=r.body.getReader();
    var dec=new TextDecoder();
    var buf='';
    inThinkTag = false; // reset per-stream
    discardedThinkBuf = '';
    var target = msgs[msgs.length-1];
    // Thinking visibility is driven strictly by the toggle. If the toggle
    // is OFF, ALL thinking tokens (native field AND inline <think> tags
    // AND non-canonical tags via stripNonCanonicalTags) are silently
    // dropped so the UI never shows a think block the user didn't ask
    // for. If the toggle turns ON later, subsequent tokens appear live.
    function keepThinkingNow(){ return thinking && isThinkingCompatible(currentModel); }
    function pump(){
      reader.read().then(function(result){
        if(result.done){
          // Final pass: scrub any non-canonical thinking markers that
          // slipped past the streaming state-machine (Gemma's channel
          // marker, orphan <thought>, etc.). Bug #3+#5.
          if(target){
            target.content = stripNonCanonicalTags(target.content).trim();
          }
          var finalText = target ? target.content : '';
          postChatEvent('assistant', finalText);
          finishStream();
          return;
        }
        buf+=dec.decode(result.value,{stream:true});
        var lines=buf.split('\n');
        buf=lines.pop()||'';
        var keep = keepThinkingNow();
        for(var li=0;li<lines.length;li++){
          var ln=lines[li].trim();
          if(!ln)continue;
          try{
            var j = JSON.parse(ln);
            if(j && j.message){
              // Ollama native thinking field (Gemma 4, Qwen 3.5, etc.)
              if(typeof j.message.thinking === 'string' && j.message.thinking){
                if(keep){
                  target.thinking += j.message.thinking;
                  // We do NOT auto-open anymore — tool calls / thinking
                  // start collapsed on mobile by user request.
                }
              }
              // Content may contain inline <think>...</think>
              if(typeof j.message.content === 'string' && j.message.content){
                pushChunkContent(target, j.message.content, keep);
              }
            }
          }catch(_){ }
        }
        // Live partial scrub of non-canonical tags (Gemma <|channel|>…).
        // We re-strip on every chunk so the user never sees a "Plan:"
        // preamble flash up while the model is still writing the answer.
        if(target){
          target.content = stripNonCanonicalTags(target.content);
        }
        renderChat();
        pump();
      }).catch(function(){finishStream();});
    }
    pump();
  }

  function finishStream(){
    streaming=false;abortCtrl=null;
    syncCurrentChat();
    // renderShell flips the Send-button back from Stop to Send. Must run
    // BEFORE renderChat so the keyboard-on-iOS doesn't momentarily see a
    // disabled button.
    renderShell();
    renderChat();
  }
})();
