/*@@LU_TOOLING_ONLY@@*/
// Cut out by src-tauri/build.rs: in the assembled page this file and
// personas.js share one function scope, so the name is simply in scope.
import { stripNonCanonicalTags } from './personas.js'
/*@@LU_END@@*/
  // ── Agent tools (parity with src/api/mcp/builtin-tools.ts) ──
  // Descriptions kept tight-matched with the desktop BUILTIN_TOOLS so the
  // same model behaviour follows us onto mobile. Tests in
  // src/api/__tests__/tool-description-parity.test.ts pin this parity.
  var AGENT_TOOLS = [
    {name:'todo_write', description:'Write and update the plan for a multi-step task. The list is shown to the user live, so it is how they follow a long run. USE FIRST when a task needs more than about three tool calls, then send it again after each step. Send the COMPLETE list every time: it replaces the previous one, it does not merge.',
     parameters:[{name:'todos',type:'array',description:'The complete plan, in order. Replaces the previous list.',required:true}]},
    {name:'web_search', description:'Search the web via the configured provider (Brave, Tavily, or auto). Returns a ranked list of {title, url, snippet}. Snippets are teasers, not answers: PREFER web_fetch on the promising URLs for the real content. DO NOT run more than 3 similar queries per turn, refine instead of re-searching.',
     parameters:[{name:'query',type:'string',description:'The search query string',required:true},
                 {name:'maxResults',type:'number',description:'Maximum results to return (default: 5, max: 20)',required:false}]},
    {name:'web_fetch', description:'Fetch a single URL and return its readable text (up to ~24 000 chars), scripts, styles and page furniture stripped. PREFER this over web_search when you already know the target URL. NEVER call it with localhost, a private IP or file://, those are refused. On an empty or 4xx response try a different URL, not the same one again.',
     parameters:[{name:'url',type:'string',description:'Full URL including protocol (http:// or https://)',required:true},
                 {name:'maxLength',type:'number',description:'Max chars to return (default: 24000)',required:false}]},
    {name:'file_read', description:'Read a file. PREFER absolute paths; relative paths resolve against the agent workspace. Omitting offset/limit returns the whole file. For LARGE files pass offset (1-based start line) and limit (number of lines): the response names the window, the total line count and the offset of the next page. A very long whole-file read gets its middle truncated, so page large files. DO NOT re-read a file you just wrote, the write response already confirmed it.',
     parameters:[{name:'path',type:'string',description:'Path to the file (absolute preferred)',required:true},
                 {name:'offset',type:'number',description:'1-based line to start reading from (optional)',required:false},
                 {name:'limit',type:'number',description:'Maximum number of lines to return (optional)',required:false}]},
    {name:'file_write', description:'Write a WHOLE file: use it to CREATE a new file or fully replace one, and PREFER file_edit to change part of an existing one. Creates parent directories if missing. OVERWRITES existing content, there is no append mode. PREFER absolute paths.',
     parameters:[{name:'path',type:'string',description:'Path to the file (absolute preferred)',required:true},
                 {name:'content',type:'string',description:'The complete new content of the file',required:true}]},
    {name:'file_list', description:'List directory contents. Returns name, isDir, size and full path per entry. Supports recursive=true and a glob pattern ("*.ts", "**/*.py"). PREFER a specific pattern over recursing a whole home or drive, that is slow. For content search use file_search.',
     parameters:[{name:'path',type:'string',description:'Directory path to list',required:true},
                 {name:'recursive',type:'boolean',description:'Recurse into subdirectories (default: false)',required:false},
                 {name:'pattern',type:'string',description:'Glob pattern to filter results (e.g. "*.ts", "**/*.py")',required:false}]},
    {name:'file_search', description:'Grep-style regex content search across files in a directory. Returns matching lines with file and line number. PREFER it over file_read plus a manual scan when hunting a symbol across many files. Default max 50 results, narrow the pattern or path if you flood. Pattern is Rust regex syntax, not PCRE.',
     parameters:[{name:'path',type:'string',description:'Directory to search in (recursive by default)',required:true},
                 {name:'pattern',type:'string',description:'Regex pattern to search for',required:true},
                 {name:'maxResults',type:'number',description:'Maximum matching files (default: 50)',required:false}]},
    {name:'shell_execute', description:'THE terminal. Run a shell command: PowerShell on Windows, bash on Unix. Returns stdout, stderr, exit code. Everything runs here: git, tests, package managers, gh, python, platform utilities, and opening files, folders or apps. A recognised test run and the common git commands come back as a parsed summary. Feed a script through `stdin` instead of quoting it: set command to `python3 -` or `bash -s` (fresh process each call, no REPL state). For long work set `background: true` to get a task id back at once, then call again with `task: "status"` and `task_id` (or "list" / "kill"). PREFER dedicated tools where available: file_read over `cat`, file_list over `ls`, file_search over `grep`. `--no-verify` is refused, and NEVER delete permanently without confirmation. Default timeout 120 s, test runs 300 s.',
     parameters:[{name:'command',type:'string',description:'The full command to execute. Omit only for task actions.',required:false},
                 {name:'cwd',type:'string',description:'Working directory (optional, absolute preferred)',required:false},
                 {name:'timeout',type:'number',description:'Timeout in milliseconds (default: 120000)',required:false},
                 {name:'shell',type:'string',description:'Override shell: "powershell" | "cmd" | "bash" (default: auto)',required:false},
                 {name:'stdin',type:'string',description:'Text piped to the command\x27s stdin, e.g. a Python script for `python3 -`.',required:false},
                 {name:'background',type:'boolean',description:'Run detached; returns a task id immediately instead of waiting.',required:false},
                 {name:'task',type:'string',description:'Background-task action instead of running a command.',required:false},
                 {name:'task_id',type:'string',description:'Task id for task "status" or "kill".',required:false}]},
    {name:'screenshot', description:'Capture the primary display as a base64 PNG. Zero arguments. USE for visual verification when the user asks "what\'s on my screen" or "look at X". Returns a short summary string (size + filename); the actual image is forwarded to the model via message content. NEVER call in a tight loop — screenshots are expensive and privacy-sensitive.',
     parameters:[]},
    {name:'image_generate', description:'Generate an image from a text prompt via the local image pipeline (Apple MLX on macOS; ComfyUI elsewhere, auto-detected). Blocks up to 5 minutes. USE for "draw me", "make an image of", "generate a picture". Pass `inputImage` (a filename from an earlier image_generate result) for image-to-image — restyle / edit an existing image at the given `denoise` strength; omit it for text-to-image. First installed image model is auto-selected (or pass `model`). EXPECT A PAUSE on non-Mac (ComfyUI) single-GPU machines: LU may briefly unload the chat model from VRAM to fit the image model, then reload it after — typically a 30-90s swap. This avoids out-of-memory errors; your conversation is fully preserved across the swap. Rate-limit yourself to 1 call per turn — generations serialize internally so parallel calls will queue, not speed up. Fine-tune through the optional `settings` object; a value beyond the model\'s real limit is REJECTED with the actual limit, never silently changed.',
     parameters:[{name:'prompt',type:'string',description:'Positive text description of the desired image',required:true},
                 {name:'negativePrompt',type:'string',description:'Things to avoid (blurry, deformed, etc.)',required:false},
                 {name:'model',type:'string',description:'Optional image model filename to use. Omit to auto-select the first installed image model.',required:false},
                 {name:'inputImage',type:'string',description:'Optional. Filename of a previously generated image (from an earlier image_generate result) to use as the base for image-to-image. Omit for text-to-image.',required:false},
                 {name:'denoise',type:'number',description:'Image-to-image strength 0.05–1.0 (default 0.6). Lower keeps more of the input image, higher follows the prompt more. Only used together with inputImage.',required:false}]},
  ];

  // ── Tool-set constants ──
  var CODEX_TOOLS = ['file_read','file_write','file_list','file_search','shell_execute','web_search','web_fetch'];
  var AGENT_ALL_TOOLS = AGENT_TOOLS.map(function(t){return t.name;});

  // ── Mobile parity helpers (Codex audit fixes) ──────────────────────
  // Three helpers ported from desktop's tool-call-repair lib + Codex
  // streaming pipeline. Without these, the mobile agent loop drifts in
  // ways the desktop never does:
  //   (1) Ollama sometimes emits tool_call.arguments as a JSON STRING
  //       instead of an object; mobile passed it through unchanged →
  //       the Rust `agent-tool` endpoint saw `args = "{...}"` and the
  //       file_write handler reported "needs argument".
  //   (2) Some models (qwen2.5-coder, gemma after a few iterations)
  //       emit tool calls as a fenced ```json {"name":...} ``` block
  //       inside `content` instead of native `tool_calls`. Without an
  //       extractor mobile saw zero tool calls and wrote the JSON to
  //       the chat as if it were the final answer.
  //   (3) `apiMessages` grew unbounded across iterations. Local models
  //       with 8K-32K windows would have their oldest messages
  //       silently truncated by Ollama, including the system prompt
  //       and the original user request — the model then "forgot the
  //       task" and emitted "I'm ready to receive the task" mid-loop.
  function repairToolCallArgs(raw){
    if(raw == null) return {};
    if(typeof raw === 'object') return raw;
    if(typeof raw !== 'string') return {};
    var trimmed = raw.trim();
    if(!trimmed) return {};
    try{ var parsed = JSON.parse(trimmed); return (parsed && typeof parsed === 'object') ? parsed : {}; }catch(_){}
    // Some models double-encode the args (string of a string of JSON)
    if(trimmed.charAt(0) === '"' && trimmed.charAt(trimmed.length-1) === '"'){
      try{ var inner = JSON.parse(trimmed); if(typeof inner === 'string'){
        try{ var parsed2 = JSON.parse(inner); return (parsed2 && typeof parsed2 === 'object') ? parsed2 : {}; }catch(_){}
      }}catch(_){}
    }
    return {};
  }

  // Pulls fenced ```json {"name":..., "arguments":...} ``` tool calls
  // out of the assistant's content. Returns {calls, ranges} so the
  // caller can also strip the JSON from the visible text.
  function extractToolCallsFromContent(content, knownToolNames){
    var calls = [], ranges = [];
    if(!content || typeof content !== 'string') return {calls: calls, ranges: ranges};
    var fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
    var match;
    while((match = fenceRe.exec(content)) !== null){
      var inner = match[1].trim();
      try{
        var obj = JSON.parse(inner);
        var name = obj && (obj.name || obj.tool || (obj.function && obj.function.name));
        var args = obj && (obj.arguments || obj.args || (obj.function && obj.function.arguments) || {});
        if(name && (!knownToolNames || knownToolNames.indexOf(name) !== -1)){
          calls.push({function:{name: name, arguments: repairToolCallArgs(args)}});
          ranges.push({start: match.index, end: match.index + match[0].length});
        }
      }catch(_){}
    }
    return {calls: calls, ranges: ranges};
  }
  function stripRanges(content, ranges){
    if(!ranges || !ranges.length) return content;
    // Apply ranges back-to-front so earlier indexes don't shift
    var sorted = ranges.slice().sort(function(a,b){ return b.start - a.start; });
    var out = content;
    for(var i=0;i<sorted.length;i++){
      out = out.slice(0, sorted[i].start) + out.slice(sorted[i].end);
    }
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }

  // System-prompt echo detector — Gemma 4 / smaller models drop back to
  // "Hello, I am Codex / Agent — I am ready to assist..." after a tool
  // error. Mirrors the desktop guard in useCodex.ts so the same line
  // never lands in the chat over-the-air. Silent retry instead of
  // letting the echo reach the user.
  function isSystemPromptEcho(content){
    if(!content) return false;
    var head = String(content).trim().slice(0, 240);
    if(/^(hello[!,\.]?\s+|hi[!,\.]?\s+|hey[!,\.]?\s+)?(i['’]?m|i am|you are)\s+((the\s+)?coding\s+agent|an autonomous|the agent|an? ai)/i.test(head)) return true;
    if(/^(i am|i['’]m)\s+ready\s+to\s+(receive|assist|help)/i.test(head)) return true;
    if(/^(hello|hi|hey)[!,\.]?\s+i['’]?m\s+ready/i.test(head)) return true;
    return false;
  }

  // ── A1 mobile: age decay for tool results ─────────────────────────
  // Same rule and the same numbers as the desktop (src/lib/context-decay.ts):
  // a result the model looked at two iterations ago has already done its job,
  // so it rides along head+tail-capped, while the newest iteration stays
  // byte-for-byte intact. That last half is the binding behavioural rule: the
  // model must never edit against content it can no longer see.
  //
  // What it fixes here: the loop pushed every observation at full length and
  // the compaction below always kept the last four messages, so ONE 200 KB
  // file_read sat in the window forever. Ollama then truncated the request
  // from the FRONT, which eats the system prompt and the original task, and
  // the run answered "I'm ready to receive the task" mid-loop. That is the
  // documented mobile task-forgetting, and it was never a compaction bug: the
  // compaction was doing exactly what it was told with a number that could
  // never be reached.
  //
  // The visible transcript is untouched. appendAgentStep('observation', obs)
  // runs on the FULL text before the push, so the user keeps the whole result
  // and only the model's copy is capped.
  var DECAY_RESULT_CHARS = 4000;
  var RESTORE_RESULT_CHARS = 1500;
  var DECAY_AFTER_ITERATIONS = 2;
  var TRUNCATION_MARKER = '…[truncated ';
  var MARKER_SLACK = 64;
  // How many messages may still carry their images. Base64 image bytes were
  // invisible to the budget below, so a photo turn could be ten times over it
  // and compaction saw nothing to do.
  var IMAGE_KEEP_RECENT = 2;

  // True when this text already IS the output of a cut at `budget`. Cutting a
  // second time would land on different bytes every step, so the check has to
  // come before the cut, not after.
  function isDecayedAt(text, budget){
    var s = String(text == null ? '' : text);
    return s.length <= budget + MARKER_SLACK && s.indexOf(TRUNCATION_MARKER) !== -1;
  }

  // Head-heavy split, same 2/3 as the desktop: the start of a result carries
  // the most signal (top of a file, first compiler error), the tail keeps the
  // exit code and the final error.
  function capToolResult(text, maxChars){
    var s = String(text == null ? '' : text);
    if(s.length <= maxChars) return s;
    if(isDecayedAt(s, maxChars)) return s;
    var headChars = Math.max(0, Math.floor(maxChars * 0.66));
    var tailChars = Math.max(0, maxChars - headChars);
    var head = s.slice(0, headChars);
    var tail = tailChars > 0 ? s.slice(s.length - tailChars) : '';
    var dropped = s.length - head.length - tail.length;
    return head + '\n\n' + TRUNCATION_MARKER + dropped + ' chars]…\n\n' + tail;
  }

  // Cap every tool result older than DECAY_AFTER_ITERATIONS. Messages without
  // an iteration are restored history, i.e. as old as it gets. In place and
  // final: capToolResult returns an already-capped result unchanged, so the
  // prompt prefix stops moving after the one step that did the cutting.
  function decayToolResults(messages, currentIter){
    if(!Array.isArray(messages)) return messages;
    var cutoff = currentIter - DECAY_AFTER_ITERATIONS;
    for(var i=0;i<messages.length;i++){
      var m = messages[i];
      if(!m || m.role !== 'tool') continue;
      var it = (typeof m.iter === 'number') ? m.iter : -Infinity;
      if(it > cutoff) continue;
      m.content = capToolResult(m.content, DECAY_RESULT_CHARS);
    }
    return messages;
  }

  // Characters this message really costs. Base64 images are the whole point:
  // they are the biggest thing in a payload and the old count ignored them.
  function msgChars(m){
    if(!m) return 0;
    var n = String(m.content || '').length;
    if(Array.isArray(m.images)){
      for(var i=0;i<m.images.length;i++) n += String(m.images[i] || '').length;
    }
    return n;
  }

  function totalChars(messages){
    var n = 0;
    for(var i=0;i<messages.length;i++) n += msgChars(messages[i]);
    return n;
  }

  // Only the newest `keepRecent` messages that carry images send them again.
  // An older picture is replaced by a one-line placeholder so the model still
  // knows a picture was there.
  function dropOldImages(messages, keepRecent){
    if(!Array.isArray(messages)) return messages;
    var withImages = [];
    for(var i=0;i<messages.length;i++){
      var m = messages[i];
      if(m && Array.isArray(m.images) && m.images.length) withImages.push(i);
    }
    var firstKept = Math.max(0, withImages.length - keepRecent);
    for(var k=0;k<firstKept;k++){
      var msg = messages[withImages[k]];
      var count = msg.images.length;
      delete msg.images;
      msg.content = String(msg.content || '') +
        '\n[' + count + ' image(s) from an earlier message omitted]';
    }
    return messages;
  }

  // Conservative compaction — keep system prompt + the first user message
  // (anchors the task) + the most recent N turns. Drops only the OLDEST
  // tool-result chains, which is the cheapest data to lose. Fires when
  // total chars exceed budget (~24 KB by default = ~6K tokens).
  function compactApiMessages(messages, charBudget){
    if(!Array.isArray(messages)) return messages;
    var budget = charBudget || 24000;
    // Unconditional, and before the early return: an old image is bytes the
    // model has already been shown and cannot act on twice.
    dropOldImages(messages, IMAGE_KEEP_RECENT);
    if(messages.length < 6) return messages;
    if(totalChars(messages) <= budget) return messages;
    // Always keep [0] (system) and [1] (first user) if present.
    var head = [];
    if(messages.length > 0 && messages[0].role === 'system') head.push(messages[0]);
    var firstUserIdx = -1;
    for(var j=0;j<messages.length;j++) if(messages[j].role === 'user'){ firstUserIdx = j; break; }
    if(firstUserIdx !== -1 && messages[firstUserIdx] !== head[0]) head.push(messages[firstUserIdx]);
    // Drop oldest tail messages until we fit.
    var tail = messages.slice(firstUserIdx + 1);
    var headChars = totalChars(head);
    while(tail.length > 4){
      if(headChars + totalChars(tail) <= budget) break;
      tail.shift();
    }
    // The floor of four can still be bigger than the whole budget when one of
    // those four is a single huge result: the newest iteration is never
    // decayed, so a fresh 200 KB read lands here at full length. Leaving it
    // means Ollama truncates from the front and eats the system prompt and the
    // task, so cap what is left instead, oldest first, and touch the newest
    // result only when nothing else gets us under. Two fixed rungs, never a
    // budget derived from the payload, so the same history always produces the
    // same bytes.
    if(headChars + totalChars(tail) > budget){
      var rungs = [DECAY_RESULT_CHARS, RESTORE_RESULT_CHARS];
      for(var r=0;r<rungs.length;r++){
        for(var t=0;t<tail.length;t++){
          if(headChars + totalChars(tail) <= budget) break;
          if(!tail[t] || tail[t].role !== 'tool') continue;
          tail[t].content = capToolResult(tail[t].content, rungs[r]);
        }
      }
    }
    return head.concat(tail);
  }

  // Convert the flat AGENT_TOOLS array into Ollama's native tools schema.
  // `toolNames` is a whitelist — only tools whose name appears in it are
  // included. Returns [{type:'function', function:{name, description,
  // parameters:{type:'object', properties:{...}, required:[...]}}}].
  function buildToolDefs(toolNames){
    var out = [];
    for(var i=0;i<AGENT_TOOLS.length;i++){
      var t = AGENT_TOOLS[i];
      if(toolNames.indexOf(t.name) === -1) continue;
      var props = {};
      var req = [];
      for(var j=0;j<t.parameters.length;j++){
        var p = t.parameters[j];
        props[p.name] = {type: p.type, description: p.description};
        if(p.required) req.push(p.name);
      }
      out.push({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: {type:'object', properties: props, required: req}
        }
      });
    }
    return out;
  }

  // Strip <think>...</think> tags from content. If keepThinking is true,
  // capture inner text into the returned `thinking` field; otherwise
  // discard it. Also handles Ollama's native `thinking` field.
  function stripThinkTags(content, keepThinking){
    var think = '';
    // Handle inline <think>...</think> tags (may be multiple)
    var cleaned = String(content || '').replace(/<think>([\s\S]*?)<\/think>/g, function(_, inner){
      if(keepThinking && inner) think = think ? think+'\n'+inner : inner;
      return '';
    });
    // Strip non-canonical reasoning tags too
    cleaned = stripNonCanonicalTags(cleaned).trim();
    return {content: cleaned, thinking: think};
  }
/*@@LU_TOOLING_ONLY@@*/
// Cut out by src-tauri/build.rs — see caveman.js.
export {
  AGENT_ALL_TOOLS,
  AGENT_TOOLS,
  CODEX_TOOLS,
  DECAY_AFTER_ITERATIONS,
  DECAY_RESULT_CHARS,
  IMAGE_KEEP_RECENT,
  MARKER_SLACK,
  RESTORE_RESULT_CHARS,
  TRUNCATION_MARKER,
  buildToolDefs,
  capToolResult,
  compactApiMessages,
  decayToolResults,
  dropOldImages,
  extractToolCallsFromContent,
  isDecayedAt,
  isSystemPromptEcho,
  msgChars,
  repairToolCallArgs,
  stripRanges,
  stripThinkTags,
  totalChars,
}
/*@@LU_END@@*/
