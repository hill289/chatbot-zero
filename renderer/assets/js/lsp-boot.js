    (function () {
      'use strict';
      if (window.PgpLsp) return;

      // ── 配置 ────────────────────────────────────────────────
      var CFG = {
        tsUrl: './lsp/typescript.js',
        libsUrl: './lsp/ts-libs.js',
        defaultLib: 'lib.es2020.full.d.ts',
        debounceMs: 400,     // 编辑停止后多久触发一次诊断
        hoverDelayMs: 220,   // 悬浮多久触发一次 hover
        maxCompletions: 200
      };

      // ── Node.js 运行时环境声明 ──────────────────────────────
      // 编辑器跑的是 almostnode（浏览器内 Node.js）脚本，require/process 等是运行期全局，
      // 这里给出最小声明，避免 tsserver 把「找不到 require/process」当错误报出来。
      var NODE_ENV_DTS = [
        '// 由页面自动注入：almostnode / Node.js 运行时环境声明',
        'declare var require: (id: string) => any;',
        'declare var module: any;',
        'declare var exports: any;',
        'declare var process: any;',
        'declare var global: any;',
        'declare var Buffer: any;',
        'declare var __dirname: string;',
        'declare var __filename: string;',
        'declare function setImmediate(cb: (...a: any[]) => void, ...args: any[]): any;',
        'declare function clearImmediate(id: any): void;',
        'declare module "*";'
      ].join('\n');

      var log = function () { try { console.log.apply(console, ['[pgpy-lsp]'].concat([].slice.call(arguments))); } catch (_) {} };
      var warn = function () { try { console.warn.apply(console, ['[pgpy-lsp]'].concat([].slice.call(arguments))); } catch (_) {} };

      function escapeHtml(s) {
        try { if (typeof pgpyEscapeHtml === 'function') return pgpyEscapeHtml(String(s)); } catch (_) {}
        return String(s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
      }
      function currentPath() { try { return pgpyCurrentFilePath; } catch (_) { return null; } }
      function currentEditor() { try { return pgpyEditor; } catch (_) { return null; } }

      // ══════════════════════════════════════════════════════════
      //  1. TypeScript 引擎懒加载
      // ══════════════════════════════════════════════════════════
      var _enginePromise = null;
      function loadScript(src) {
        return new Promise(function (resolve, reject) {
          var s = document.createElement('script');
          s.src = src; s.async = true;
          s.onload = function () { resolve(); };
          s.onerror = function () { reject(new Error('无法加载 ' + src)); };
          document.head.appendChild(s);
        });
      }
      function loadEngine() {
        if (_enginePromise) return _enginePromise;
        _enginePromise = Promise.resolve().then(function () {
          if (!window.__TS_LIBS__) return loadScript(CFG.libsUrl);
        }).then(function () {
          if (!(window.ts && window.ts.createLanguageService)) return loadScript(CFG.tsUrl);
        }).then(function () {
          if (!(window.ts && window.ts.createLanguageService)) throw new Error('TypeScript 引擎加载失败（' + CFG.tsUrl + '）');
          if (!window.__TS_LIBS__) throw new Error('TypeScript lib 声明加载失败（' + CFG.libsUrl + '）');
          return window.ts;
        });
        return _enginePromise;
      }

      // ══════════════════════════════════════════════════════════
      //  2. 传输层：MessageChannel 端口对（异步、真实消息传递）
      // ══════════════════════════════════════════════════════════
      function createPortPair() {
        if (typeof MessageChannel === 'function') {
          var ch = new MessageChannel();
          return [ch.port1, ch.port2];
        }
        // 兜底：极简端口对（同样的 postMessage/onmessage 语义，用 setTimeout 异步化）
        function makePort() {
          var p = { onmessage: null, _peer: null };
          p.postMessage = function (data) {
            var peer = p._peer;
            if (peer && peer.onmessage) setTimeout(function () { peer.onmessage({ data: data }); }, 0);
          };
          p.start = function () {}; p.close = function () { p._peer = null; };
          return p;
        }
        var a = makePort(), b = makePort();
        a._peer = b; b._peer = a;
        return [a, b];
      }

      // ══════════════════════════════════════════════════════════
      //  3. JSON-RPC 2.0 连接（LSP 报文层）
      // ══════════════════════════════════════════════════════════
      function RpcConnection(port, name) {
        this.port = port; this.name = name; this._id = 0;
        this._pending = new Map();
        this._requestHandlers = new Map();
        this._notificationHandlers = new Map();
        this._closed = false;
        var self = this;
        port.onmessage = function (ev) { self._onMessage(ev.data); };
        if (port.start) port.start();
      }
      RpcConnection.prototype.send = function (msg) { try { this.port.postMessage(msg); } catch (e) { warn('postMessage', e); } };
      RpcConnection.prototype.request = function (method, params) {
        var self = this, id = ++this._id;
        return new Promise(function (resolve, reject) {
          self._pending.set(id, { resolve: resolve, reject: reject });
          self.send({ jsonrpc: '2.0', id: id, method: method, params: params === undefined ? null : params });
        });
      };
      RpcConnection.prototype.notify = function (method, params) {
        this.send({ jsonrpc: '2.0', method: method, params: params === undefined ? null : params });
      };
      RpcConnection.prototype.onRequest = function (method, handler) { this._requestHandlers.set(method, handler); };
      RpcConnection.prototype.onNotification = function (method, handler) { this._notificationHandlers.set(method, handler); };
      RpcConnection.prototype._onMessage = function (msg) {
        var self = this;
        if (!msg || msg.jsonrpc !== '2.0') return;
        // 响应
        if (msg.id !== undefined && msg.method === undefined) {
          var p = this._pending.get(msg.id); if (!p) return; this._pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'LSP error ' + msg.error.code));
          else p.resolve(msg.result);
          return;
        }
        // 服务端 -> 客户端 的请求
        if (msg.method !== undefined && msg.id !== undefined) {
          var rh = this._requestHandlers.get(msg.method);
          Promise.resolve().then(function () { return rh ? rh(msg.params) : null; }).then(function (result) {
            self.send({ jsonrpc: '2.0', id: msg.id, result: result === undefined ? null : result });
          }, function (err) {
            self.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String((err && err.message) || err) } });
          });
          return;
        }
        // 通知
        if (msg.method !== undefined) {
          var nh = this._notificationHandlers.get(msg.method);
          if (nh) { try { nh(msg.params); } catch (e) { warn('notify handler', msg.method, e); } }
        }
      };

      // ══════════════════════════════════════════════════════════
      //  4. 语言服务器：TypeScript Language Service（tsserver 引擎）
      // ══════════════════════════════════════════════════════════
      function TsServer() {
        this.ts = null;
        this.docs = new Map();     // uri -> { text, version, langId, path }
        this._ls = null;
        this._host = null;
        this._versions = new Map();
        this._libFiles = null;
        this._conn = null;
      }
      TsServer.prototype._norm = function (n) { return String(n).replace(/\\/g, '/').split('/').pop(); };

      TsServer.prototype.initialize = function () {
        var self = this;
        return loadEngine().then(function (ts) {
          self.ts = ts;
          self._libFiles = window.__TS_LIBS__ || {};
          self._options = {
            allowJs: true,
            checkJs: true,
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            lib: [CFG.defaultLib],
            noEmit: true,
            strict: false,
            skipLibCheck: true,
            allowNonTsExtensions: true,
            types: [],
            maxNodeModuleJsDepth: 0
          };
          self._host = {
            getScriptFileNames: function () {
              var arr = ['/__pgpy_env__.d.ts'];
              self.docs.forEach(function (d) { arr.push(d.path); });
              return arr;
            },
            getScriptVersion: function (name) { return String(self._versions.get(name) || 0); },
            getScriptSnapshot: function (name) {
              var txt = self._read(name);
              return txt === undefined ? undefined : ts.ScriptSnapshot.fromString(txt);
            },
            getCurrentDirectory: function () { return '/'; },
            getCompilationSettings: function () { return self._options; },
            getDefaultLibFileName: function () { return CFG.defaultLib; },
            fileExists: function (name) { return self._read(name) !== undefined; },
            readFile: function (name) { return self._read(name); },
            directoryExists: function () { return true; },
            getDirectories: function () { return []; },
            readDirectory: function () { return []; },
            getScriptKind: function (name) {
              var e = self._norm(name).toLowerCase();
              if (/\.d\.ts$/.test(e)) return ts.ScriptKind.TS;
              if (/\.tsx$/.test(e)) return ts.ScriptKind.TSX;
              if (/\.ts$/.test(e)) return ts.ScriptKind.TS;
              if (/\.jsx$/.test(e)) return ts.ScriptKind.JSX;
              if (/\.json$/.test(e)) return ts.ScriptKind.JSON;
              return ts.ScriptKind.JS;
            }
          };
          self._ls = ts.createLanguageService(self._host, ts.createDocumentRegistry());
          return {
            capabilities: {
              textDocumentSync: 1, // 1 = Full
              hoverProvider: true,
              completionProvider: { triggerCharacters: ['.', '"', "'", '`', '/', '@'] }
            },
            serverInfo: { name: 'tsserver (TypeScript Language Service)', version: ts.version }
          };
        });
      };

      // 把路径解析为文本：内置环境声明 / 打开的文档 / TS 自带的 lib.*.d.ts
      TsServer.prototype._read = function (name) {
        if (name === '/__pgpy_env__.d.ts') return NODE_ENV_DTS;
        var hit = null;
        this.docs.forEach(function (d) { if (d.path === name) hit = d.text; });
        if (hit !== null) return hit;
        var b = this._norm(name);
        if (this._libFiles && this._libFiles[b] !== undefined) return this._libFiles[b];
        return undefined;
      };

      TsServer.prototype._pathFor = function (uri) {
        var name = String(uri).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[?#].*$/, '');
        if (name.charAt(0) !== '/') name = '/' + name;
        return name;
      };

      TsServer.prototype.openDocument = function (uri, text, langId) {
        var path = this._pathFor(uri);
        this.docs.set(uri, { text: text, version: 1, langId: langId, path: path });
        this._versions.set(path, 1);
        this.publish(uri);
      };
      TsServer.prototype.changeDocument = function (uri, text) {
        var d = this.docs.get(uri); if (!d) return;
        d.text = text; d.version++;
        this._versions.set(d.path, d.version);
        this.publish(uri);
      };
      TsServer.prototype.closeDocument = function (uri) {
        var d = this.docs.get(uri); if (!d) return;
        this.docs.delete(uri); this._versions.delete(d.path);
        this.notify('textDocument/publishDiagnostics', { uri: uri, diagnostics: [] });
      };

      TsServer.prototype.publish = function (uri) {
        var d = this.docs.get(uri); if (!d || !this._ls) return;
        var ts = this.ts, diags = [], sf = null;
        try {
          sf = this._ls.getProgram().getSourceFile(d.path);
          diags = [].concat(this._ls.getSyntacticDiagnostics(d.path), this._ls.getSemanticDiagnostics(d.path));
        } catch (e) { warn('getDiagnostics failed', e); return; }
        var out = [];
        for (var i = 0; i < diags.length; i++) {
          var lsp = this._toLsp(diags[i], sf);
          if (lsp) out.push(lsp);
        }
        this.notify('textDocument/publishDiagnostics', { uri: uri, diagnostics: out, version: d.version });
      };
      TsServer.prototype._toLsp = function (dg, sf) {
        var ts = this.ts, range;
        if (dg.start !== undefined && sf) {
          var s = ts.getLineAndCharacterOfPosition(sf, dg.start);
          var t = ts.getLineAndCharacterOfPosition(sf, dg.start + (dg.length || 0));
          range = { start: { line: s.line, character: s.character }, end: { line: t.line, character: t.character } };
        } else {
          range = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
        }
        var sev = dg.category === ts.DiagnosticCategory.Error ? 1
          : dg.category === ts.DiagnosticCategory.Warning ? 2
          : dg.category === ts.DiagnosticCategory.Suggestion ? 4 : 3;
        return {
          range: range, severity: sev, code: dg.code, source: 'ts',
          message: ts.flattenDiagnosticMessageText(dg.messageText, '\n')
        };
      };

      TsServer.prototype.hover = function (uri, pos) {
        var d = this.docs.get(uri); if (!d || !this._ls) return null;
        var off = this._offsetOf(d.text, pos), qi = null;
        try { qi = this._ls.getQuickInfoAtPosition(d.path, off); } catch (_) {}
        if (!qi || !qi.displayParts) return null;
        var ts = this.ts;
        var sig = ts.displayPartsToString(qi.displayParts);
        var doc = ts.displayPartsToString(qi.documentation || []);
        var md = '```typescript\n' + sig + '\n```' + (doc ? '\n\n' + doc : '');
        var range;
        if (qi.textSpan && qi.textSpan.start != null) {
          var sf = null; try { sf = this._ls.getProgram().getSourceFile(d.path); } catch (_) {}
          if (sf) {
            var s = ts.getLineAndCharacterOfPosition(sf, qi.textSpan.start);
            var t = ts.getLineAndCharacterOfPosition(sf, qi.textSpan.start + qi.textSpan.length);
            range = { start: { line: s.line, character: s.character }, end: { line: t.line, character: t.character } };
          }
        }
        return { contents: { kind: 'markdown', value: md }, range: range };
      };

      TsServer.prototype.completion = function (uri, pos) {
        var d = this.docs.get(uri); if (!d || !this._ls) return null;
        var off = this._offsetOf(d.text, pos), comp = null;
        try { comp = this._ls.getCompletionsAtPosition(d.path, off, {}); } catch (_) {}
        if (!comp) return null;
        var items = comp.entries.slice(0, CFG.maxCompletions).map(function (e) {
          return { label: e.name, kind: 6, sortText: e.sortText, insertText: e.insertText || e.name };
        });
        return { isIncomplete: true, items: items };
      };

      TsServer.prototype._offsetOf = function (text, pos) {
        var line = 0, off = 0, target = (pos && pos.line) || 0;
        while (line < target) {
          var nl = text.indexOf('\n', off);
          if (nl < 0) { off = text.length; break; }
          off = nl + 1; line++;
        }
        return Math.min(text.length, off + (((pos && pos.character) || 0)));
      };

      TsServer.prototype.notify = function (method, params) { if (this._conn) this._conn.notify(method, params); };

      // LSP 方法分发（服务端侧）
      function attachServer(conn, server) {
        server._conn = conn;
        conn.onRequest('initialize', function () { return server.initialize(); });
        conn.onRequest('shutdown', function () { return null; });
        conn.onNotification('exit', function () {});
        conn.onNotification('textDocument/didOpen', function (p) {
          var td = (p && p.textDocument) || {};
          server.openDocument(td.uri, td.text != null ? td.text : '', td.languageId || 'javascript');
        });
        conn.onNotification('textDocument/didChange', function (p) {
          var td = (p && p.textDocument) || {};
          var c = (p && p.contentChanges && p.contentChanges[0]) || {};
          if (c.text != null) server.changeDocument(td.uri, c.text);
          else if (td.text != null) server.changeDocument(td.uri, td.text);
        });
        conn.onNotification('textDocument/didClose', function (p) {
          server.closeDocument((p && p.textDocument && p.textDocument.uri) || '');
        });
        conn.onRequest('textDocument/hover', function (p) {
          return server.hover((p && p.textDocument && p.textDocument.uri) || '', p && p.position);
        });
        conn.onRequest('textDocument/completion', function (p) {
          return server.completion((p && p.textDocument && p.textDocument.uri) || '', p && p.position);
        });
      }

      // ══════════════════════════════════════════════════════════
      //  5. LSP 客户端
      // ══════════════════════════════════════════════════════════
      function LspClient(conn) { this.conn = conn; }
      LspClient.prototype.initialize = function (rootUri) {
        return this.conn.request('initialize', {
          processId: null,
          rootUri: rootUri || null,
          clientInfo: { name: 'pgpy-workbench', version: '1.0' },
          capabilities: {
            textDocument: {
              synchronization: { didSave: false, willSave: false, dynamicRegistration: false },
              hover: { contentFormat: ['markdown', 'plaintext'] },
              completion: { completionItem: { snippetSupport: false } },
              publishDiagnostics: { relatedInformation: true }
            }
          },
          initializationOptions: { tsserver: true }
        });
      };
      LspClient.prototype.initialized = function () { this.conn.notify('initialized', {}); };
      LspClient.prototype.didOpen = function (uri, text, langId) {
        this.conn.notify('textDocument/didOpen', { textDocument: { uri: uri, languageId: langId || 'javascript', version: 1, text: text } });
      };
      LspClient.prototype.didChange = function (uri, text, version) {
        this.conn.notify('textDocument/didChange', { textDocument: { uri: uri, version: version || 1 }, contentChanges: [{ text: text }] });
      };
      LspClient.prototype.didClose = function (uri) { this.conn.notify('textDocument/didClose', { textDocument: { uri: uri } }); };
      LspClient.prototype.hover = function (uri, pos) { return this.conn.request('textDocument/hover', { textDocument: { uri: uri }, position: pos }); };
      LspClient.prototype.completion = function (uri, pos) { return this.conn.request('textDocument/completion', { textDocument: { uri: uri }, position: pos }); };
      LspClient.prototype.shutdown = function () { return this.conn.request('shutdown', null); };

      // ══════════════════════════════════════════════════════════
      //  6. 编辑器集成（CodeMirror 诊断渲染 / 悬浮 / 跳转）
      // ══════════════════════════════════════════════════════════
      var state = {
        editor: null, client: null, server: null, conn: null,
        uri: null, langId: 'javascript', version: 0, opened: false,
        ready: false, starting: false,
        marks: [], gutterLines: [], diags: [], diagIdx: -1,
        checkTimer: 0, hoverTimer: 0, tooltipEl: null, lastHoverKey: null,
        bound: false
      };

      var SUPPORTED = { javascript: 1, javascriptreact: 1, typescript: 1, typescriptreact: 1 };

      function envForDoc() {
        var p = currentPath();
        var base = p ? String(p).replace(/\\/g, '/').split('/').pop() : '';
        var m = base.match(/\.([^.]+)$/);
        var ext = (m ? m[1] : '').toLowerCase();
        var langId = null, name = base || 'script.js';
        if (ext === 'tsx') langId = 'typescriptreact';
        else if (ext === 'ts') langId = 'typescript';
        else if (ext === 'jsx') langId = 'javascriptreact';
        else if (ext === 'js' || ext === 'mjs' || ext === 'cjs') langId = 'javascript';
        else if (!ext) { langId = 'javascript'; if (base) name = base + '.js'; }
        if (!langId) langId = 'unsupported'; // html/json/md/... 等不诊断
        return { uri: 'pgpy:///' + name, name: name, langId: langId };
      }

      function setStatus(text, kind, title) {
        var el = document.getElementById('pgpyLspStatus');
        if (!el) return;
        el.textContent = text;
        var cls = 'pgpy-lsp-status pgpy-lsp-';
        cls += (kind === 'ok') ? 'ok' : (kind === 'error') ? 'error' : (kind === 'warning') ? 'warning' : (kind === 'loading') ? 'loading' : 'idle';
        el.className = cls;
        if (title !== undefined) el.title = title;
      }

      function ensureGutter(cm) {
        var gutters = (cm.getOption('gutters') || ['CodeMirror-linenumbers']).slice();
        if (gutters.indexOf('pgpy-lsp-gutter') === -1) gutters.push('pgpy-lsp-gutter');
        cm.setOption('gutters', gutters);
      }

      function clampPos(cm, p) {
        var last = cm.lastLine();
        var line = (p && typeof p.line === 'number') ? p.line : 0;
        if (line < 0) line = 0; if (line > last) line = last;
        var text = cm.getLine(line) || '';
        var ch = (p && typeof p.character === 'number') ? p.character : 0;
        if (ch < 0) ch = 0; if (ch > text.length) ch = text.length;
        return { line: line, ch: ch };
      }

      function clearDiagnostics() {
        var cm = state.editor; if (!cm) return;
        state.marks.forEach(function (m) { try { m.clear(); } catch (_) {} });
        state.marks = [];
        state.gutterLines.forEach(function (ln) { try { cm.setGutterMarker(ln, 'pgpy-lsp-gutter', null); } catch (_) {} });
        state.gutterLines = [];
      }

      function renderDiagnostics(diags) {
        var cm = state.editor; if (!cm) return;
        clearDiagnostics();
        var byLine = new Map();
        var sevClass = { 1: 'pgpy-lsp-error', 2: 'pgpy-lsp-warning', 3: 'pgpy-lsp-info', 4: 'pgpy-lsp-info' };
        for (var i = 0; i < diags.length; i++) {
          var d = diags[i], r = d.range || {};
          var s = clampPos(cm, r.start);
          var e = clampPos(cm, r.end);
          if (e.line < s.line || (e.line === s.line && e.ch <= s.ch)) {
            e = { line: s.line, ch: Math.min((cm.getLine(s.line) || '').length, s.ch + 1) };
          }
          try {
            var mk = cm.markText(s, e, { className: 'pgpy-lsp-underline ' + (sevClass[d.severity] || 'pgpy-lsp-error') });
            state.marks.push(mk);
          } catch (_) {}
          if (!byLine.has(s.line)) byLine.set(s.line, []);
          byLine.get(s.line).push(d);
        }
        byLine.forEach(function (arr, line) {
          var sev = 4, tip = [];
          for (var k = 0; k < arr.length; k++) {
            sev = Math.min(sev, arr[k].severity || 1);
            tip.push('TS' + arr[k].code + ': ' + arr[k].message);
          }
          var el = document.createElement('span');
          el.className = 'pgpy-lsp-gutter-dot ' + (sev === 1 ? 'is-error' : sev === 2 ? 'is-warning' : 'is-info');
          el.textContent = '●';
          el.title = tip.join('\n');
          try { cm.setGutterMarker(line, 'pgpy-lsp-gutter', el); } catch (_) {}
          state.gutterLines.push(line);
        });
      }

      function updateStatusBadge() {
        var errs = 0, warns = 0;
        for (var i = 0; i < state.diags.length; i++) {
          if ((state.diags[i].severity || 1) === 1) errs++;
          else if (state.diags[i].severity === 2) warns++;
        }
        if (errs === 0 && warns === 0) setStatus('LSP · 无问题', 'ok', 'tsserver 诊断：未发现问题');
        else {
          var parts = [];
          if (errs) parts.push('✖ ' + errs);
          if (warns) parts.push('⚠ ' + warns);
          setStatus('LSP · ' + parts.join(' '), errs ? 'error' : 'warning',
            'tsserver 诊断：' + errs + ' 个错误、' + warns + ' 个警告（点击跳到下一个问题）');
        }
      }

      function onDiagnostics(p) {
        if (!p || p.uri !== state.uri) return;
        state.diags = p.diagnostics || [];
        renderDiagnostics(state.diags);
        updateStatusBadge();
      }

      function pushDoc() {
        if (!state.ready || !state.editor) return;
        var env = envForDoc();
        if (!SUPPORTED[env.langId]) {
          if (state.opened && state.uri) { try { state.client.didClose(state.uri); } catch (_) {} state.opened = false; }
          state.uri = env.uri; state.diags = [];
          clearDiagnostics();
          setStatus('LSP · 非 JS/TS', 'idle', '当前文件不是 JavaScript/TypeScript，已暂停诊断');
          return;
        }
        if (state.uri !== env.uri || !state.opened) {
          if (state.opened && state.uri) { try { state.client.didClose(state.uri); } catch (_) {} }
          state.uri = env.uri; state.langId = env.langId; state.version = 1; state.opened = true;
          state.client.didOpen(env.uri, state.editor.getValue(), env.langId);
        } else {
          state.version++;
          state.client.didChange(state.uri, state.editor.getValue(), state.version);
        }
      }

      function scheduleCheck() {
        clearTimeout(state.checkTimer);
        if (!state.ready) return;
        setStatus('LSP · 分析中…', 'loading');
        state.checkTimer = setTimeout(function () {
          try { pushDoc(); } catch (e) { warn('check failed', e); }
        }, CFG.debounceMs);
      }

      // ── 悬浮提示 ────────────────────────────────────────────
      function ensureTooltip() {
        if (state.tooltipEl) return state.tooltipEl;
        var el = document.createElement('div');
        el.className = 'pgpy-lsp-tooltip';
        el.style.display = 'none';
        document.body.appendChild(el);
        state.tooltipEl = el;
        return el;
      }
      function hideTooltip() {
        if (state.tooltipEl) state.tooltipEl.style.display = 'none';
        state.lastHoverKey = null;
      }
      function showTooltip(cm, pos, html) {
        var el = ensureTooltip();
        el.innerHTML = html;
        el.style.display = 'block';
        var c = cm.charCoords(pos, 'window');
        var x = c.left, y = c.bottom + 6, w = el.offsetWidth, h = el.offsetHeight;
        if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8);
        if (y + h > window.innerHeight - 8) y = Math.max(8, c.top - h - 6);
        el.style.left = x + 'px'; el.style.top = y + 'px';
      }
      function diagnosticsAt(pos) {
        var out = [];
        for (var i = 0; i < state.diags.length; i++) {
          var r = state.diags[i].range; if (!r) continue;
          if (pos.line < r.start.line || pos.line > r.end.line) continue;
          if (pos.line === r.start.line && pos.ch < r.start.character) continue;
          if (pos.line === r.end.line && pos.ch > r.end.character) continue;
          out.push(state.diags[i]);
        }
        return out;
      }
      function doHover(cm, ev) {
        if (!state.ready || !cm.getWrapperElement()) return;
        var rect = cm.getWrapperElement().getBoundingClientRect();
        var pos = cm.coordsChar({ left: ev.clientX - rect.left, top: ev.clientY - rect.top });
        if (!pos) return;
        var ds = diagnosticsAt(pos);
        var key = pos.line + ':' + pos.ch;
        if (ds.length) {
          if (state.lastHoverKey === 'd:' + key) return;
          state.lastHoverKey = 'd:' + key;
          var html = '';
          for (var i = 0; i < ds.length; i++) {
            var cls = ds[i].severity === 1 ? 'err' : ds[i].severity === 2 ? 'warn' : 'info';
            html += '<div class="pgpy-lsp-tt-item ' + cls + '"><b>TS' + ds[i].code + '</b> ' + escapeHtml(ds[i].message) + '</div>';
          }
          showTooltip(cm, pos, html);
          return;
        }
        if (!state.uri || !state.opened) return;
        state.client.hover(state.uri, { line: pos.line, character: pos.ch }).then(function (res) {
          if (!res || !res.contents) return;
          var val = typeof res.contents === 'string' ? res.contents : (res.contents.value || '');
          if (!val) return;
          if (state.lastHoverKey === 'h:' + key) return;
          state.lastHoverKey = 'h:' + key;
          showTooltip(cm, pos, '<pre class="pgpy-lsp-tt-pre">' + escapeHtml(val) + '</pre>');
        }).catch(function () {});
      }

      // ── 问题导航 ────────────────────────────────────────────
      function gotoDiag(i) {
        var cm = state.editor; if (!cm || !state.diags.length) return;
        var d = state.diags[((i % state.diags.length) + state.diags.length) % state.diags.length];
        var pos = clampPos(cm, (d.range || {}).start);
        cm.setCursor(pos); cm.focus();
        try {
          var c = cm.charCoords(pos, 'local');
          cm.scrollTo(null, c.top - cm.getWrapperElement().clientHeight / 2);
        } catch (_) {}
      }
      function nextDiag() {
        if (!state.diags.length) { setStatus('LSP · 无问题', 'ok'); return; }
        state.diagIdx = (state.diagIdx + 1) % state.diags.length;
        gotoDiag(state.diagIdx);
      }

      // ── 编辑器事件绑定 ──────────────────────────────────────
      function bindEditor(cm) {
        if (state.bound) return;
        state.bound = true;
        cm.on('change', function () { scheduleCheck(); });
        cm.on('scroll', hideTooltip);
        var wrap = cm.getWrapperElement();
        wrap.addEventListener('mousemove', function (ev) {
          clearTimeout(state.hoverTimer);
          state.hoverTimer = setTimeout(function () { doHover(cm, ev); }, CFG.hoverDelayMs);
        });
        wrap.addEventListener('mouseleave', hideTooltip);
        var badge = document.getElementById('pgpyLspStatus');
        if (badge) { badge.style.cursor = 'pointer'; badge.addEventListener('click', function () { hideTooltip(); nextDiag(); }); }
      }

      // ══════════════════════════════════════════════════════════
      //  7. 启动 / 对外接口
      // ══════════════════════════════════════════════════════════
      function start() {
        if (state.starting) return state._startPromise;
        state.starting = true;
        setStatus('LSP · 加载引擎…', 'loading', '正在加载 TypeScript 语言服务（tsserver）…');
        state._startPromise = (function () {
          var ports = createPortPair();
          var clientConn = new RpcConnection(ports[0], 'client');
          var serverConn = new RpcConnection(ports[1], 'server');
          var client = new LspClient(clientConn);
          var server = new TsServer();
          attachServer(serverConn, server);
          state.conn = clientConn; state.client = client; state.server = server;
          clientConn.onNotification('textDocument/publishDiagnostics', onDiagnostics);
          return client.initialize(null).then(function (info) {
            state.ready = true;
            log('language server ready:', JSON.stringify(info && info.serverInfo));
            client.initialized();
            setStatus('LSP · 就绪', 'ok', 'tsserver 就绪');
            pushDoc();
          });
        })().catch(function (e) {
          warn('LSP 启动失败：', e && e.message || e);
          setStatus('LSP · 不可用', 'error', 'Language Server 启动失败：' + ((e && e.message) || e));
        }).then(function () { state.starting = false; return state.ready; });
        return state._startPromise;
      }

      function attach(editor) {
        if (!editor || state.editor === editor) return;
        state.editor = editor;
        ensureGutter(editor);
        bindEditor(editor);
        setStatus('LSP · 启动中…', 'loading');
        start();
      }

      function recheck() { if (state.ready) pushDoc(); else start(); }

      window.PgpLsp = {
        attach: attach,
        recheck: recheck,
        loadEngine: loadEngine,
        nextProblem: nextDiag,
        get diagnostics() { return state.diags.slice(); },
        _state: state
      };
      log('PgpLsp module loaded');
    })();
