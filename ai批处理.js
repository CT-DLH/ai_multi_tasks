// ==UserScript==
// @name         智谱AI 悬浮助手（多模态+批量图片URL+表格模式）
// @namespace    http://tampermonkey.net/
// @version      6.0
// @description  支持图片URL输入、CSV批量图片理解（根据表头自动识别）、并发处理、表格模式、中途导出
// @author       AI助手
// @match        *://*/*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @require      https://cdn.tailwindcss.com
// ==/UserScript==

(function() {
    'use strict';

    // ===================== 核心配置 =====================
    const API = {
        SYNC: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        ASYNC: "https://open.bigmodel.cn/api/paas/v4/async/chat/completions",
        RESULT: "https://open.bigmodel.cn/api/paas/v4/async-result/"
    };
    const MODEL_LIST = [
        { label: "GLM-4.7-Flash（文本）", value: "glm-4.7-flash" },
        { label: "GLM-4V-Flash（免费视觉）", value: "glm-4v-flash" },
        { label: "GLM-4.6V-Flash（视觉图像）", value: "glm-4.6v-flash" },
        { label: "GLM-4.1V-Thinking-Flash（视觉图像）", value: "glm-4.1v-thinking-flash" },
        { label: "GLM-4-Flash", value: "glm-4-flash-250414" },
    ];
    const VISION_MODELS = ["glm-4v-flash", "glm-4.6v-flash", "glm-4.1v-thinking-flash"]; // 用于自动切换
    const STORAGE = {
        API_KEY: "ZHIPU_API_KEY", MODEL: "ZHIPU_MODEL", TEMP: "ZHIPU_TEMP",
        PROMPT: "ZHIPU_PROMPT", FORMAT: "ZHIPU_FORMAT", MODE: "ZHIPU_MODE",
        PROMPT_MODE: "ZHIPU_PROMPT_MODE", CSV_ENCODING: "CSV_ENCODING",
        WIDGET_STATE: "WIDGET_STATE", WIDGET_POS: "WIDGET_POS",
        TABLE_MODE: "TABLE_MODE", BATCH_SIZE: "BATCH_SIZE",
        IMAGE_URL: "IMAGE_URL" // 新增：保存图片URL输入
    };
    const CONCURRENCY_LIMIT = 5;
    // ==================================================

    // 全局状态
    let isRequesting = false;
    let batchResults = [];
    let isMinimized = false;

    // 样式
    GM_addStyle(`
        #zhipu-chat-widget {
            backdrop-filter: blur(8px);
            background: linear-gradient(145deg, #ffffff 0%, #f8fafc 100%);
            box-shadow: 0 20px 40px -12px rgba(0,0,0,0.25);
        }
        #zhipu-chat-widget input, #zhipu-chat-widget select, #zhipu-chat-widget textarea {
            transition: all 0.2s;
            border: 1px solid #e2e8f0;
        }
        #zhipu-chat-widget input:focus, #zhipu-chat-widget select:focus, #zhipu-chat-widget textarea:focus {
            border-color: #3b82f6;
            box-shadow: 0 0 0 3px rgba(59,130,246,0.2);
            outline: none;
        }
        #zhipu-chat-widget button {
            transition: all 0.2s;
            font-weight: 500;
        }
        #zhipu-chat-widget button:active {
            transform: scale(0.97);
        }
        #chat-content::-webkit-scrollbar {
            width: 6px;
        }
        #chat-content::-webkit-scrollbar-track {
            background: #f1f1f1;
            border-radius: 10px;
        }
        #chat-content::-webkit-scrollbar-thumb {
            background: #cbd5e0;
            border-radius: 10px;
        }
        .loading-spin {
            animation: spin 1s linear infinite;
        }
        @keyframes spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
        }
    `);

    // 1. 生成界面（增加图片URL输入框）
    function createChatWindow() {
        const html = `
        <div id="zhipu-chat-widget" class="fixed bottom-6 right-6 w-96 h-[600px] rounded-2xl flex flex-col z-[9999] border border-gray-200/50 transition-all duration-300 overflow-hidden">
            <!-- 拖拽栏 -->
            <div id="drag-handle" class="px-4 py-3 bg-gradient-to-r from-blue-600 to-blue-500 text-white flex justify-between items-center cursor-move shrink-0">
                <span class="text-sm font-semibold tracking-wide flex items-center gap-2">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"></path></svg>
                    智谱AI 批量助手
                </span>
                <div class="flex gap-2">
                    <button id="reset-pos-btn" class="hover:bg-blue-400 p-1 rounded" title="重置位置">⟳</button>
                    <button id="clear-chat-btn" class="hover:bg-blue-400 p-1 rounded" title="清空对话">🗑</button>
                    <button id="minimize-btn" class="hover:bg-blue-400 p-1 rounded" title="最小化">−</button>
                    <button id="close-btn" class="hover:bg-blue-400 p-1 rounded" title="关闭">×</button>
                </div>
            </div>

            <!-- 基础配置区 -->
            <div class="p-3 border-b border-gray-200/70 space-y-2 text-xs bg-white/50 shrink-0">
                <input id="zhipu-api-key" placeholder="请输入API Key" class="w-full px-3 py-2 text-sm border rounded-lg bg-white">
                <div class="grid grid-cols-2 gap-2">
                    <select id="zhipu-model" class="px-3 py-2 border rounded-lg bg-white">
                        ${MODEL_LIST.map(m => `<option value="${m.value}">${m.label}</option>`).join('')}
                    </select>
                    <select id="output-format" class="px-3 py-2 border rounded-lg bg-white">
                        <option value="text">文本输出</option>
                        <option value="json_object">JSON输出</option>
                    </select>
                </div>
                <div class="flex items-center gap-3">
                    <span class="text-gray-600">温度:</span>
                    <input type="range" id="temperature" min="0" max="1" step="0.1" class="w-24">
                    <span id="temp-value" class="text-blue-600 font-mono w-8">0.7</span>
                    <select id="chat-mode" class="flex-1 px-3 py-2 border rounded-lg bg-white">
                        <option value="sync">同步对话</option>
                        <option value="async">异步批量</option>
                    </select>
                </div>
            </div>

            <!-- 提示词模板区 -->
            <div class="p-3 border-b border-gray-200/70 bg-white/50 shrink-0">
                <div class="flex gap-2 mb-1">
                    <select id="prompt-mode" class="flex-1 px-3 py-2 text-xs border rounded-lg bg-white">
                        <option value="normal">普通模式</option>
                        <option value="template">JSON模板({text}替换)</option>
                    </select>
                </div>
                <textarea id="prompt-template" rows="2" placeholder="自定义提示词模板，支持{text}占位符（自动保存）" class="w-full px-3 py-2 text-xs border rounded-lg resize-none bg-white"></textarea>
            </div>

            <!-- 批量处理区 -->
            <div id="batch-panel" class="p-3 border-b border-gray-200/70 bg-white/50 hidden shrink-0">
                <div class="flex items-center gap-2 mb-2">
                    <input type="file" id="csv-file" accept=".csv" class="text-xs flex-1 file:mr-2 file:py-1 file:px-3 file:border-0 file:text-xs file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100">
                    <select id="csv-encoding" class="px-2 py-1 text-xs border rounded-lg bg-white">
                        <option value="utf-8">UTF-8</option>
                        <option value="gbk">GBK</option>
                        <option value="gb2312">GB2312</option>
                    </select>
                </div>
                <!-- 表格模式控制 -->
                <div class="flex items-center gap-2 mb-2">
                    <label class="flex items-center gap-1 text-xs">
                        <input type="checkbox" id="table-mode" class="rounded"> 表格模式（多行合并，仅支持纯文本）
                    </label>
                    <input type="number" id="batch-size" min="1" max="100" value="10" class="w-16 px-2 py-1 text-xs border rounded-lg">
                    <span class="text-xs">行/批</span>
                </div>
                <div class="flex gap-2 mb-1">
                    <button id="start-batch-btn" class="flex-1 px-3 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-xs shadow">开始批量</button>
                    <button id="export-btn" class="flex-1 px-3 py-2 bg-yellow-500 hover:bg-yellow-600 text-white rounded-lg text-xs shadow">导出CSV</button>
                </div>
                <div class="w-full bg-gray-200 rounded-full h-1.5 mt-1">
                    <div id="batch-progress" class="h-full bg-green-500 w-0 rounded-full"></div>
                </div>
            </div>

            <!-- 对话/结果区 -->
            <div id="chat-content" class="flex-1 p-3 overflow-y-auto text-sm space-y-3 bg-gray-50/30"></div>

            <!-- 输入区（增强：增加图片URL输入框） -->
            <div class="p-3 border-t border-gray-200/70 bg-white flex flex-col gap-2 shrink-0">
                <input id="image-url-input" placeholder="图片URL (可选，仅同步模式有效)" class="w-full px-3 py-2 text-sm border rounded-lg bg-white">
                <div class="flex gap-2">
                    <input id="user-input" placeholder="同步对话输入...(回车发送)" class="flex-1 px-3 py-2 text-sm border rounded-lg bg-white">
                    <button id="send-btn" class="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm shadow-md">发送</button>
                </div>
            </div>
        </div>
        `;
        document.body.insertAdjacentHTML('beforeend', html);

        const encodingSelect = document.getElementById('csv-encoding');
        encodingSelect.value = GM_getValue(STORAGE.CSV_ENCODING, 'utf-8');
        encodingSelect.addEventListener('change', () => GM_setValue(STORAGE.CSV_ENCODING, encodingSelect.value));
    }

    // 2. 拖拽功能（不变）
    function initDrag() {
        const dragHandle = document.getElementById('drag-handle');
        const chatWidget = document.getElementById('zhipu-chat-widget');
        let isDragging = false;
        let startX, startY, startLeft, startTop;

        const savedPos = GM_getValue(STORAGE.WIDGET_POS, null);
        if (savedPos) {
            chatWidget.style.left = savedPos.left + 'px';
            chatWidget.style.top = savedPos.top + 'px';
            chatWidget.style.bottom = 'auto';
            chatWidget.style.right = 'auto';
        }

        dragHandle.addEventListener('mousedown', (e) => {
            isDragging = true;
            const rect = chatWidget.getBoundingClientRect();
            startX = e.clientX;
            startY = e.clientY;
            startLeft = rect.left;
            startTop = rect.top;

            document.body.style.userSelect = 'none';
            chatWidget.style.cursor = 'grabbing';
            chatWidget.style.willChange = 'transform';
            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            requestAnimationFrame(() => {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                chatWidget.style.transform = `translate(${dx}px, ${dy}px)`;
            });
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                const transform = chatWidget.style.transform;
                if (transform) {
                    const match = transform.match(/translate\(([^,]+)px,\s*([^)]+)px\)/);
                    if (match) {
                        const dx = parseFloat(match[1]);
                        const dy = parseFloat(match[2]);
                        let newLeft = startLeft + dx;
                        let newTop = startTop + dy;

                        const maxLeft = window.innerWidth - chatWidget.offsetWidth;
                        const maxTop = window.innerHeight - chatWidget.offsetHeight;
                        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                        newTop = Math.max(0, Math.min(newTop, maxTop));

                        chatWidget.style.left = newLeft + 'px';
                        chatWidget.style.top = newTop + 'px';
                        chatWidget.style.bottom = 'auto';
                        chatWidget.style.right = 'auto';

                        GM_setValue(STORAGE.WIDGET_POS, { left: newLeft, top: newTop });
                    }
                }
                chatWidget.style.transform = '';
                chatWidget.style.willChange = '';
                chatWidget.style.cursor = 'default';
                document.body.style.userSelect = '';
            }
        });

        document.getElementById('reset-pos-btn').addEventListener('click', () => {
            chatWidget.style.left = 'auto';
            chatWidget.style.top = 'auto';
            chatWidget.style.bottom = '24px';
            chatWidget.style.right = '24px';
            chatWidget.style.transform = '';
            GM_setValue(STORAGE.WIDGET_POS, null);
        });
    }

    // 3. 本地存储（增加图片URL保存）
    function initStorage() {
        const dom = {
            key: document.getElementById('zhipu-api-key'),
            model: document.getElementById('zhipu-model'),
            temp: document.getElementById('temperature'),
            tempVal: document.getElementById('temp-value'),
            prompt: document.getElementById('prompt-template'),
            format: document.getElementById('output-format'),
            mode: document.getElementById('chat-mode'),
            promptMode: document.getElementById('prompt-mode'),
            tableMode: document.getElementById('table-mode'),
            batchSize: document.getElementById('batch-size'),
            imageUrl: document.getElementById('image-url-input')
        };

        dom.key.value = GM_getValue(STORAGE.API_KEY, '');
        dom.model.value = GM_getValue(STORAGE.MODEL, MODEL_LIST[0].value);
        const savedTemp = GM_getValue(STORAGE.TEMP, '0.7');
        dom.temp.value = savedTemp;
        dom.tempVal.textContent = savedTemp;
        dom.prompt.value = GM_getValue(STORAGE.PROMPT, '');
        dom.format.value = GM_getValue(STORAGE.FORMAT, 'text');
        dom.mode.value = GM_getValue(STORAGE.MODE, 'sync');
        dom.promptMode.value = GM_getValue(STORAGE.PROMPT_MODE, 'template');
        dom.tableMode.checked = GM_getValue(STORAGE.TABLE_MODE, false);
        dom.batchSize.value = GM_getValue(STORAGE.BATCH_SIZE, 10);
        dom.imageUrl.value = GM_getValue(STORAGE.IMAGE_URL, '');
        isMinimized = GM_getValue(STORAGE.WIDGET_STATE, false);

        let timeout;
        const save = (key, getter) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => GM_setValue(key, getter()), 500);
        };

        dom.key.addEventListener('input', () => save(STORAGE.API_KEY, () => dom.key.value.trim()));
        dom.model.addEventListener('change', () => GM_setValue(STORAGE.MODEL, dom.model.value));
        dom.temp.addEventListener('input', () => {
            const v = dom.temp.value;
            dom.tempVal.textContent = v;
            save(STORAGE.TEMP, () => v);
        });
        dom.prompt.addEventListener('input', () => save(STORAGE.PROMPT, () => dom.prompt.value.trim()));
        dom.format.addEventListener('change', () => GM_setValue(STORAGE.FORMAT, dom.format.value));
        dom.mode.addEventListener('change', () => GM_setValue(STORAGE.MODE, dom.mode.value));
        dom.promptMode.addEventListener('change', () => GM_setValue(STORAGE.PROMPT_MODE, dom.promptMode.value));
        dom.tableMode.addEventListener('change', () => GM_setValue(STORAGE.TABLE_MODE, dom.tableMode.checked));
        dom.batchSize.addEventListener('input', () => save(STORAGE.BATCH_SIZE, () => dom.batchSize.value));
        dom.imageUrl.addEventListener('input', () => save(STORAGE.IMAGE_URL, () => dom.imageUrl.value.trim()));
    }

    // 4. 消息渲染
    function addMessage(content, isUser = false, isBatch = false) {
        const chatContent = document.getElementById('chat-content');
        const cleanContent = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
        const cls = isUser
            ? 'ml-auto bg-blue-500 text-white p-2 rounded-xl max-w-[85%] break-words shadow-sm'
            : isBatch
                ? 'w-full bg-green-50 border border-green-100 p-2 rounded-lg my-1 break-words text-xs shadow-sm'
                : 'mr-auto bg-gray-100 p-2 rounded-xl max-w-[85%] break-words shadow-sm';
        chatContent.insertAdjacentHTML('beforeend', `<div class="${cls}">${cleanContent}</div>`);
        chatContent.scrollTop = chatContent.scrollHeight;
    }

    // 5. 清空对话
    function clearChat() {
        document.getElementById('chat-content').innerHTML = '<div class="text-center text-gray-400 text-xs py-4">对话已清空</div>';
        batchResults = [];
        document.getElementById('batch-progress').style.width = '0%';
    }

    // 6. 工具函数
    function cleanJsonContent(raw) {
        if (!raw) return '';
        return raw.replace(/```json/gi, '').replace(/```/g, '').replace(/`/g, '').trim();
    }
    function safeParseJson(str) {
        try {
            return JSON.parse(cleanJsonContent(str));
        } catch (e) {
            return null;
        }
    }

    // 解析Markdown表格
    function parseMarkdownTable(markdown) {
        const lines = markdown.split('\n');
        const tableLines = lines.filter(line => line.trim().startsWith('|') && line.includes('|'));
        if (tableLines.length < 2) return [];
        const dataLines = tableLines.filter((line, index) => index !== 1);
        return dataLines.map(line => {
            return line.split('|').slice(1, -1).map(cell => cell.trim());
        });
    }

    // 7. 构建提示词（纯文本时使用）
    function buildPrompt(text) {
        const template = document.getElementById('prompt-template').value.trim();
        const mode = document.getElementById('prompt-mode').value;
        const format = document.getElementById('output-format').value;

        let prompt = template || '';
        if (mode === 'normal') {
            prompt = prompt ? `${prompt}\n${text}` : text;
        } else if (mode === 'template') {
            prompt = prompt ? prompt.replace(/{text}/g, text) : text;
        }

        if (format === 'json_object') {
            prompt += '\n【严格要求】只返回标准JSON，无任何多余内容、无markdown、无乱码，直接返回{"":"","":""} 格式。';
        }
        return prompt.trim();
    }

    // 8. 检查并自动切换视觉模型
    function ensureVisionModel(hasImage) {
        if (!hasImage) return; // 没有图片，无需切换
        const modelSelect = document.getElementById('zhipu-model');
        const currentModel = modelSelect.value;
        if (!VISION_MODELS.includes(currentModel)) {
            // 自动切换为免费视觉模型 glm-4v-flash
            modelSelect.value = 'glm-4v-flash';
            GM_setValue(STORAGE.MODEL, 'glm-4v-flash');
            addMessage('ℹ️ 检测到图片URL，已自动切换为视觉模型 glm-4v-flash', false, true);
        }
    }

    // 9. 构建请求体（支持多模态）
    function buildRequestBody(text, imageUrl, isStream = false) {
        const model = document.getElementById('zhipu-model').value;
        const temp = parseFloat(document.getElementById('temperature').value);
        const format = document.getElementById('output-format').value;
        const prompt = buildPrompt(text); // 注意：图片模式下，提示词仍然需要构建（可能包含{text}占位符）

        let messages = [];
        if (imageUrl && VISION_MODELS.includes(model)) {
            // 多模态消息
            const content = [];
            // 先放图片
            content.push({
                type: "image_url",
                image_url: { url: imageUrl }
            });
            // 再放文本（如果文本非空）
            if (prompt) {
                content.push({
                    type: "text",
                    text: prompt
                });
            }
            messages = [{ role: "user", content }];
        } else {
            // 纯文本
            messages = [{ role: "user", content: prompt }];
        }

        const body = {
            model,
            temperature: temp,
            messages,
            ...(isStream && { stream: true }),
            ...(format === "json_object" && !imageUrl && { response_format: { type: "json_object" } }) // 视觉模型不支持response_format? 暂不支持
        };
        return body;
    }

    // 10. 同步发送（支持图片URL）
    async function sendSyncMessage() {
        const apiKey = document.getElementById('zhipu-api-key').value.trim();
        const input = document.getElementById('user-input').value.trim();
        const imageUrl = document.getElementById('image-url-input').value.trim();
        const sendBtn = document.getElementById('send-btn');
        const userInput = document.getElementById('user-input');

        if (!apiKey) return alert('请输入API Key');
        if (!input && !imageUrl) return; // 至少有一个
        if (isRequesting) return;

        // 如果有图片，确保视觉模型
        if (imageUrl) {
            ensureVisionModel(true);
        }

        isRequesting = true;
        sendBtn.disabled = true;
        sendBtn.innerHTML = '<span class="loading-spin">⏳</span> 发送中';
        userInput.disabled = true;
        document.getElementById('image-url-input').disabled = true;

        // 构造显示消息
        let displayMsg = input || '';
        if (imageUrl) displayMsg += `\n[图片: ${imageUrl}]`;
        addMessage(displayMsg, true);

        const body = buildRequestBody(input, imageUrl, true); // stream = true

        try {
            const res = await fetch(API.SYNC, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(body)
            });

            if (!res.ok) {
                const errData = await res.json().catch(() => ({}));
                throw new Error(`API错误 ${res.status}：${errData.error?.message || '请求失败'}`);
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let reply = '';
            addMessage('', false);
            const ele = document.getElementById('chat-content').lastElementChild;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const lines = decoder.decode(value).split('\n').filter(i => i.trim());
                for (let line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const str = line.replace('data: ', '');
                    if (str === '[DONE]') break;
                    try {
                        const data = JSON.parse(str);
                        reply += data.choices[0]?.delta?.content || '';
                        ele.textContent = cleanJsonContent(reply);
                    } catch {}
                }
            }
        } catch (e) {
            addMessage(`❌ ${e.message}`, false);
        } finally {
            isRequesting = false;
            sendBtn.disabled = false;
            sendBtn.textContent = '发送';
            userInput.disabled = false;
            document.getElementById('image-url-input').disabled = false;
            userInput.focus();
        }
    }

    // 11. 异步任务创建（支持图片）
    async function createAsyncTask(text, imageUrl = null) {
        const apiKey = document.getElementById('zhipu-api-key').value.trim();
        const body = buildRequestBody(text, imageUrl, false); // 异步不需要stream

        const res = await fetch(API.ASYNC, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify(body)
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(`创建任务失败：${err.error?.message || res.status}`);
        }

        const data = await res.json();
        if (!data.id) throw new Error('任务ID获取失败');
        return data.id;
    }

    async function getAsyncResult(taskId, timeout = 300000) {
        const apiKey = document.getElementById('zhipu-api-key').value.trim();
        const start = Date.now();
        while (true) {
            if (Date.now() - start > timeout) throw new Error('轮询超时（5分钟）');
            const res = await fetch(`${API.RESULT}${taskId}`, {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            const data = await res.json();
            if (data.task_status === 'SUCCESS') {
                return cleanJsonContent(data.choices[0].message.content);
            }
            if (data.task_status === 'FAIL') throw new Error('任务执行失败');
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    // 12. CSV解析（保持不变）
    async function parseCSV(file, encoding) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const uint8Array = new Uint8Array(e.target.result);
                    const decoder = new TextDecoder(encoding, { ignoreBOM: false });
                    let text = decoder.decode(uint8Array);
                    if (text.includes('�') && encoding !== 'utf-8') {
                        text = new TextDecoder('utf-8').decode(uint8Array);
                    }
                    const rows = text.split(/\r?\n/).filter(i => i.trim());
                    resolve(rows);
                } catch (err) {
                    const text = new TextDecoder('utf-8').decode(e.target.result);
                    const rows = text.split(/\r?\n/).filter(i => i.trim());
                    resolve(rows);
                }
            };
            reader.onerror = () => reject(reader.error);
            reader.readAsArrayBuffer(file);
        });
    }

    // 13. 批量处理（支持图片列）
    async function startBatchProcess() {
        const file = document.getElementById('csv-file').files[0];
        const startBtn = document.getElementById('start-batch-btn');
        if (!file) return alert('请上传CSV文件');
        if (isRequesting) return;

        const encoding = document.getElementById('csv-encoding').value;
        let tableMode = document.getElementById('table-mode').checked;
        const batchSize = parseInt(document.getElementById('batch-size').value, 10) || 10;

        isRequesting = true;
        startBtn.disabled = true;
        startBtn.innerHTML = '<span class="loading-spin">⏳</span> 处理中';

        let rows;
        try {
            rows = await parseCSV(file, encoding);
        } catch (e) {
            addMessage(`❌ 文件解析失败：${e.message}`, false, true);
            isRequesting = false;
            startBtn.disabled = false;
            startBtn.textContent = '开始批量';
            return;
        }

        if (rows.length === 0) {
            addMessage('❌ CSV文件为空', false, true);
            isRequesting = false;
            startBtn.disabled = false;
            startBtn.textContent = '开始批量';
            return;
        }

        // 解析表头
        const headerRow = rows[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase()); // 简单解析，不处理复杂引号
        const textColIndex = headerRow.findIndex(h => h === 'text' || h === '内容' || h === '文本');
        const imageColIndex = headerRow.findIndex(h => h === 'image_url' || h === '图片url' || h === '图片地址');
        const hasImageCol = imageColIndex !== -1;

        // 如果存在图片列，禁用表格模式并提示
        if (hasImageCol && tableMode) {
            addMessage('⚠️ 检测到图片列，表格模式已自动禁用（不支持图片批量合并）', false, true);
            tableMode = false;
            document.getElementById('table-mode').checked = false;
            GM_setValue(STORAGE.TABLE_MODE, false);
        }

        // 构建数据行（跳过表头）
        const dataRows = rows.slice(1).map(row => {
            const cols = row.split(',').map(c => c.replace(/^"|"$/g, '').trim());
            const text = (textColIndex !== -1 && cols[textColIndex]) ? cols[textColIndex] : row; // 如果没有text列，整行作为文本
            const imageUrl = (hasImageCol && cols[imageColIndex]) ? cols[imageColIndex] : null;
            return { text, imageUrl };
        }).filter(item => item.text || item.imageUrl); // 至少有一个

        const total = dataRows.length;
        let success = 0;
        let processed = 0;
        batchResults = [];

        addMessage(`📊 开始批量处理，共${total}行 | 编码：${encoding} | 图片列：${hasImageCol ? '是' : '否'} | 表格模式：${tableMode ? '是' : '否'}`, false, true);
        if (hasImageCol) {
            ensureVisionModel(true); // 确保选择了视觉模型
        }

        // 构建任务队列
        let tasks = [];
        if (tableMode) {
            // 表格模式：按批次分组（仅纯文本）
            for (let i = 0; i < total; i += batchSize) {
                const batchItems = dataRows.slice(i, i + batchSize);
                const batchTexts = batchItems.map(item => item.text).filter(t => t);
                const batchIndices = Array.from({ length: batchItems.length }, (_, idx) => i + idx);
                tasks.push({ type: 'batch', texts: batchTexts, indices: batchIndices });
            }
        } else {
            // 普通模式：每行一个任务
            tasks = dataRows.map((item, index) => ({ type: 'single', text: item.text, imageUrl: item.imageUrl, index }));
        }

        const processSingle = async (text, imageUrl, index) => {
            try {
                const taskId = await createAsyncTask(text, imageUrl);
                const result = await getAsyncResult(taskId);
                success++;
                batchResults.push({ row: index + 2, text, imageUrl, result }); // 行号从2开始（含表头）
                addMessage(`✅ 第${index+2}行完成：${result.substring(0, 80)}...`, false, true);
            } catch (e) {
                addMessage(`❌ 第${index+2}行失败：${e.message}`, false, true);
            } finally {
                processed++;
                document.getElementById('batch-progress').style.width = `${(processed / total) * 100}%`;
            }
        };

        const processBatch = async (texts, indices) => {
            if (!texts.length) return;
            try {
                const combined = texts.join('\n');
                const taskId = await createAsyncTask(combined, null); // 批量模式不支持图片
                const result = await getAsyncResult(taskId);
                const table = parseMarkdownTable(result);
                if (table.length === 0) {
                    throw new Error('返回内容不是有效的Markdown表格');
                }
                const headers = table[0];
                const dataRowsTable = table.slice(1);
                if (dataRowsTable.length !== texts.length) {
                    addMessage(`⚠️ 表格行数(${dataRowsTable.length})与输入行数(${texts.length})不匹配，请检查提示词`, false, true);
                }
                dataRowsTable.forEach((rowCells, idx) => {
                    const originalIndex = indices[idx];
                    const originalText = texts[idx];
                    const rowObj = {};
                    headers.forEach((header, colIdx) => {
                        rowObj[header] = rowCells[colIdx] || '';
                    });
                    batchResults.push({
                        row: originalIndex + 2,
                        text: originalText,
                        result: result,
                        parsed: rowObj
                    });
                });
                success += texts.length;
                addMessage(`✅ 批次 ${indices[0]+2}-${indices[indices.length-1]+2} 完成，共 ${texts.length} 行`, false, true);
            } catch (e) {
                addMessage(`❌ 批次 ${indices[0]+2}-${indices[indices.length-1]+2} 失败：${e.message}`, false, true);
            } finally {
                processed += texts.length;
                document.getElementById('batch-progress').style.width = `${(processed / total) * 100}%`;
            }
        };

        const queue = [...tasks];
        const workers = Array(CONCURRENCY_LIMIT).fill(null).map(async () => {
            while (queue.length) {
                const task = queue.shift();
                if (task.type === 'single') {
                    await processSingle(task.text, task.imageUrl, task.index);
                } else {
                    await processBatch(task.texts, task.indices);
                }
            }
        });
        await Promise.all(workers);

        addMessage(`🎉 批量完成：成功${success}/${total}，点击导出CSV`, false, true);
        isRequesting = false;
        startBtn.disabled = false;
        startBtn.textContent = '开始批量';
    }

    // 14. 导出CSV（增加图片URL列）
    function exportResults() {
        if (batchResults.length === 0) return alert('无结果可导出');

        const isPartial = isRequesting;
        if (isPartial) {
            addMessage('ℹ️ 正在批量处理中，导出已完成的部分结果...', false, true);
        }

        const allKeys = new Set();
        const parsedData = batchResults.map(item => {
            if (item.parsed) {
                Object.keys(item.parsed).forEach(k => allKeys.add(k));
                return { ...item, json: item.parsed };
            }
            const json = safeParseJson(item.result);
            if (json) Object.keys(json).forEach(k => allKeys.add(k));
            return { ...item, json };
        });
        const keys = Array.from(allKeys);

        const headers = ['行号', '原文', '图片URL', '原始结果', ...keys];
        let csv = headers.join(',') + '\n';

        parsedData.forEach(item => {
            const escapedResult = (item.result || '').replace(/"/g, '""');
            const row = [
                item.row,
                `"${(item.text || '').replace(/"/g, '""')}"`,
                `"${(item.imageUrl || '').replace(/"/g, '""')}"`,
                `"${escapedResult}"`,
                ...keys.map(k => `"${((item.json && item.json[k]) || '').replace(/"/g, '""')}"`)
            ];
            csv += row.join(',') + '\n';
        });

        const blob = new Blob(["\ufeff" + csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `智谱AI批量结果${isPartial ? '_partial' : ''}_${new Date().getTime()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    }

    // 15. 模式切换（同步模式下启用图片输入框）
    function toggleMode() {
        const mode = document.getElementById('chat-mode').value;
        const batchPanel = document.getElementById('batch-panel');
        const userInput = document.getElementById('user-input');
        const sendBtn = document.getElementById('send-btn');
        const imageUrlInput = document.getElementById('image-url-input');

        if (mode === 'async') {
            batchPanel.classList.remove('hidden');
            userInput.placeholder = '批量模式无需输入';
            userInput.disabled = true;
            sendBtn.disabled = true;
            imageUrlInput.disabled = true;
            imageUrlInput.placeholder = '批量模式图片URL无效';
        } else {
            batchPanel.classList.add('hidden');
            userInput.placeholder = '同步对话输入...(回车发送)';
            userInput.disabled = false;
            sendBtn.disabled = false;
            imageUrlInput.disabled = false;
            imageUrlInput.placeholder = '图片URL (可选)';
            userInput.focus();
        }
    }

    // 16. 最小化功能（不变）
    function initMinimize() {
        const dom = {
            mini: document.getElementById('minimize-btn'),
            widget: document.getElementById('zhipu-chat-widget'),
        };
        const hideElements = [
            dom.widget.querySelector('.border-b'),
            document.getElementById('chat-content'),
            dom.widget.querySelector('.border-t'),
            document.getElementById('batch-panel')
        ];

        if (isMinimized) {
            dom.widget.classList.remove('h-[600px]');
            dom.widget.classList.add('h-12');
            hideElements.forEach(el => el?.classList.add('hidden'));
        }

        dom.mini.addEventListener('click', () => {
            isMinimized = !isMinimized;
            GM_setValue(STORAGE.WIDGET_STATE, isMinimized);
            dom.widget.classList.toggle('h-[600px]');
            dom.widget.classList.toggle('h-12');
            hideElements.forEach(el => el?.classList.toggle('hidden'));
        });
    }

    // 17. 初始化
    function init() {
        createChatWindow();
        initDrag();
        initStorage();
        initMinimize();

        const dom = {
            send: document.getElementById('send-btn'),
            input: document.getElementById('user-input'),
            clear: document.getElementById('clear-chat-btn'),
            close: document.getElementById('close-btn'),
            mode: document.getElementById('chat-mode'),
            batchStart: document.getElementById('start-batch-btn'),
            export: document.getElementById('export-btn'),
            widget: document.getElementById('zhipu-chat-widget'),
            imageUrl: document.getElementById('image-url-input')
        };

        dom.send.addEventListener('click', sendSyncMessage);
        dom.input.addEventListener('keypress', e => e.key === 'Enter' && sendSyncMessage());
        dom.clear.addEventListener('click', clearChat);
        dom.mode.addEventListener('change', toggleMode);
        dom.batchStart.addEventListener('click', startBatchProcess);
        dom.export.addEventListener('click', exportResults);
        dom.close.addEventListener('click', () => dom.widget.remove());

        toggleMode();
        clearChat();
        dom.input.focus();
    }

    window.addEventListener('load', init);
})();
