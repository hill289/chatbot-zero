        // ══════════════════════════════════════════════════════════════
        //  文件读取工具配置与通用校验（对齐 read_file 优化逻辑）
        //   · 单行超长自动截断，超长行可用 read_file_line_slice 查看后半部分
        //   · 单次读取总字符上限，避免一次返回过大内容
        //   · 超过 MAX_FILE_SIZE 的文件 / 二进制文件拒绝以文本方式读取
        //  注意：Office(docx/xlsx/pptx)/PDF/图片 的专门解析逻辑保持不变（见 read_file 内）
        // ══════════════════════════════════════════════════════════════
        const FILE_TOOL_CONFIG = {
            MAX_LINE_CHARS: 1000,    // read_file 单行最多展示多少字符（超出给头尾摘要）
            MAX_TOTAL_CHARS: 8000,   // 保留：search_content / 汇总等仍按字符口径
            LINE_SLICE_LIMIT: 1000,  // read_file_line_slice 默认读取长度
            MAX_FILE_SIZE: 1024 * 1024 * 2, // 2MB：超过则不整份解码（改走汇总 / char_range / run_node）
            BINARY_SAMPLE_SIZE: 1024, // 采样前1024字节判断二进制
            BINARY_THRESHOLD: 0.3,   // 不可打印字符占比>30% → 判定二进制
            // ── 读取窗口（预算单位是 token，不是行；策略见 renderer/read-window.js）──
            READ_MAX_LINES: 400,             // 默认每次最多返回的行数
            READ_HARD_MAX_LINES: 2000,       // 硬上限（显式指定 start/end 时也不超过它）
            READ_MAX_TOKENS: 6000,           // 单次 read_file 结果的 token 预算
            LONG_LINE_THRESHOLD: 4000,       // 单行超此长度 → 只给头尾摘要
            CHAR_RANGE_MAX_FILE_SIZE: 64 * 1024 * 1024, // char_range 可读的上限（按偏移切片，不整份回传）
            CHAR_RANGE_MAX_LIMIT: 60000,     // char_range 单次最多返回多少字符
            // ── 汇总（summary）相关：文件过大 / 命中过多时只回传概要，避免撑爆上下文 ──
            SUMMARY_FILE_SIZE: 256 * 1024,   // read_file：文件超过 256KB 且未指定行范围时，默认只返回汇总信息
            SUMMARY_PREVIEW_LINES: 20,       // read_file 汇总：头部/尾部各预览的行数上限
            SEARCH_MAX_MATCHES: 200,         // search_content：命中行数超过该值 → 自动切换为汇总
            SEARCH_MAX_CHARS: 8000,          // search_content：输出字符超过该值 → 自动切换为汇总
            SEARCH_TOP_FILES: 20,            // search_content 汇总：列出的文件数上限
            SEARCH_SUMMARY_SAMPLE: 3         // search_content 汇总：示例命中行数上限
        };

        // 采样前 N 字节判断是否二进制：不可打印字符（0x00、0x01~0x06、0x0E~0x1F）占比 > 阈值 → 二进制
        function pgpyIsBinaryBySampling(binaryContent) {
            const sampleSize = Math.min(FILE_TOOL_CONFIG.BINARY_SAMPLE_SIZE, binaryContent.length);
            if (sampleSize <= 0) return false;
            let nonPrintable = 0;
            for (let i = 0; i < sampleSize; i++) {
                const b = binaryContent[i];
                if (b === 0 || (b >= 0x01 && b <= 0x06) || (b >= 0x0E && b <= 0x1F)) nonPrintable++;
            }
            return (nonPrintable / sampleSize) > FILE_TOOL_CONFIG.BINARY_THRESHOLD;
        }

        // 统一的工具返回封装（与既有 read_file / write_file 的返回格式保持一致）
        function pgpyToolOk(text) {
            return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(text) + "}]}";
        }
        function pgpyToolErr(text) {
            return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(text) + "}]}";
        }

        // ══════════════════════════════════════════════════════════════
        //  读取窗口的纯逻辑外置在 renderer/read-window.js（UMD），
        //  这里只做「配置注入 + 缓存 + 错误分类」三件有副作用的事。
        // ══════════════════════════════════════════════════════════════
        function pgpyRW() {
            if (typeof ReadWindow !== 'undefined' && ReadWindow) return ReadWindow;
            if (typeof require === 'function') {
                try { return require('./read-window.js'); } catch (_) {}
            }
            return null;
        }
        function pgpyReadWindowOpts() {
            return {
                maxLines: FILE_TOOL_CONFIG.READ_MAX_LINES,
                hardMaxLines: FILE_TOOL_CONFIG.READ_HARD_MAX_LINES,
                maxTokens: FILE_TOOL_CONFIG.READ_MAX_TOKENS,
                maxLineChars: FILE_TOOL_CONFIG.MAX_LINE_CHARS,
                longLineThreshold: FILE_TOOL_CONFIG.LONG_LINE_THRESHOLD
            };
        }

        // 解码结果 LRU 缓存：读一次 8.5MB 的 typescript.js 再切 1000 字符，
        // 若无缓存，每次 slice 都要重新 decode 整份文件（成本是返回内容的 8000 倍）。
        // key = 路径 + 大小 + mtime 指纹，文件一改就自动失效。
        const _readTextCache = { map: new Map(), chars: 0 };
        function pgpyStatSig(file_path) {
            try {
                const st = nodeRuntime.FS.stat(file_path);
                const mt = st.mtimeMs != null ? st.mtimeMs : (st.mtime && st.mtime.getTime ? st.mtime.getTime() : 0);
                return (st.size || 0) + ':' + mt;
            } catch (_) { return '?'; }
        }
        function pgpyPutsCache(key, text) {
            const maxEntries = 4, maxChars = 24 * 1024 * 1024;
            if (text.length > maxChars) return text;
            while (_readTextCache.map.size >= maxEntries || _readTextCache.chars + text.length > maxChars) {
                const firstKey = _readTextCache.map.keys().next().value;
                if (firstKey === undefined) break;
                _readTextCache.chars -= _readTextCache.map.get(firstKey).length;
                _readTextCache.map.delete(firstKey);
            }
            _readTextCache.map.set(key, text);
            _readTextCache.chars += text.length;
            return text;
        }
        function pgpyDecodeText(file_path, binaryContent) {
            const key = String(file_path) + '|' + (binaryContent ? binaryContent.length : 0) + '|' + pgpyStatSig(file_path);
            const hit = _readTextCache.map.get(key);
            if (hit !== undefined) {
                // LRU：命中后挪到队尾
                _readTextCache.map.delete(key);
                _readTextCache.map.set(key, hit);
                return hit;
            }
            return pgpyPutsCache(key, new TextDecoder().decode(binaryContent));
        }
        // 错误分类：ENOENT / EISDIR / EPERM / OTHER —— 不再把一切异常都说成「文件不存在」
        function pgpyErrText(tool, file_path, e) {
            const RW = pgpyRW();
            const c = RW ? RW.classifyError(e) : { code: 'OTHER', message: String(e && e.message || e) };
            if (c.code === 'ENOENT') return `错误：'${file_path}' 不存在（almostnode FS 中没有该文件；可用 list_dir 确认路径）。`;
            if (c.code === 'EISDIR') return `错误：'${file_path}' 是目录，不是文件（请改用 list_dir）。`;
            if (c.code === 'EPERM') return `错误：无权读取 '${file_path}'：${c.message}`;
            return `ERROR: ${tool} 执行失败（非「文件不存在」，请勿改路径重试）：${c.message}`;
        }

        // ══════════════════════════════════════════════════════════════
        //  数字参数容错：大模型有时会把「整型」参数以字符串形式给出
        //  （如 start_line: "5"、" 12 "），直接用 Number.isInteger() 校验
        //  会误判为非法并返回错误。这里统一先做宽松解析，再交给调用方校验：
        //    · number  → 必须为有限整数，否则返回 NaN
        //    · 字符串  → 去空白后 Number()，必须为有限整数，否则返回 NaN
        //    · 其它    → NaN
        // ══════════════════════════════════════════════════════════════
        function pgpyToInt(value) {
            if (typeof value === 'number') {
                return (Number.isFinite(value) && Number.isInteger(value)) ? value : NaN;
            }
            if (typeof value === 'string') {
                const s = value.trim();
                if (s === '') return NaN;
                const n = Number(s);
                return (Number.isFinite(n) && Number.isInteger(n)) ? n : NaN;
            }
            return NaN;
        }

        // 可选整数参数：未提供（undefined / null / 空串）返回 undefined，
        // 供调用方套用默认值；其余情况返回 pgpyToInt 的结果（非法为 NaN）。
        function pgpyToOptionalInt(value) {
            if (value === undefined || value === null) return undefined;
            if (typeof value === 'string' && value.trim() === '') return undefined;
            return pgpyToInt(value);
        }

        // 宽松解析「是否只返回汇总」开关：接受布尔 true，或字符串 'true'/'1'/'yes'。
        function pgpyIsSummaryOnly(value) {
            if (value === true) return true;
            if (typeof value === 'string') {
                const s = value.trim().toLowerCase();
                return s === 'true' || s === '1' || s === 'yes';
            }
            return false;
        }

        // 构造「文件过大 → 汇总信息」文本：只给出路径/大小/行数与少量头尾预览，
        // 不回传正文，避免超长内容撑爆上下文。
        function pgpyBuildFileSummary(file_path, byteLength, lines, totalLines, extraNote) {
            const cap = FILE_TOOL_CONFIG.MAX_LINE_CHARS;
            const shorten = (raw) => (raw.length > cap ? raw.slice(0, cap) + ' …[truncated]' : raw);
            const previewN = FILE_TOOL_CONFIG.SUMMARY_PREVIEW_LINES;
            const out = [];
            out.push(`[SUMMARY] '${file_path}' 文件过大，仅返回汇总信息（未返回正文）。`);
            out.push(`- 文件大小: ${byteLength} bytes`);
            out.push(`- 总行数: ${totalLines}`);
            const headN = Math.min(previewN, lines.length);
            if (headN > 0) {
                out.push(`- 预览(前 ${headN} 行):`);
                for (let i = 0; i < headN; i++) out.push(`${i + 1}:${shorten(lines[i])}`);
            }
            const tailN = lines.length > previewN ? Math.min(previewN, lines.length - previewN) : 0;
            if (tailN > 0) {
                out.push(`- 预览(后 ${tailN} 行):`);
                for (let i = lines.length - tailN; i < lines.length; i++) out.push(`${i + 1}:${shorten(lines[i])}`);
            }
            if (extraNote) out.push(`[说明] ${extraNote}`);
            out.push(`[提示] 如需正文，请用 start_line/end_line 读取指定行范围；或先用 search_content 定位目标内容。`);
            return out.join('\n');
        }

        // 构造「搜索命中过多 → 汇总信息」文本：给出命中统计与少量示例，不逐条回显命中行。
        function pgpyBuildSearchSummary(query, outputLines, byFile) {
            const out = [];
            out.push('[SUMMARY] 搜索命中过多，仅返回汇总信息（未逐条回显命中行）。');
            out.push(`pattern: ${query}`);
            out.push(`- 命中行数: ${outputLines.length}`);
            out.push(`- 命中文件数: ${byFile.size}`);
            const entries = Array.from(byFile.entries())
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, FILE_TOOL_CONFIG.SEARCH_TOP_FILES);
            out.push(`- 各文件命中数(最多列出前 ${FILE_TOOL_CONFIG.SEARCH_TOP_FILES} 个):`);
            for (const [p, nos] of entries) {
                const shownNos = nos.slice(0, 20).join(', ') + (nos.length > 20 ? ' …' : '');
                out.push(`  ${p}: ${nos.length} 处 (行 ${shownNos})`);
            }
            if (byFile.size > entries.length) {
                out.push(`  …另有 ${byFile.size - entries.length} 个文件未列出`);
            }
            out.push(`- 示例命中(最多 ${FILE_TOOL_CONFIG.SEARCH_SUMMARY_SAMPLE} 条):`);
            for (const s of outputLines.slice(0, FILE_TOOL_CONFIG.SEARCH_SUMMARY_SAMPLE)) out.push('  ' + s);
            out.push('[提示] 请缩小 path 范围或使用更精确的 pattern 后重试。');
            return out.join('\n');
        }


        async function read_file(params) {
            const file_path = params["file_path"];
            const start_line = params["start_line"];
            const end_line = params["end_line"];
            // 是否只返回汇总信息（显式 summary_only 时对任意大小文件都生效）
            const summaryOnly = pgpyIsSummaryOnly(params["summary_only"]);

            if (file_path === '.' || file_path === '/' || file_path === 'home/' || file_path === '/home' || file_path === 'home' || file_path === '/home/pyodide/') {
                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`当前目录是 /home/pyodide/`) + "}]}";
            }

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: read from almostnode FS
                try {
                    const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });

                    // 检测二进制文件（docx/png/jpg/pdf 等）
                    const isZipOffice = binaryContent.length >= 4 &&
                        binaryContent[0] === 0x50 && binaryContent[1] === 0x4B &&
                        (binaryContent[2] === 0x03 || binaryContent[2] === 0x07);
                    const isOtherBinary = binaryContent.length > 0 && (
                        (binaryContent[0] === 0x89 && binaryContent[1] === 0x50 && binaryContent[2] === 0x4E && binaryContent[3] === 0x47) || // PNG
                        (binaryContent[0] === 0xFF && binaryContent[1] === 0xD8) // JPEG
                    );
                    // PDF（%PDF 魔数）: 用 @iyulab/anydoc 解析为 Markdown
                    const isPdf = binaryContent.length >= 4 &&
                        binaryContent[0] === 0x25 && binaryContent[1] === 0x50 &&
                        binaryContent[2] === 0x44 && binaryContent[3] === 0x46;
                    // 旧版 Office 二进制格式（xls/doc/ppt/xlsb 等，OLE2/CFB 容器）
                    const isOleOffice = binaryContent.length >= 8 &&
                        binaryContent[0] === 0xD0 && binaryContent[1] === 0xCF &&
                        binaryContent[2] === 0x11 && binaryContent[3] === 0xE0 &&
                        binaryContent[4] === 0xA1 && binaryContent[5] === 0xB1 &&
                        binaryContent[6] === 0x1A && binaryContent[7] === 0xE1;

                    // 文档（docx/xlsx/pptx/xls/pdf 等）: 用 @iyulab/anydoc 解析为 Markdown
                    if ((isZipOffice || isOleOffice || isPdf) && typeof window.__undocParse === 'function') {
                        try {
                            const result = window.__undocParse(binaryContent);
                            const format = result.format();   // "docx" | "xlsx" | "pptx"
                            let output = result.toMarkdown();
                            if (!output || output.trim() === '') {
                                output = result.toText();  // fallback to plain text
                            }
                            // 带文件头信息
                            const header = `[${format.toUpperCase()}] ${file_path}\n${'='.repeat(40)}\n`;
                            const finalContent = header + output;
                            const lines = finalContent.split(/\r?\n/);
                            const totalLines = lines.length;
                            const startRaw = pgpyToOptionalInt(start_line);
                            const endRaw = pgpyToOptionalInt(end_line);
                            const start = (startRaw === undefined) ? 1 : startRaw;
                            const end = (endRaw === undefined) ? totalLines : endRaw;
                            if (!Number.isInteger(start) || start < 1) {
                                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`错误：'start_line' 必须是大于等于 1 的整数。`) + "}]}";
                            }
                            if (start > totalLines && totalLines > 0) {
                                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`Error: 'start_line' (${start}) exceeds total file lines (${totalLines}).`) + "}]}";
                            }
                            if (!Number.isInteger(end) || end < 1) {
                                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`错误：'end_line' 必须是大于等于 1 的整数。`) + "}]}";
                            }
                            if (end < start) {
                                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`Error: 'end_line' (${end}) cannot be less than 'start_line' (${start}).`) + "}]}";
                            }
                            const cappedEnd = Math.min(end, totalLines);
                            const slicedLines = lines.slice(start - 1, cappedEnd);
                            const numberedLines = slicedLines.map((line, index) => {
                                const lineNumber = start + index;
                                return `${lineNumber}:${line}`;
                            });
                            const hasCRLF = finalContent.includes('\r\n');
                            const lineEnding = hasCRLF ? '\r\n' : '\n';
                            const finalContentWithLines = numberedLines.join(lineEnding);
                            // ── 文件过大 / 显式汇总 → 只返回汇总信息，避免正文撑爆上下文 ──
                            const officeRangeRequested = (startRaw !== undefined) || (endRaw !== undefined);
                            if (summaryOnly || (finalContentWithLines.length > FILE_TOOL_CONFIG.MAX_TOTAL_CHARS && !officeRangeRequested)) {
                                return pgpyToolOk(pgpyBuildFileSummary(file_path, binaryContent.length, lines, totalLines,
                                    `来自 ${format.toUpperCase()} 解析结果，共 ${finalContentWithLines.length} 字符。`));
                            }
                            return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(JSON.stringify(finalContentWithLines)) + "}]}";
                        } catch (e) {
                            return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`解析 Office 文件失败：${e.message}，请尝试 run_node 方式读取。`) + "}]}";
                        }
                    }

                    // ── 图片：转成多模态 image 内容项返回，交给模型视觉理解 ──
                    //    返回 { type:'image', mimeType, data }，由 mcpStore.convertItem 转为
                    //    image_url 内容项（data:image/...;base64,...），对齐 DeepSeek 多模态接口。
                    const imgMime = pgpyDetectImageMime(binaryContent, file_path);
                    if (imgMime) {
                        // 结构校验：签名对≠文件合法。坏图一旦作为 image 内容项发出，
                        // 接口会 400 unsupported image，且该坏图会留在历史里持续报错。
                        const __imgReject = (typeof pgpyImageRejectReason === 'function')
                            ? pgpyImageRejectReason(binaryContent, imgMime)
                            : '';
                        if (__imgReject) {
                            return JSON.stringify({
                                success: false,
                                content: [{
                                    type: 'text',
                                    text: `错误：'${file_path}' 的扩展名/魔数看起来是 ${imgMime}，但实际文件不合法（${__imgReject}），` +
                                        `作为图片上传会触发接口 400 unsupported image，已拒绝。` +
                                        `请先用 run_node 解码并重新编码成合法的 PNG/JPEG 再读取（注意：该运行时 Buffer 是 polyfill，` +
                                        `没有 writeUInt32BE，写 PNG 块头要用位运算手工写）。`
                                }]
                            });
                        }
                        const b64 = pgpyBytesToBase64(binaryContent);
                        const imgHeader = `[IMAGE] ${file_path} (${imgMime}, ${binaryContent.length} bytes)`;
                        // 多模态开关：关闭时只回文本 header，不附加 image 内容项（文本模型无法看图）
                        const __multimodalOn = (typeof pgpyMultimodalEnabled === 'function')
                            ? pgpyMultimodalEnabled() : true;
                        const __imgContent = [{ type: 'text', text: imgHeader }];
                        if (__multimodalOn) {
                            __imgContent.push({ type: 'image', mimeType: imgMime, data: b64 });
                        } else {
                            __imgContent[0].text = imgHeader + '（已切换为文本模型，未附加图片）';
                        }
                        return JSON.stringify({
                            success: true,
                            content: __imgContent
                        });
                    }

                    if (isZipOffice || isOleOffice || isPdf || isOtherBinary) {
                        return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(`错误：'${file_path}' 是二进制文件，不支持以文本方式读取，请尝试 run_node 方式读取。`) + "}]}";
                    }

                    // ── 预校验：文件大小（超过 MAX_FILE_SIZE 不再解码正文，给出可执行的替代路径）──
                    if (binaryContent.length > FILE_TOOL_CONFIG.MAX_FILE_SIZE) {
                        return pgpyToolOk(
                            pgpyBuildFileSummary(file_path, binaryContent.length, [], '未知(文件超过解析上限，未解码正文)',
                                `文件 ${binaryContent.length} bytes 超过 ${FILE_TOOL_CONFIG.MAX_FILE_SIZE} bytes 解析上限。` +
                                `替代方案：read_file_char_range(file_path, offset=0, limit=4000) 按字符偏移分片读；` +
                                `用 search_content 定位；或 run_node 里 require()/readFileSync 自行处理。`)
                        );
                    }
                    // ── 预校验：二进制探测（采样前 N 字节，不可打印字符占比 > 阈值 → 二进制）──
                    if (pgpyIsBinaryBySampling(binaryContent)) {
                        return pgpyToolErr(`ERROR: 检测为二进制文件，read_file仅支持文本文件`);
                    }
                    const originalContent = pgpyDecodeText(file_path, binaryContent);
                    // 解码后正文含 null 字节 → 二进制文件
                    if (originalContent.includes('\u0000')) {
                        return pgpyToolErr(`错误：'${file_path}' 包含非文本数据，不支持以文本方式读取。`);
                    }
                    const lines = originalContent.split(/\r?\n/);
                    const totalLines = lines.length;

                    // 参数缺省值处理与越界校验（容错：大模型可能把行号生成为字符串，如 "5"）
                    const startRaw = pgpyToOptionalInt(start_line);
                    const endRaw = pgpyToOptionalInt(end_line);
                    const start = (startRaw === undefined) ? 1 : startRaw;
                    const end = (endRaw === undefined) ? totalLines : endRaw;

                    if (!Number.isInteger(start) || start < 1) {
                        return pgpyToolErr(`错误：'start_line' 必须是大于等于 1 的整数。`);
                    }
                    if (start > totalLines && totalLines > 0) {
                        return pgpyToolErr(`Error: 'start_line' (${start}) exceeds total file lines (${totalLines}).`);
                    }
                    if (!Number.isInteger(end) || end < 1) {
                        return pgpyToolErr(`错误：'end_line' 必须是大于等于 1 的整数。`);
                    }
                    if (end < start) {
                        return pgpyToolErr(`Error: 'end_line' (${end}) cannot be less than 'start_line' (${start}).`);
                    }

                    const rangeRequested = (startRaw !== undefined) || (endRaw !== undefined);
                    // ── 形状探测：行数不是预算（mermaid.min.js 的「2000 行」是 3.2MB，
                    //    12-render.js 的「2000 行」是 137KB），先看形状再决定怎么读 ──
                    const RW = pgpyRW();
                    if (!RW) {
                        return pgpyToolErr('ERROR: read-window.js 未加载，read_file 无法规划读取窗口。');
                    }
                    const shape = RW.probe(originalContent, { lines: lines, bytes: binaryContent.length });
                    const seenPlan = RW.plan(shape, Object.assign(pgpyReadWindowOpts(), { explicitRange: rangeRequested }));

                    // ── 文件过大 → 只返回汇总信息，避免正文撑爆上下文 ──
                    //   压缩包不走这条：结构摘要比「头 20 行」有用得多（min.js 的第 1 行就有 27 万字符）
                    if (summaryOnly || (binaryContent.length > FILE_TOOL_CONFIG.SUMMARY_FILE_SIZE && !rangeRequested && shape.kind !== 'minified')) {
                        return pgpyToolOk(pgpyBuildFileSummary(file_path, binaryContent.length, lines, totalLines));
                    }

                    // 压缩包 / 超大文件：不逐行读，直接给「这是什么」+ 替代工具
                    if (!seenPlan.allowBody && !(rangeRequested && seenPlan.mode === 'minified')) {
                        return pgpyToolOk(RW.summarizeStructure(file_path, originalContent, shape, pgpyReadWindowOpts()));
                    }

                    const win = RW.sliceByLines(lines, start, end, Object.assign(pgpyReadWindowOpts(), {
                        maxLines: seenPlan.maxLines,
                        maxTokens: seenPlan.maxTokens
                    }));
                    if (!win.ok) return pgpyToolErr(win.error);
                    return pgpyToolOk(win.text);
                } catch (e) {
                    return pgpyToolErr(pgpyErrText('read_file', file_path, e));
                }
            }

            return pgpyToolErr(`错误：'${file_path}' 无法读取（almostnode 运行时未就绪；请先导入文件或用 list_dir 确认路径）。`);
        }

        // ══════════════════════════════════════════════════════════════
        //  list_dir：列出目录下的文件与子文件夹（[DIR] / [FILE] 标记）
        //   · dir_path 缺省/'.'/'/' → /home/pyodide；相对路径按工作区解析
        // ══════════════════════════════════════════════════════════════
        async function list_dir(params) {
            params = params || {};
            const dir_path = params["dir_path"];

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                const FS = nodeRuntime.FS;
                let target = (dir_path == null || dir_path === '' || dir_path === '.' || dir_path === './' || dir_path === '/') ?
                    '/home/pyodide' : String(dir_path);
                if (!target.startsWith('/')) target = '/home/pyodide/' + target.replace(/^\.\//, '');
                try {
                    const stat = FS.stat(target);
                    if (!FS.isDir(stat.mode)) {
                        return pgpyToolErr(`ERROR: ${(dir_path == null ? '.' : dir_path)} 不是目录`);
                    }
                    const entries = FS.readdir(target);
                    const lines = [];
                    for (const name of entries) {
                        if (name === '.' || name === '..') continue;
                        const full = target === '/' ? '/' + name : target + '/' + name;
                        let s;
                        try { s = FS.stat(full); } catch (_) { continue; }
                        lines.push(FS.isDir(s.mode) ? (`[DIR] ${name}`) : (`[FILE] ${name}`));
                    }
                    return pgpyToolOk(lines.join('\n'));
                } catch (err) {
                    return pgpyToolErr(`ERROR: list_dir exception: ${(err && err.message) ? err.message : err}`);
                }
            }
            return pgpyToolErr(`ERROR: list_dir exception: almostnode FS not ready`);
        }

        // ══════════════════════════════════════════════════════════════
        //  window.__vfsServeRead —— vfs:// 协议的「渲染层取字节」桥
        //   主进程 protocol.handle('vfs')（main.js）通过 executeJavaScript 调到这里，
        //   从 almostnode FS 读出文件字节 / 目录清单，供内置浏览器标签渲染。
        //   只读、只允许 /home/pyodide 下的路径；返回值必须是可结构化克隆的纯对象。
        // ══════════════════════════════════════════════════════════════
        window.__vfsServeRead = function (vpath) {
            try {
                if (!(typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime && nodeRuntime.ready)) {
                    return { ok: false, error: 'almostnode 运行时未就绪（请等工作台加载完成）' };
                }
                var p = String(vpath == null ? '' : vpath).trim();
                if (!p) return { ok: false, error: '路径为空' };
                var FS = nodeRuntime.FS;
                var stat;
                try { stat = FS.stat(p); } catch (_) { return { ok: false, error: '文件不存在：' + p }; }
                if (FS.isDir(stat.mode)) {
                    var names = FS.readdir(p);
                    var entries = [];
                    for (var i = 0; i < names.length; i++) {
                        var n = names[i];
                        if (n === '.' || n === '..' || n === 'default.profraw') continue;
                        var full = p === '/' ? '/' + n : p + '/' + n;
                        var es;
                        try { es = FS.stat(full); } catch (_) { continue; }
                        entries.push({ name: n, isDir: FS.isDir(es.mode), size: es.size || 0 });
                    }
                    return { ok: true, isDir: true, entries: entries };
                }
                var bin = nodeRuntime.vfs.readFileSync(p);
                if (!bin) return { ok: false, error: '文件为空或不可读：' + p };
                var len = bin.byteLength != null ? bin.byteLength : bin.length;
                if (len > 128 * 1024 * 1024) return { ok: false, error: '文件过大（>128MB），请改用导出下载浏览' };
                return { ok: true, isDir: false, dataBase64: pgpyBytesToBase64(bin), size: len };
            } catch (e) {
                return { ok: false, error: String((e && e.message) || e) };
            }
        };

        // ══════════════════════════════════════════════════════════════
        //  read_file_line_slice：读取文件中某一行的字符片段
        //   专门用来查看被 read_file 截断的超长单行：offset 为该行内字符偏移，
        //   limit 为读取长度（默认 FILE_TOOL_CONFIG.LINE_SLICE_LIMIT）。
        //   二进制/超大文件不可读取。
        // ══════════════════════════════════════════════════════════════
        async function read_file_line_slice(params) {
            params = params || {};
            const file_path = params["file_path"];
            const line = pgpyToInt(params["line"]);   // 容错：接受字符串行号（如 "5"）
            const offset = (params["offset"] != null && Number.isFinite(Number(params["offset"]))) ? Number(params["offset"]) : 0;
            const limit = (params["limit"] != null && Number(params["limit"]) > 0) ? Number(params["limit"]) : FILE_TOOL_CONFIG.LINE_SLICE_LIMIT;

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                if (!Number.isInteger(line) || line < 1) {
                    return pgpyToolErr(`错误：'line' 必须是大于等于 1 的整数。`);
                }
                try {
                    const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                    // ── 预校验：文件大小 + 二进制探测（与 read_file 一致）──
                    if (binaryContent.length > FILE_TOOL_CONFIG.MAX_FILE_SIZE) {
                        return pgpyToolErr(`ERROR: 文件过大(${binaryContent.length} bytes)，超过 ${FILE_TOOL_CONFIG.MAX_FILE_SIZE} bytes。` +
                            `请改用 read_file_char_range(file_path, offset=0, limit=4000) 按字符偏移分片读取。`);
                    }
                    if (pgpyIsBinaryBySampling(binaryContent)) {
                        return pgpyToolErr(`ERROR: 检测为二进制文件，read_file_line_slice仅支持文本文件`);
                    }
                    const originalContent = pgpyDecodeText(file_path, binaryContent);
                    if (originalContent.includes('\u0000')) {
                        return pgpyToolErr(`错误：'${file_path}' 包含非文本数据，不支持以文本方式读取。`);
                    }
                    const lines = originalContent.split(/\r?\n/);
                    if (line > lines.length) {
                        return pgpyToolErr(`ERROR: Line ${line} not found in file (共 ${lines.length} 行)`);
                    }
                    const rawLine = lines[line - 1];
                    const RW = pgpyRW();
                    if (!RW) return pgpyToolErr('ERROR: read-window.js 未加载');
                    const r = RW.sliceByChars(rawLine, offset, Math.min(limit, FILE_TOOL_CONFIG.CHAR_RANGE_MAX_LIMIT), pgpyReadWindowOpts());
                    return pgpyToolOk(`Line ${line}, offset=${r.offset}, limit=${limit}\n${r.text}\n[Total length of this line: ${r.total}]\n${r.footer}`);
                } catch (e) {
                    return pgpyToolErr(pgpyErrText('read_file_line_slice', file_path, e));
                }
            }
            return pgpyToolErr(`错误：'${file_path}' 无法读取（almostnode 运行时未就绪）`);
        }

        // ══════════════════════════════════════════════════════════════
        //  read_file_char_range：按「字符偏移」读取任意文本片段
        //   · 这是单行巨文件（katex.min.js 1 行 275KB、almostnode.global.js 单行 1.28MB）的唯一正解
        //   · 不要求模型自己算行号，只给 offset + limit，返回里带 next_offset
        //   · 上限 64MB（只返回窗口内片段，不整份回传）
        // ══════════════════════════════════════════════════════════════
        async function read_file_char_range(params) {
            params = params || {};
            const file_path = params["file_path"];
            const offset = (params["offset"] != null && Number.isFinite(Number(params["offset"]))) ? Math.max(0, Math.floor(Number(params["offset"]))) : 0;
            let limit = (params["limit"] != null && Number(params["limit"]) > 0) ? Math.floor(Number(params["limit"])) : 4000;
            if (limit > FILE_TOOL_CONFIG.CHAR_RANGE_MAX_LIMIT) limit = FILE_TOOL_CONFIG.CHAR_RANGE_MAX_LIMIT;

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                try {
                    const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                    if (binaryContent.length > FILE_TOOL_CONFIG.CHAR_RANGE_MAX_FILE_SIZE) {
                        return pgpyToolErr(`ERROR: 文件过大(${binaryContent.length} bytes)，超过 char_range 上限 ${FILE_TOOL_CONFIG.CHAR_RANGE_MAX_FILE_SIZE} bytes，请用 run_node 处理。`);
                    }
                    if (pgpyIsBinaryBySampling(binaryContent)) {
                        return pgpyToolErr(`ERROR: 检测为二进制文件，read_file_char_range 仅支持文本文件`);
                    }
                    const originalContent = pgpyDecodeText(file_path, binaryContent);
                    if (originalContent.includes('\u0000')) {
                        return pgpyToolErr(`错误：'${file_path}' 包含非文本数据，不支持以文本方式读取。`);
                    }
                    const RW = pgpyRW();
                    if (!RW) return pgpyToolErr('ERROR: read-window.js 未加载');
                    const r = RW.sliceByChars(originalContent, offset, limit, pgpyReadWindowOpts());
                    return pgpyToolOk(`[${file_path}]\n${r.text}\n${r.footer}`);
                } catch (e) {
                    return pgpyToolErr(pgpyErrText('read_file_char_range', file_path, e));
                }
            }
            return pgpyToolErr(`错误：'${file_path}' 无法读取（almostnode 运行时未就绪）`);
        }


        async function write_file(params) {
            const file_path = params["file_path"];
            const content = params["content"];

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: write to almostnode FS
                try {
                    // Ensure parent directories exist
                    const parentDir = file_path.substring(0, file_path.lastIndexOf('/'));
                    if (parentDir && parentDir !== '') {
                        try { nodeRuntime.FS.mkdirTree(parentDir); } catch (_) {}
                    }
                    const buf = new TextEncoder().encode(content);
                    nodeRuntime.FS.writeFile(file_path, new Uint8Array(buf));
                    await pgpySyncMount(false);
                    // 内容已暂存到待同步队列（点击工具栏「同步」按钮才写回磁盘真实文件）
                    const result0 = "Written file " + file_path + " (" + countLines(content) + " lines) success.";
                    const data = "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(result0) + "}]}";
                    return data;
                } catch (e) {
                    const retcontent = "Error writing file " + file_path + " in almostnode FS: ";
                    const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                    return data;
                }
            }
            const retcontent = "Error writing file " + file_path + " in almostnode FS: ";
            const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
            return data;
        }

        async function replace_lines(params) {
			const file_path = params["file_path"];
			const new_content = params["new_content"];
			// 容错：大模型可能把行号生成为字符串（如 "5"），这里统一宽松解析为整数
			const start_line = pgpyToInt(params["start_line"]);
			const end_line = pgpyToInt(params["end_line"]);

			if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
				// Node mode: read→modify→write via almostnode FS
				try {
					const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
					const originalContent = new TextDecoder().decode(binaryContent);
					const hasCRLF = originalContent.includes('\r\n');
					const lineEnding = hasCRLF ? '\r\n' : '\n';
					const lines = originalContent.split(/\r?\n/);

					if (!Number.isInteger(end_line) || end_line < 0) {
						return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'end_line' 必须是大于等于 0 的整数。`)+"}]}";
					}
					if (!Number.isInteger(start_line) || start_line < 1) {
						return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'start_line' 必须是大于等于 1 的整数。`)+"}]}";
					}

					// 空字符串表示删除该行范围；否则去掉末尾换行后再 split，避免多插入空行
					let insertLines;
					if (new_content === '') {
						insertLines = [];
					} else {
						const trimmedTrailingNewline = new_content.replace(/\r?\n$/, '');
						insertLines = trimmedTrailingNewline.split(/\r?\n/);
					}

					if (start_line > end_line) {
						return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'start_line' (${start_line}) 不能大于 'end_line' (${end_line})。`)+"}]}";
					}
					if (start_line > lines.length || end_line > lines.length) {
						return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：行号范围 [${start_line}, ${end_line}] 越界。当前文件总共只有 ${lines.length} 行。`)+"}]}";
					}

					const deleteCount = end_line - start_line + 1;
					lines.splice(start_line - 1, deleteCount, ...insertLines);

					const updatedContent = lines.join(lineEnding);
					const buf = new TextEncoder().encode(updatedContent);
					nodeRuntime.FS.writeFile(file_path, new Uint8Array(buf));
					await pgpySyncMount(false);
					// 内容已暂存到待同步队列（点击工具栏「同步」按钮才写回磁盘真实文件）

					if (new_content === '') {
						const retcontent = "Edited the file " + file_path + " success with remove text from line " + start_line + " to line " + end_line;
						const data = "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
						return data;
					} else {
						const retcontent = "Edited the file " + file_path + " success with " + JSON.stringify(new_content);
						const data = "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
						return data;
					}
				} catch (e) {
					const retcontent = "Error editing file " + file_path + " in almostnode FS: ";
					const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
					return data;
				}
			}
			const retcontent = "Error editing file " + file_path + " in almostnode FS: ";
			const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
			return data;
		}
		
        async function add_content(params) {
            const file_path = params["file_path"];
            const replaceStr = params["add_content"];
            // 容错：大模型可能把行号生成为字符串（如 "5"），这里统一宽松解析为整数
            const startLine = pgpyToInt(params["line_number"]);

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: read→insert→write via almostnode FS
                try {
                    const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                    const originalContent = new TextDecoder().decode(binaryContent);
                    const hasCRLF = originalContent.includes('\r\n');
                    const lineEnding = hasCRLF ? '\r\n' : '\n';
                    const lines = originalContent.split(/\r?\n/);

                    if (!Number.isInteger(startLine) || startLine < 1) {
                        return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'startLine' 必须是大于等于 1 的整数。`)+"}]}";
                    }

                    const insertLines = replaceStr === '' ? [] : replaceStr.split(/\r?\n/);

                    if (startLine > lines.length + 1) {
                      return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：无法在第 ${startLine} 行前插入。当前文件总共只有 ${lines.length} 行，若想追加到文件末尾，请设置 startLine 为 ${lines.length + 1}。`)+"}]}";
                    }

                    lines.splice(startLine - 1, 0, ...insertLines);

                    const updatedContent = lines.join(lineEnding);
                    const buf = new TextEncoder().encode(updatedContent);
                    nodeRuntime.FS.writeFile(file_path, new Uint8Array(buf));
                    await pgpySyncMount(false);
                    // 内容已暂存到待同步队列（点击工具栏「同步」按钮才写回磁盘真实文件）

                    const retcontent = "Edited the file " + file_path + " success with " + JSON.stringify(replaceStr);
                    const data = "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                    return data;
                } catch (e) {
                    const retcontent = "Error editing file " + file_path + " in almostnode FS: ";
                    const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                    return data;
                }
            }
            const retcontent = "Error editing file " + file_path + " in almostnode FS: ";
            const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
            return data;
        }

        async function delete_content(params) {
            const file_path = params["file_path"];
            // 容错：大模型可能把行号生成为字符串（如 "5"），这里统一宽松解析为整数
            const startLine = pgpyToInt(params["start_line"]);
            const endLine = pgpyToInt(params["end_line"]);

            if (!Number.isInteger(startLine) || startLine < 1) {
                return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'startLine' 必须是大于等于 1 的整数。`)+"}]}";
            }
            if (!Number.isInteger(endLine) || endLine < 1) {
              return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'endLine' 必须是大于等于 1 的整数。`)+"}]}";
            }
            if (startLine > endLine) {
              return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：'startLine' (${startLine}) 不能大于 'endLine' (${endLine})。`)+"}]}";
            }

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: read→delete→write via almostnode FS
                try {
                    const binaryContent = nodeRuntime.FS.readFile(file_path, { encoding: 'binary' });
                    const originalContent = new TextDecoder().decode(binaryContent);
                    const hasCRLF = originalContent.includes('\r\n');
                    const lineEnding = hasCRLF ? '\r\n' : '\n';
                    const lines = originalContent.split(/\r?\n/);

                    if (startLine > lines.length || endLine > lines.length) {
                        return "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":"+JSON.stringify(`错误：行号范围 [${startLine}, ${endLine}] 越界。当前文件总共只有 ${lines.length} 行。`)+"}]}";
                    }

                    const deleteCount = endLine - startLine + 1;
                    lines.splice(startLine - 1, deleteCount);

                    const updatedContent = lines.join(lineEnding);
                    const buf = new TextEncoder().encode(updatedContent);
                    nodeRuntime.FS.writeFile(file_path, new Uint8Array(buf));
                    await pgpySyncMount(false);
                    // 内容已暂存到待同步队列（点击工具栏「同步」按钮才写回磁盘真实文件）

                    const retcontent = "Deleted content from line " + startLine + " to line " + endLine + " in file " + file_path + " success.";
                    const data = "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                    return data;
                } catch (e) {
                    const retcontent = "Error deleting content in file " + file_path + " from almostnode FS: ";
                    const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
                    return data;
                }
            }
            const retcontent = "Error deleting content in file " + file_path + " from almostnode FS: ";
            const data = "{\"success\":false,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(retcontent) + "}]}";
            return data;
        }

        async function search_content(params) {
            const query = params["pattern"];
            const is_regex = params["is_regex"] || false;
            const dir_path = params["path"] || null;
            const summary_only = params["summary_only"] || false;
            // 是否只返回汇总信息（命中过多 / 输出过长时也会自动切换为汇总）
            const summaryOnly = pgpyIsSummaryOnly(summary_only);

            const outputLines = [];

            if (typeof pgpyMode !== 'undefined' && pgpyMode === 'node' && nodeRuntime.ready) {
                // Node mode: walk almostnode FS once into FileEntry[] { path, content }, then run ripgrep-wasm ONCE over the whole set
                function nodeWalkFS(dir) {
                    const FS = nodeRuntime.FS;
                    try {
                        const stat = FS.stat(dir);
                        // 如果是文件，直接返回该路径
                        if (FS.isFile(stat.mode)) {
                            return [dir];
                        }
                        // 否则视为目录，进行遍历
                        const entries = FS.readdir(dir);
                        const results = [];
                        for (const entry of entries) {
                            if (entry === '.' || entry === '..') continue;
                            const full = dir === '/' ? '/' + entry : dir + '/' + entry;
                            try {
                                const subStat = FS.stat(full);
                                if (FS.isDir(subStat.mode)) {
                                    results.push(...nodeWalkFS(full));
                                } else {
                                    results.push(full);
                                }
                            } catch (_) {
                                // 忽略无法访问的条目
                            }
                        }
                        return results;
                    } catch (e) {
                        // 路径不存在或无法访问，返回空数组
                        return [];
                    }
                }

                if (typeof window.__ripgrepSearch !== 'function') {
                    const noResult = 'ripgrep-wasm not loaded. Please reload the page.';
                    return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(noResult) + "}]}";
                }

                const startDir = dir_path || '/home/pyodide';
                const allFiles = nodeWalkFS(startDir);

                // Build files: FileEntry[] = [{ path, content }, ...] — skip unreadable / binary (NUL-byte) files
                const files = [];
                for (const filePath of allFiles) {
                    try {
                        const binaryContent = nodeRuntime.FS.readFile(filePath, { encoding: 'binary' });
                        const content = new TextDecoder().decode(binaryContent);

                        if (content.includes('\u0000')) continue;

                        files.push({ path: filePath, content: content });
                    } catch (_) {}
                }

                // ripgrep-wasm: search(filesJson) — FileEntry { path, content }[], options null = regex, line-numbered
                // window.__ripgrepSearch 只执行一次，传给整个文件集合
                if (files.length > 0) {
                    const resultJson = window.__ripgrepSearch(query, JSON.stringify(files), null);

                    // WASM returns JSON string; parse to get matches
                    let parsed;
                    try {
                        parsed = JSON.parse(resultJson);
                    } catch (_) {
                        parsed = null;
                    }
                    if (parsed && parsed.matches && parsed.matches.length) {
                        for (const m of parsed.matches) {
                            const lineText = String(m.line == null ? '' : m.line);
                            const shown = lineText.length > FILE_TOOL_CONFIG.MAX_LINE_CHARS
                                ? lineText.slice(0, FILE_TOOL_CONFIG.MAX_LINE_CHARS) + ' …[truncated]'
                                : lineText;
                            outputLines.push(m.path + ":" + m.line_number + ":" + shown);
                        }
                    }
                }

                if (outputLines.length === 0) {
                    const noResult = 'No matches found for query: "' + query + '"';
                    return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(noResult) + "}]}";
                }

                // ── 命中过多 / 输出过长 → 只返回汇总信息，避免撑爆上下文 ──
                const totalChars = outputLines.reduce((n, s) => n + s.length + 1, 0);
                const needSummary = summaryOnly
                    || outputLines.length > FILE_TOOL_CONFIG.SEARCH_MAX_MATCHES
                    || totalChars > FILE_TOOL_CONFIG.SEARCH_MAX_CHARS;
                if (needSummary) {
                    // 按文件聚合命中的行号（用于生成汇总统计）
                    const byFile = new Map();
                    for (const s of outputLines) {
                        const i1 = s.indexOf(':');
                        const i2 = s.indexOf(':', i1 + 1);
                        const p = s.slice(0, i1);
                        const lineNo = s.slice(i1 + 1, i2 < 0 ? undefined : i2);
                        if (!byFile.has(p)) byFile.set(p, []);
                        byFile.get(p).push(lineNo);
                    }
                    return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(pgpyBuildSearchSummary(query, outputLines, byFile)) + "}]}";
                }

                const resultContent = outputLines.join('\n');
                return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(resultContent) + "}]}";
            }
            const noResult = 'No matches found for query: "' + query + '"';
            return "{\"success\":true,\"content\":[{\"type\":\"text\",\"text\":" + JSON.stringify(noResult) + "}]}";
        }
		
		// 全局待办列表（每个会话共享）
		let __llmTodos = [];

		// ── todo_write 兼容层 ──────────────────────────────────────────
		// 归一化各种模型/客户端传入的待办结构，统一为 { content, status, activeForm }。
		// status 支持下列常见写法（大小写/连字符不敏感）；缺省视为 pending。
		const __TODO_STATUS_ALIASES = {
			pending: ["pending", "todo", "open", "unstarted", "not_started", "not-started", "notstarted", "waiting", "queued", "backlog", "new", "未开始", "待办", "待定", "未处理"],
			in_progress: ["in_progress", "in-progress", "inprogress", "in progress", "doing", "active", "started", "ongoing", "wip", "running", "进行中", "处理中", "正在处理", "执行中"],
			completed: ["completed", "complete", "done", "finished", "finish", "success", "succeeded", "resolved", "closed", "已完成", "完成", "搞定", "结束"]
		};
		const __TODO_STATUS_MAP = (function () {
			const m = {};
			Object.keys(__TODO_STATUS_ALIASES).forEach(function (canonical) {
				__TODO_STATUS_ALIASES[canonical].forEach(function (alias) {
					m[String(alias).toLowerCase()] = canonical;
				});
			});
			return m;
		})();
		function __todoNormalizeStatus(status) {
			if (status === null || status === undefined) return "pending";
			if (typeof status === "string") return __TODO_STATUS_MAP[status.trim().toLowerCase()] || null;
			return null;
		}
		function __todoPick(obj, keys) {
			for (let i = 0; i < keys.length; i++) {
				const v = obj[keys[i]];
				if (v !== undefined && v !== null && v !== "") return v;
			}
			return undefined;
		}
		function __todoResult(ok, text) {
			return JSON.stringify({ success: !!ok, content: [{ type: "text", text: String(text) }] });
		}

		async function todo_write(params) {
			// 兼容多种入参格式：
			//   1) { todos: [...] }                 —— 标准
			//   2) [{...}, {...}]                   —— 直接传数组
			//   3) todos 为 JSON 字符串              —— 部分模型把数组序列化后传入
			//   4) { todo|items|tasks|list: [...] }  —— 其它常见键名
			let todos = params;
			if (params && typeof params === "object" && !Array.isArray(params)) {
				todos = __todoPick(params, ["todos", "todo", "items", "tasks", "list"]);
			}
			if (typeof todos === "string") {
				try { todos = JSON.parse(todos); } catch (e) { todos = null; }
			}
			if (todos && typeof todos === "object" && !Array.isArray(todos)) {
				todos = __todoPick(todos, ["todos", "todo", "items", "tasks", "list"]);
			}
			if (!Array.isArray(todos)) {
				return __todoResult(false, "错误：'todos' 必须是数组（或可解析为数组的 JSON 字符串）。");
			}

			const cleaned = [];
			for (let i = 0; i < todos.length; i++) {
				let item = todos[i];
				if (typeof item === "string") item = { content: item };
				if (!item || typeof item !== "object" || Array.isArray(item)) {
					return __todoResult(false, "错误：todos[" + i + "] 必须是对象或字符串。");
				}

				let content = __todoPick(item, ["content", "task", "text", "title", "name", "description", "summary"]);
				if (typeof content !== "string" || content.trim() === "") {
					return __todoResult(false, "错误：todos[" + i + "].content 必须是非空字符串。");
				}
				content = content.trim();

				const rawStatus = __todoPick(item, ["status", "state"]);
				const status = __todoNormalizeStatus(rawStatus);
				if (status === null) {
					return __todoResult(false, "错误：todos[" + i + "].status 取值非法：" + JSON.stringify(rawStatus) + "（应为 pending / in_progress / completed 或其常见变体）。");
				}

				const rawActive = __todoPick(item, ["activeForm", "active_form", "activeform", "active"]);
				const activeForm = (typeof rawActive === "string" && rawActive.trim() !== "") ? rawActive.trim() : content;

				cleaned.push({ content: content, status: status, activeForm: activeForm });
			}

			const inProgressCount = cleaned.filter(function (t) { return t.status === "in_progress"; }).length;
			if (inProgressCount > 1) {
				return __todoResult(false, "错误：同一时间只能有一个任务处于 'in_progress' 状态。");
			}

			__llmTodos = cleaned;
			// 同步到 planStore：持久化 + 每轮注入上下文（防长任务跑偏）
			try { planStore.setSteps(cleaned); } catch (_) {}

			const total = cleaned.length;
			const done = cleaned.filter(function (t) { return t.status === "completed"; }).length;
			const doing = cleaned.filter(function (t) { return t.status === "in_progress"; }).length;
			const pending = cleaned.filter(function (t) { return t.status === "pending"; }).length;

			const NL = String.fromCharCode(10);
			const summaryLines = cleaned.map(function (t, i) {
				const mark = t.status === "completed" ? "[x]" : t.status === "in_progress" ? "[>]" : "[ ]";
				return (i + 1) + ". " + mark + " " + t.content;
			});

			const retcontent =
				"Todo list updated (" + done + "/" + total + " completed, " + doing + " in progress, " + pending + " pending):" + NL +
				summaryLines.join(NL);

			return __todoResult(true, retcontent);
		}

