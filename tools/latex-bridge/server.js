#!/usr/bin/env node
'use strict';

/**
 * AI-Translator LaTeX 编译桥接服务（M3）。
 *
 * 契约见 docs/v2_overleaf_latex_plan.md §3.1，逐条照做，不许自由发挥：
 *   - Node 原生 http，零 npm 依赖
 *   - 仅监听 127.0.0.1:8181（回环）
 *   - CORS：page 是 file://，Origin 是 "null"，必须回 Access-Control-Allow-Origin: *
 *     并正确处理 OPTIONS 预检
 *   - 编译命令：latexmk -pdf -interaction=nonstopmode -file-line-error -synctex=1
 *     -jobname=output -outdir=<tmp> <mainFile>（-jobname=output 是为了让全部产物都叫
 *     output.*，跟 Overleaf §2.6.7 的命名完全对齐：output.pdf/.log/.aux/.bbl/.blg/.out/
 *     .synctex.gz……）
 *   - 中间文件一律 -outdir 到临时目录，绝不污染用户的源码文件夹
 *   - 成功判定：PDF 文件是否存在，退出码永远只是日志里的一条信息，不是判据（见规划 §1.5）
 *   - 单次编译硬超时 120s，超时杀掉整棵进程树
 *   - 同一时间只允许一个编译在跑，新请求来了先杀掉旧的
 *   - 显式不加 -shell-escape（latexmk 默认就是关的）——这不是安全加固，是功能正确性，
 *     开着会让任意 .tex 变成任意代码执行
 *
 * 启动：node tools/latex-bridge/server.js
 * 用法见同目录 README.md。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const HOST = '127.0.0.1';
const PORT = 8181;

// TeX Live 路径（规划 §1.4 实测）。允许用 LATEX_BRIDGE_TEXBIN 环境变量覆盖，方便别的机器上跑。
const TEXBIN = process.env.LATEX_BRIDGE_TEXBIN || 'E:\\texlive\\2025\\bin\\windows';
const LATEXMK = path.join(TEXBIN, process.platform === 'win32' ? 'latexmk.exe' : 'latexmk');

// 全部编译产物都落在系统临时目录下的这个子目录，绝不碰用户的项目文件夹。
const WORK_ROOT = path.join(os.tmpdir(), 'ai-translator-latex-bridge');
try { fs.mkdirSync(WORK_ROOT, { recursive: true }); } catch (e) {}

const COMPILE_TIMEOUT_MS = 120000;

let currentChild = null;
let currentChildId = null;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function cors(res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, code, obj) {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
    res.end(body);
}

function sendText(res, code, text, contentType) {
    const body = Buffer.from(text, 'utf8');
    res.writeHead(code, { 'Content-Type': (contentType || 'text/plain; charset=utf-8'), 'Content-Length': body.length });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function killTree(pid) {
    if (!pid) return;
    if (process.platform === 'win32') {
        try { execSync('taskkill /pid ' + pid + ' /T /F', { stdio: 'ignore' }); } catch (e) {}
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
    }
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeOutdirForId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return path.join(WORK_ROOT, id);
}

// -file-line-error 打开后，真正的 fatal error 是 "<file>:<line>: <message>" 这个形状。
// Warning 一律带字面量 "Warning:"。Overfull/Underfull box 是第三种。
// 其余（版本横幅、"Output written on"、"No file xxx.aux" 之类）归为 info，
// 但只挑几种有信息量的模式，不然每一行日志都会被当成 info，计数没有意义。
// TeX 的 .log 按 max_print_line（默认 79 列）硬折行，折行处没有空格、没有缩进，
// 纯粹是在第 79 个字符处截断接着下一行写。不还原的话长消息（比如带绝对路径的
// "File `...' not found" 警告）会被从中间切断，warnRe/boxRe 匹配不上后半截。
// 还原算法：连续把"长度正好等于 79"的行与下一行粘起来，直到粘出一行长度 != 79。
function unwrapLogLines(rawLines) {
    const out = [];
    let i = 0;
    while (i < rawLines.length) {
        let acc = rawLines[i];
        while (acc.length === 79 && i + 1 < rawLines.length) {
            i++;
            acc += rawLines[i];
        }
        out.push(acc);
        i++;
    }
    return out;
}

function parseLog(logText) {
    const lines = unwrapLogLines(logText.split(/\r?\n/));
    const entries = [];
    const fileLineRe = /^([^\s:][^:]*\.(?:tex|sty|cls|bbl)):(\d+):\s*(.+)$/;
    const warnRe = /(LaTeX|Package \S+|Class \S+) Warning:\s*(.+)$/;
    const boxRe = /^(Overfull|Underfull) \\(hbox|vbox)\s*\(([^)]*)\)\s*(.*)$/;
    const lineNumRe = /(?:on input line|at lines?)\s+(\d+)/;
    const infoRe = /^(No file |Package: |Document Class:|LaTeX Font Info:|Package \S+ Info:)/;

    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.trim();
        if (!line) continue;

        let m = fileLineRe.exec(line);
        if (m) {
            entries.push({ level: 'error', file: m[1], line: Number(m[2]), message: m[3].trim() });
            continue;
        }

        m = warnRe.exec(line);
        if (m) {
            const lm = lineNumRe.exec(line);
            entries.push({ level: 'warning', file: null, line: lm ? Number(lm[1]) : null, message: line });
            continue;
        }

        m = boxRe.exec(line);
        if (m) {
            const lm = lineNumRe.exec(line);
            entries.push({ level: 'warning', file: null, line: lm ? Number(lm[1]) : null, message: line });
            continue;
        }

        if (infoRe.test(line)) {
            entries.push({ level: 'info', file: null, line: null, message: line });
            continue;
        }
    }
    return entries;
}

function listOutputFiles(outdir) {
    try {
        return fs.readdirSync(outdir).filter((f) => {
            try { return fs.statSync(path.join(outdir, f)).isFile(); } catch (e) { return false; }
        }).sort();
    } catch (e) {
        return [];
    }
}

function contentTypeFor(name) {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') return 'application/pdf';
    if (ext === '.gz') return 'application/gzip';
    if (ext === '.log' || ext === '.txt' || ext === '.stdout' || ext === '.stderr' || ext === '.out') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// /compile
// ---------------------------------------------------------------------------

function doCompile(projectDir, mainFile) {
    return new Promise((resolve) => {
        const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
        const outdir = path.join(WORK_ROOT, id);
        let resolved = false;
        const startedAt = Date.now();

        try { fs.mkdirSync(outdir, { recursive: true }); } catch (e) {
            resolve({ ok: false, error: 'mkdir outdir failed: ' + e.message });
            return;
        }

        const mainAbs = path.isAbsolute(mainFile) ? mainFile : path.join(projectDir, mainFile);
        if (!fs.existsSync(mainAbs)) {
            resolve({ ok: false, error: 'main file not found: ' + mainAbs });
            return;
        }
        if (!fs.existsSync(LATEXMK)) {
            resolve({ ok: false, error: 'latexmk.exe not found at ' + LATEXMK + '（检查 LATEX_BRIDGE_TEXBIN / TeX Live 是否安装）' });
            return;
        }

        // 同一时间只允许一个编译在跑；新请求来了先杀掉旧的（§3.1 契约）。
        if (currentChild) {
            try { killTree(currentChild.pid); } catch (e) {}
            currentChild = null;
        }

        const args = [
            '-pdf',
            '-interaction=nonstopmode',
            '-file-line-error',
            '-synctex=1',
            '-jobname=output',
            '-outdir=' + outdir,
            mainAbs
        ];

        let stdoutBuf = [];
        let stderrBuf = [];
        let child;
        try {
            child = spawn(LATEXMK, args, { cwd: projectDir, windowsHide: true });
        } catch (e) {
            resolve({ ok: false, error: 'spawn latexmk failed: ' + e.message });
            return;
        }
        currentChild = child;
        currentChildId = id;

        const timer = setTimeout(() => {
            if (resolved) return;
            finish(null, true);
        }, COMPILE_TIMEOUT_MS);

        child.stdout.on('data', (c) => stdoutBuf.push(c));
        child.stderr.on('data', (c) => stderrBuf.push(c));

        child.on('error', (err) => {
            if (resolved) return;
            clearTimeout(timer);
            resolved = true;
            resolve({ ok: false, error: 'latexmk process error: ' + err.message });
        });

        child.on('close', (code) => finish(code, false));

        function finish(exitCode, timedOut) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (currentChild === child) { currentChild = null; currentChildId = null; }
            if (timedOut) {
                try { killTree(child.pid); } catch (e) {}
            }

            const durationMs = Date.now() - startedAt;
            const stdoutText = Buffer.concat(stdoutBuf).toString('utf8');
            const stderrText = Buffer.concat(stderrBuf).toString('utf8');
            try { fs.writeFileSync(path.join(outdir, 'output.stdout'), stdoutText); } catch (e) {}
            try { fs.writeFileSync(path.join(outdir, 'output.stderr'), stderrText); } catch (e) {}

            const logPath = path.join(outdir, 'output.log');
            let logText = '';
            let logSource = 'output.log';
            if (fs.existsSync(logPath)) {
                try { logText = fs.readFileSync(logPath, 'latin1'); } catch (e) { logText = ''; }
            }
            if (!logText) {
                logText = stdoutText || stderrText;
                logSource = 'stdout（未找到 output.log，用进程标准输出兜底）';
            }

            const pdfPath = path.join(outdir, 'output.pdf');
            const pdfExists = fs.existsSync(pdfPath);
            let pdfSize = 0;
            if (pdfExists) { try { pdfSize = fs.statSync(pdfPath).size; } catch (e) {} }

            const parsed = parseLog(logText);
            const counts = { error: 0, warning: 0, info: 0 };
            parsed.forEach((e) => { if (counts[e.level] !== undefined) counts[e.level]++; });

            const synctexPath = path.join(outdir, 'output.synctex.gz');

            resolve({
                ok: pdfExists, // §1.5 硬规定：成功 = PDF 存在，不是退出码
                id: id,
                exitCode: (exitCode === null ? null : exitCode),
                timedOut: !!timedOut,
                durationMs: durationMs,
                pdfExists: pdfExists,
                pdfSize: pdfSize,
                synctexExists: fs.existsSync(synctexPath),
                logSource: logSource,
                log: logText,
                parsed: parsed,
                counts: counts,
                files: listOutputFiles(outdir)
            });
        }
    });
}

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    cors(res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const u = new URL(req.url, 'http://' + HOST + ':' + PORT);
    const pathname = decodeURIComponent(u.pathname);

    try {
        if (req.method === 'GET' && pathname === '/health') {
            sendJson(res, 200, {
                ok: true,
                pid: process.pid,
                node: process.version,
                latexmkPath: LATEXMK,
                latexmkExists: fs.existsSync(LATEXMK),
                workRoot: WORK_ROOT
            });
            return;
        }

        if (req.method === 'GET' && pathname === '/') {
            sendText(res, 200, 'AI-Translator latex-bridge is running. POST /compile, GET /health, GET /output/:id/:file, POST /clear');
            return;
        }

        if (req.method === 'POST' && pathname === '/compile') {
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            const mainFile = body.mainFile || 'main.tex';
            if (!projectDir || typeof projectDir !== 'string') {
                sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' });
                return;
            }
            if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
                sendJson(res, 400, { ok: false, error: 'projectDir 不存在或不是目录: ' + projectDir });
                return;
            }
            const result = await doCompile(projectDir, mainFile);
            sendJson(res, 200, result);
            return;
        }

        if (req.method === 'GET' && pathname.indexOf('/output/') === 0) {
            const rest = pathname.slice('/output/'.length);
            const parts = rest.split('/');
            if (parts.length !== 2) { sendJson(res, 400, { ok: false, error: 'expected /output/:id/:filename' }); return; }
            const id = parts[0];
            const filename = path.basename(parts[1]); // 防目录穿越
            const outdir = safeOutdirForId(id);
            if (!outdir) { sendJson(res, 400, { ok: false, error: 'invalid id' }); return; }
            const filePath = path.join(outdir, filename);
            if (!filePath.startsWith(outdir)) { sendJson(res, 400, { ok: false, error: 'invalid path' }); return; }
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                sendJson(res, 404, { ok: false, error: 'file not found: ' + filename });
                return;
            }
            const data = fs.readFileSync(filePath);
            res.writeHead(200, {
                'Content-Type': contentTypeFor(filename),
                'Content-Length': data.length,
                'Content-Disposition': 'inline; filename="' + filename + '"'
            });
            res.end(data);
            return;
        }

        if (req.method === 'POST' && pathname === '/clear') {
            const bodyText = await readBody(req);
            let body = {};
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {}
            if (body.id) {
                const outdir = safeOutdirForId(body.id);
                if (!outdir) { sendJson(res, 400, { ok: false, error: 'invalid id' }); return; }
                try { fs.rmSync(outdir, { recursive: true, force: true }); } catch (e) {}
                sendJson(res, 200, { ok: true, cleared: body.id });
                return;
            }
            // 不带 id：清空全部缓存的编译产物（对应 Overleaf 的 "Clear cached files"）。
            try {
                const entries = fs.readdirSync(WORK_ROOT);
                entries.forEach((e) => {
                    try { fs.rmSync(path.join(WORK_ROOT, e), { recursive: true, force: true }); } catch (e2) {}
                });
            } catch (e) {}
            sendJson(res, 200, { ok: true, clearedAll: true });
            return;
        }

        sendJson(res, 404, { ok: false, error: 'no such route: ' + req.method + ' ' + pathname });
    } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message) });
    }
});

server.listen(PORT, HOST, () => {
    console.log('[latex-bridge] listening on http://' + HOST + ':' + PORT);
    console.log('[latex-bridge] latexmk: ' + LATEXMK + (fs.existsSync(LATEXMK) ? ' (found)' : ' (MISSING!)'));
    console.log('[latex-bridge] work root: ' + WORK_ROOT);
});

process.on('SIGINT', () => { try { killTree(currentChild && currentChild.pid); } catch (e) {} process.exit(0); });
