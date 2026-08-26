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
 *
 * v2 Pass P17 追加两块（跟上面 M3 契约不冲突，"零 npm 依赖"那条只管 HTTP 编译主链路；
 * WebSocket 握手手写起来容易在边界情况上出岔子，这里用 package.json 里声明的小依赖
 * "ws" 而不是自己实现，见交付说明）：
 *   - POST /pick-folder：弹原生 Windows 文件夹选择框（System.Windows.Forms.FolderBrowserDialog），
 *     子进程里跑，不阻塞 Node 事件循环处理其他并发请求。
 *   - WebSocket（同一个 127.0.0.1:8181，跟 HTTP 共用同一个 http.Server 实例升级）：前端订阅
 *     一个绝对路径，磁盘上那个文件一变就推 {type:'changed', path, mtimeMs}，不带文件内容。
 *
 * v2 Pass P18 追加：GET /project-asset —— Visual 模式 \includegraphics 真缩略图的资源来源。
 * projectDir 照样是前端每次请求带来的那个"项目绝对路径"输入框的值（跟 /compile 同一个
 * 概念、同一种"桥不自己记状态"的传参方式，没有另起一套服务器端"当前项目路径"）；
 * path 是相对路径，做一次真正的路径穿越防护（见 safeProjectAssetPath）后按扩展名给
 * Content-Type 原样吐字节。
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { /* 见文件末尾 wss 初始化处的兜底说明 */ }

const HOST = '127.0.0.1';
const PORT = 8181;

// TeX Live 路径（规划 §1.4 实测）。允许用 LATEX_BRIDGE_TEXBIN 环境变量覆盖，方便别的机器上跑。
const TEXBIN = process.env.LATEX_BRIDGE_TEXBIN || 'E:\\texlive\\2025\\bin\\windows';
const LATEXMK = path.join(TEXBIN, process.platform === 'win32' ? 'latexmk.exe' : 'latexmk');
// v2 Pass D：M4 编译选项菜单 + M7 Compiler 设置分类，都要真的驱动这三个二进制之一。
const EXE = process.platform === 'win32' ? '.exe' : '';
const ENGINE_BIN = {
    pdflatex: path.join(TEXBIN, 'pdflatex' + EXE),
    xelatex: path.join(TEXBIN, 'xelatex' + EXE),
    lualatex: path.join(TEXBIN, 'lualatex' + EXE)
};
const TEXCOUNT = path.join(TEXBIN, 'texcount' + EXE);
// v2 Pass E：M10 SyncTeX 正向（源码 → PDF）。真跑 TeX Live 自带的 synctex.exe view 子命令，
// 不自己解析 .synctex.gz 二进制格式（§0 硬约束纪律的同一条：能用真工具就不要重新发明）。
const SYNCTEX = path.join(TEXBIN, 'synctex' + EXE);

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

// M4 页码总数：TeX Live 2020+ 默认压缩对象流（ObjStm），PDF 里已经找不到明文的
// "/Type /Page"/"/Count" 了（实测：本仓库 main.tex 编出的 17 页 PDF，明文匹配数 = 0）。
// 真正可靠的来源是 pdflatex/latexmk 自己在 .log 末尾写的 "Output written on
// output.pdf (17 pages, 449448 bytes)."——这行常被 79 列硬折行切断，所以先去掉换行再匹配。
function extractPageCount(logText) {
    try {
        const flat = logText.replace(/\r?\n/g, '');
        const m = /\(\s*(\d+)\s*pages?,\s*[\d,]+\s*bytes\s*\)/i.exec(flat);
        return m ? parseInt(m[1], 10) : null;
    } catch (e) { return null; }
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
// /project-asset —— v2 Pass P18：Visual 模式 \includegraphics 缩略图资源。
//
// 路径穿越防护镜像 safeOutdirForId 同一条防御纪律（"真的 resolve 出绝对路径以后拿字符串
// 前缀比对，跑出边界一律拒绝"，不是靠 relPath 里"看起来有没有 .."这种字符串猜测）：
//   - path.resolve(base, relPath)：relPath 如果本身是绝对路径（比如 query 里塞
//     "C:\Windows\System32\xxx" 或 "/etc/passwd"），Node 的 path.resolve() 语义是直接
//     无视 base、返回那个绝对路径本身——所以必须在 resolve 之后再比一次前缀，不能只信
//     "看起来是相对路径"。
//   - 前缀比较用 "base + 分隔符" 而不是裸 base，防止 "C:\proj-evil" 这种同前缀但其实是
//     兄弟目录的假阳性（"C:\proj" 是 "C:\proj-evil" 的字符串前缀，但不是同一个目录）。
// ---------------------------------------------------------------------------
function safeProjectAssetPath(projectDir, relPath) {
    if (typeof projectDir !== 'string' || !projectDir) return null;
    if (typeof relPath !== 'string' || !relPath) return null;
    let base;
    try { base = path.resolve(projectDir); } catch (e) { return null; }
    let resolved;
    try { resolved = path.resolve(base, relPath); } catch (e) { return null; }
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && resolved.indexOf(baseWithSep) !== 0) return null; // 跑出项目目录，一律拒绝
    return resolved;
}

const ASSET_CONTENT_TYPES = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml'
};
// 100MB：简单的"荒谬大小"防御（一份论文的示意图/图表不会真的这么大），不是精细限流，
// 单纯不让一个放错位置的巨型文件（比如整份数据集 .csv 被误传成 .pdf 扩展名）拖住响应。
const ASSET_MAX_BYTES = 100 * 1024 * 1024;

// ---------------------------------------------------------------------------
// /compile
// ---------------------------------------------------------------------------

// bibtex 在 Windows/TeX Live 2025 + latexmk -outdir 组合下有个实测坑：latexmk 为了让 bibtex
// 在 outdir 里写 .bbl/.blg，会先 "Change directory to" outdir，再靠它自己算出来的 BIBINPUTS
// 环境变量指回 projectDir 让 bibtex 找到 .bib —— 但它算出来的是 Cygwin/MSYS 风格的路径
// （形如 /e/OneDrive - University of Massachusetts/...），本机装的是原生 Windows bibtex.exe，
// kpathsea 认不出这种 /e/ 盘符写法，于是 "I couldn't open database file"，bibtex 直接报错，
// latexmk 把这当成致命错误，整条 rerun 链（多趟 pdflatex 收敛交叉引用）也跟着放弃 ——
// 一份真实论文实测：全篇 \ref/\label 显示 ??、\cite 显示 [?]，根因是这一步，不是没编译够趟数。
// 绕过办法不去掰 latexmk 内部的 Perl 路径转换（脆弱、版本相关），而是从根上让 bibtex 压根不
// 需要跨目录找文件：编译前把 .tex 里 \bibliography{...}/\addbibresource{...} 点名的 .bib
// 文件本身复制一份到这次编译专用的 outdir 里，bibtex 在自己 cwd 就能找到，BIBINPUTS 那条路
// 径翻译错不错就无所谓了。只在 normal 模式（会跑 bibtex）时做；draft 模式单趟引擎调用，
// 压根不碰 bibtex，不需要这一步。
function copyBibResourcesToOutdir(mainAbs, projectDir, outdir) {
    let text;
    try { text = fs.readFileSync(mainAbs, 'utf8'); } catch (e) { return; }
    const names = [];
    const reClassic = /\\bibliography\{([^}]*)\}/g;
    const reBiblatex = /\\addbibresource(?:\[[^\]]*\])?\{([^}]*)\}/g;
    let m;
    while ((m = reClassic.exec(text))) {
        m[1].split(',').forEach((n) => { n = n.trim(); if (n) names.push(n.endsWith('.bib') ? n : n + '.bib'); });
    }
    while ((m = reBiblatex.exec(text))) {
        const n = m[1].trim();
        if (n) names.push(n.endsWith('.bib') ? n : n + '.bib');
    }
    names.forEach((name) => {
        const src = path.join(projectDir, name);
        if (!fs.existsSync(src)) return; // 找不到就跳过，交给 bibtex 自己按原样报错，不装作成功
        const dest = path.join(outdir, name);
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
        } catch (e) { /* 复制失败不算致命：最坏情况退回旧行为（BIBINPUTS 路径翻译问题依旧） */ }
    });
}

function doCompile(projectDir, mainFile, opts) {
    opts = opts || {};
    // engine: pdflatex（默认）/ xelatex / lualatex —— M7 Compiler 分类真的驱动这个。
    const engine = ENGINE_BIN[opts.engine] ? opts.engine : 'pdflatex';
    // mode: 'normal'（默认，latexmk 多趟 + bibtex）/ 'draft'（M4 的 "Fast [draft]"：跳过 latexmk，
    // 直接调一次引擎单趟——更快，但交叉引用/引文可能还是 "??"，这是刻意的、诚实的行为差异）。
    const mode = opts.mode === 'draft' ? 'draft' : 'normal';
    // haltOnError: M4 "Compile error handling" / M7 "Stop on first error"，两处共用同一个桥参数。
    const haltOnError = !!opts.haltOnError;
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
        const engineBin = ENGINE_BIN[engine];
        const compilerBin = mode === 'draft' ? engineBin : LATEXMK;
        if (!fs.existsSync(compilerBin)) {
            resolve({ ok: false, error: (mode === 'draft' ? engine : 'latexmk') + ' 未找到: ' + compilerBin + '（检查 LATEX_BRIDGE_TEXBIN / TeX Live 是否安装）' });
            return;
        }
        if (mode !== 'draft') copyBibResourcesToOutdir(mainAbs, projectDir, outdir);

        // 同一时间只允许一个编译在跑；新请求来了先杀掉旧的（§3.1 契约）。
        if (currentChild) {
            try { killTree(currentChild.pid); } catch (e) {}
            currentChild = null;
        }

        let args;
        if (mode === 'draft') {
            // 单趟直调引擎二进制（不经 latexmk）：没有多趟收敛、没有 bibtex——这就是 "draft" 名字的来源，
            // 不是伪装成一样快慢的另一份"正常编译"。
            args = [
                '-interaction=nonstopmode',
                '-file-line-error',
                '-synctex=1',
                '-jobname=output',
                '-output-directory=' + outdir
            ];
            if (haltOnError) args.push('-halt-on-error');
            args.push(mainAbs);
        } else {
            args = [
                engine === 'xelatex' ? '-pdfxe' : (engine === 'lualatex' ? '-pdflua' : '-pdf'),
                '-interaction=nonstopmode',
                '-file-line-error',
                '-synctex=1',
                '-jobname=output',
                '-outdir=' + outdir
            ];
            if (haltOnError) args.push('-halt-on-error');
            // 「Recompile from scratch」：桥本来就每次编译都用全新的临时目录（§1 事实基线），
            // 从不复用上一次的 aux/中间文件，所以这个参数目前只是显式声明意图、并加 -gg 让
            // latexmk 内部也不做增量判断——诚实说明：跟普通 Recompile 的可观察结果基本一致，
            // 见交付说明里的对应段落，不是没接线。
            if (opts.forceClean) args.push('-gg');
            args.push(mainAbs);
        }

        let stdoutBuf = [];
        let stderrBuf = [];
        let child;
        try {
            child = spawn(compilerBin, args, { cwd: projectDir, windowsHide: true });
        } catch (e) {
            resolve({ ok: false, error: 'spawn ' + (mode === 'draft' ? engine : 'latexmk') + ' failed: ' + e.message });
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
                engine: engine,
                mode: mode,
                exitCode: (exitCode === null ? null : exitCode),
                timedOut: !!timedOut,
                durationMs: durationMs,
                pdfExists: pdfExists,
                pdfSize: pdfSize,
                pageCount: extractPageCount(logText), // null = 没找到（draft 单趟引擎调用一般也会写这行）
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
// /wordcount —— TeX Live 自带 texcount.exe，真数，不用纯 JS 估算（§4.0 明文要求：
// 纯 JS 数词会和 texcount 对不上，那种数字比没有更糟）。
// ---------------------------------------------------------------------------

function doWordCount(projectDir, mainFile) {
    return new Promise((resolve) => {
        if (!fs.existsSync(TEXCOUNT)) {
            resolve({ ok: false, error: 'texcount 未找到: ' + TEXCOUNT + '（检查 LATEX_BRIDGE_TEXBIN / TeX Live 是否安装）' });
            return;
        }
        const mainAbs = path.isAbsolute(mainFile) ? mainFile : path.join(projectDir, mainFile);
        if (!fs.existsSync(mainAbs)) {
            resolve({ ok: false, error: 'main file not found: ' + mainAbs });
            return;
        }
        let child;
        try {
            // 实测（本机 texcount）：-sum=all 不是这个版本认识的开关（不报错但也不产出
            // "Sum count:" 那一行）——用 -inc 就够了，"合计"改成前端拿 words+headers+captions
            // 自己加，加数还是 texcount 给的真实数字，不是编的。
            child = spawn(TEXCOUNT, ['-inc', mainAbs], { cwd: projectDir, windowsHide: true });
        } catch (e) {
            resolve({ ok: false, error: 'spawn texcount failed: ' + e.message });
            return;
        }
        let resolved = false;
        const outBuf = [];
        const errBuf = [];
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill(); } catch (e) {}
            resolve({ ok: false, error: 'texcount 超时（30s）' });
        }, 30000);
        child.stdout.on('data', (c) => outBuf.push(c));
        child.stderr.on('data', (c) => errBuf.push(c));
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: false, error: 'texcount process error: ' + err.message });
        });
        child.on('close', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            const text = Buffer.concat(outBuf).toString('utf8') || Buffer.concat(errBuf).toString('utf8');
            const grab = (re) => { const m = re.exec(text); return m ? parseInt(m[1], 10) : null; };
            resolve({
                ok: true,
                raw: text,
                words: grab(/Words in text:\s*(\d+)/),
                headers: grab(/Words in headers:\s*(\d+)/),
                captions: grab(/Words (?:in (?:float )?captions|outside text \(captions, etc\.\)):\s*(\d+)/)
            });
        });
    });
}

// ---------------------------------------------------------------------------
// /synctex/forward —— 源码行号 -> PDF 页码+坐标（M10 SyncTeX 正向）。
// 用真的 `synctex view -i line:col:mainAbs -o outdir/output.pdf`，实测（2026-08-24，本机
// TeX Live 2025）"-i" 的 input 参数必须是 pdflatex 编译时看到的**那个原样字符串**——
// 桥编译时传给引擎的是绝对路径（doCompile 里的 mainAbs），所以这里也必须用绝对路径，
// 传相对文件名会得到 "SyncTeX Warning: No tag for xxx.tex" 且没有 Page/x/y 可解析。
// ---------------------------------------------------------------------------

function doSyncTexForward(outdir, mainAbs, line, column) {
    return new Promise((resolve) => {
        if (!fs.existsSync(SYNCTEX)) {
            resolve({ ok: false, error: 'synctex 未找到: ' + SYNCTEX + '（检查 LATEX_BRIDGE_TEXBIN / TeX Live 是否安装）' });
            return;
        }
        const pdfPath = path.join(outdir, 'output.pdf');
        const synctexGz = path.join(outdir, 'output.synctex.gz');
        if (!fs.existsSync(pdfPath) || !fs.existsSync(synctexGz)) {
            resolve({ ok: false, error: '这次编译没有产出 output.synctex.gz（先 Recompile 一次成功的编译）' });
            return;
        }
        const args = ['view', '-i', line + ':' + (column || 0) + ':' + mainAbs, '-o', pdfPath];
        let child;
        try {
            child = spawn(SYNCTEX, args, { windowsHide: true });
        } catch (e) {
            resolve({ ok: false, error: 'spawn synctex failed: ' + e.message });
            return;
        }
        let resolved = false;
        const outBuf = [];
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill(); } catch (e) {}
            resolve({ ok: false, error: 'synctex 超时（10s）' });
        }, 10000);
        child.stdout.on('data', (c) => outBuf.push(c));
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: false, error: 'synctex process error: ' + err.message });
        });
        child.on('close', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            const text = Buffer.concat(outBuf).toString('utf8');
            // 输出形如：
            //   SyncTeX result begin
            //   Output:...\output.pdf
            //   Page:5
            //   x:100.0
            //   y:200.0
            //   ...
            //   SyncTeX result end
            const grab = (re) => { const m = re.exec(text); return m ? parseFloat(m[1]) : null; };
            const page = grab(/^Page:(\d+)/m);
            if (page === null) {
                resolve({ ok: false, error: '没有匹配结果（可能这一行不在正文渲染范围内，比如注释/导言区），synctex 原始输出：' + text.trim() });
                return;
            }
            resolve({
                ok: true,
                page: page,
                x: grab(/^x:([\d.\-]+)/m),
                y: grab(/^y:([\d.\-]+)/m),
                h: grab(/^h:([\d.\-]+)/m),
                v: grab(/^v:([\d.\-]+)/m),
                raw: text
            });
        });
    });
}

// ---------------------------------------------------------------------------
// /synctex/edit —— PDF 页码+坐标 -> 源码行号（M11 SyncTeX 反向，pdf.js 双击画布触发）。
// 用真的 `synctex edit -o page:x:y:pdfPath`，跟 doSyncTexForward 同一套 spawn/超时/解析纪律，
// 镜像它的参数数组写法（不拼 shell 字符串）。坐标约定见 `synctex help edit`：page 1-based，
// x/y 是"从页面左上角量起、单位 big point (72dpi)"——跟 doSyncTexForward 返回的 x/y 是同一个
// 坐标系（2026-08-25 本机用 scratch 文档实测过 view 的输出直接喂给 edit 能精确 round-trip
// 回同一行），前端负责把 pdf.js 的画布点击坐标换算成这个坐标系，这里只管照原样传给 synctex。
// ---------------------------------------------------------------------------

function doSyncTexEdit(outdir, page, x, y) {
    return new Promise((resolve) => {
        if (!fs.existsSync(SYNCTEX)) {
            resolve({ ok: false, error: 'synctex 未找到: ' + SYNCTEX + '（检查 LATEX_BRIDGE_TEXBIN / TeX Live 是否安装）' });
            return;
        }
        const pdfPath = path.join(outdir, 'output.pdf');
        const synctexGz = path.join(outdir, 'output.synctex.gz');
        if (!fs.existsSync(pdfPath) || !fs.existsSync(synctexGz)) {
            resolve({ ok: false, error: '这次编译没有产出 output.synctex.gz（先 Recompile 一次成功的编译）' });
            return;
        }
        const args = ['edit', '-o', page + ':' + x + ':' + y + ':' + pdfPath];
        let child;
        try {
            child = spawn(SYNCTEX, args, { windowsHide: true });
        } catch (e) {
            resolve({ ok: false, error: 'spawn synctex failed: ' + e.message });
            return;
        }
        let resolved = false;
        const outBuf = [];
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { child.kill(); } catch (e) {}
            resolve({ ok: false, error: 'synctex 超时（10s）' });
        }, 10000);
        child.stdout.on('data', (c) => outBuf.push(c));
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: false, error: 'synctex process error: ' + err.message });
        });
        child.on('close', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            const text = Buffer.concat(outBuf).toString('utf8');
            // 输出形如：
            //   SyncTeX result begin
            //   Output:...\output.pdf
            //   Input:.../main.tex
            //   Line:5
            //   Column:-1
            //   Offset:0
            //   Context:
            //   SyncTeX result end
            const fileM = /^Input:(.+)$/m.exec(text);
            const lineM = /^Line:(-?\d+)/m.exec(text);
            const line = lineM ? parseInt(lineM[1], 10) : null;
            if (line === null || line < 1 || !fileM) {
                resolve({ ok: false, error: '没有匹配结果（可能点在页面空白处），synctex 原始输出：' + text.trim() });
                return;
            }
            // synctex 在 Windows 上照样吐 "/e/..." 或带 "./" 的路径分隔风格，统一 normalize 一下
            // 方便前端直接按 basename 比对当前打开的文件。
            const file = path.normalize(fileM[1].trim());
            resolve({ ok: true, file: file, line: line, raw: text });
        });
    });
}

// ---------------------------------------------------------------------------
// /pick-folder —— v2 Pass P17：原生 Windows 文件夹选择框，用户明确表示不想手填/粘贴路径。
// FolderBrowserDialog 是同步 API（ShowDialog() 会阻塞调用它的线程直到用户关掉对话框），但
// 这里从来没有在 Node 主线程里调用它——spawn() 起一个独立的 powershell.exe 子进程去跑，
// Node 事件循环全程不受影响，用户把对话框开着晾一整天，其间其他并发请求（/compile、
// /health、WebSocket……）照样正常处理，唯一等待的是发起 /pick-folder 请求的那一个 HTTP 响应。
// 脚本走 -EncodedCommand（UTF-16LE base64）传给 powershell.exe，是固定脚本、不拼用户输入，
// 用它单纯是为了避开引号转义的坑，不是安全边界；spawn 走参数数组，不是 shell 字符串拼接。
// -----------------------------------------------------------------------------
const PICK_FOLDER_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟：给用户充分时间挑文件夹，又不至于真的永久挂着子进程

function doPickFolder() {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve({ ok: false, error: '/pick-folder 只支持 Windows（FolderBrowserDialog 是 WinForms API）' });
            return;
        }
        // 用一个隐藏但 TopMost 的宿主 Form 当 owner，不然对话框有时会开在其他窗口后面、
        // 用户以为没反应——实测（本机 Windows 10）不挂 owner 偶发这个问题。
        const psScript = [
            'Add-Type -AssemblyName System.Windows.Forms',
            '$owner = New-Object System.Windows.Forms.Form',
            '$owner.TopMost = $true',
            '$owner.ShowInTaskbar = $false',
            '$owner.StartPosition = "CenterScreen"',
            '$owner.Width = 0; $owner.Height = 0',
            '$owner.Show()',
            '$owner.Activate()',
            '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
            '$dialog.Description = "选择 LaTeX 项目文件夹（AI-Translator）"',
            '$dialog.ShowNewFolderButton = $false',
            '$result = $dialog.ShowDialog($owner)',
            '$owner.Close()',
            'if ($result -eq [System.Windows.Forms.DialogResult]::OK) {',
            '  Write-Output ("SELECTED:" + $dialog.SelectedPath)',
            '} else {',
            '  Write-Output "CANCELLED"',
            '}'
        ].join("\r\n");
        const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
        let child;
        try {
            child = spawn('powershell.exe', args, { windowsHide: false });
        } catch (e) {
            resolve({ ok: false, error: 'spawn powershell failed: ' + e.message });
            return;
        }
        let resolved = false;
        const outBuf = [];
        const errBuf = [];
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { killTree(child.pid); } catch (e) {}
            resolve({ ok: false, error: '选择文件夹超时（' + (PICK_FOLDER_TIMEOUT_MS / 1000) + 's 没有响应，对话框可能被系统吞了，重试一次）' });
        }, PICK_FOLDER_TIMEOUT_MS);
        child.stdout.on('data', (c) => outBuf.push(c));
        child.stderr.on('data', (c) => errBuf.push(c));
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: false, error: 'powershell process error: ' + err.message });
        });
        child.on('close', () => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            const text = Buffer.concat(outBuf).toString('utf8').trim();
            if (!text || text.indexOf('CANCELLED') !== -1) {
                resolve({ ok: true, cancelled: true, path: null });
                return;
            }
            const m = /SELECTED:([\s\S]*)$/.exec(text);
            const picked = m ? m[1].trim() : '';
            if (!picked) {
                const errText = Buffer.concat(errBuf).toString('utf8').trim();
                resolve({ ok: false, error: '没有解析出路径，原始输出：' + text + (errText ? ('；stderr: ' + errText) : '') });
                return;
            }
            resolve({ ok: true, cancelled: false, path: picked });
        });
    });
}

// ---------------------------------------------------------------------------
// Overleaf git 集成 —— v2 Pass P24：POST /overleaf/pull、POST /overleaf/push。
//
// 安全设计（务必维持，不要为了"省事"抄近路——这条链路能直接读写用户真实的 Overleaf 论文
// 项目，风险等级跟本文件其余接口不是一个量级）：
//   - Overleaf 项目级 Git Token 绝不允许以任何形式落盘到本地文件系统的持久化位置：
//       · 不能拼进会被 `git remote add`/`git clone <url>` 持久化保存的 remote URL 里——
//         那样会把完整 URL（含 token）明文写进目标目录的 .git/config。origin remote 只
//         指向不带 token 的干净 URL（形如 https://git.overleaf.com/<projectId>）。
//       · 不能直接拼进 spawn() 的 argv 数组（例如 `git fetch https://TOKEN@...`）——
//         Windows 上任何进程都能用 `Get-CimInstance Win32_Process` 之类的方式看到别的
//         进程完整的命令行参数，这是真实风险，不是假设。
//   - 正确做法：GIT_ASKPASS + 环境变量。git-askpass-helper.bat/.js 让 token 只活在子进程的
//     环境变量 OVL_GIT_TOKEN 里（环境变量不会出现在 Win32_Process.CommandLine 里），git
//     需要密码时会调这个 helper、从环境变量读，token 本身从不出现在磁盘或进程参数里。
//   - 任何要返回给前端的文本（尤其是失败时的 stderr/stdout 原文）在塞进 sendJson 之前，
//     一律先用 redactToken() 把 token 字面量替换掉——防止它意外出现在 git 的错误输出里
//     又被原样透传回前端/浏览器控制台/将来的测试记录。
//   - 所有网络操作（clone/fetch/push）都有超时（30s），超时就 kill 掉子进程、返回明确的
//     "…超时…" 错误，不让请求无限挂着。
//   - 遇到"本地有未提交改动"（dirty）、"本地和远程分叉"（无法快进合并）、"推送被非快进拒绝"
//     这几种情况，一律停手、原样报告，绝不自动合并/rebase/force push、绝不猜测覆盖——
//     这是本轮任务里反复强调的纪律：宁可什么都不做，也不能静默丢用户的 Overleaf 内容。
// ---------------------------------------------------------------------------

function redactToken(text, token) {
    if (typeof text !== 'string' || !text) return text;
    if (typeof token !== 'string' || !token) return text;
    return text.split(token).join('***');
}

const OVERLEAF_GIT_TIMEOUT_MS = 30000;
const GIT_ASKPASS_HELPER = path.join(__dirname, 'git-askpass-helper.bat');

// 跑一条 git 命令，token 只走环境变量（GIT_ASKPASS），绝不拼进 args/URL——见文件头注释。
// 不抛异常：spawn 失败、超时、非零退出码统统汇总成 {ok, code, stdout, stderr, timedOut} 返回。
function runGitCommand(args, cwd, token) {
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn('git', args, {
                cwd: cwd,
                windowsHide: true,
                env: Object.assign({}, process.env, {
                    GIT_ASKPASS: GIT_ASKPASS_HELPER,
                    OVL_GIT_TOKEN: token || '',
                    GIT_TERMINAL_PROMPT: '0' // askpass 出问题时不许卡在交互式输入等待上
                })
            });
        } catch (e) {
            resolve({ ok: false, code: null, stdout: '', stderr: 'spawn git failed: ' + e.message, timedOut: false });
            return;
        }
        let resolved = false;
        const outBuf = [];
        const errBuf = [];
        const timer = setTimeout(() => {
            if (resolved) return;
            resolved = true;
            try { killTree(child.pid); } catch (e) {}
            resolve({
                ok: false, code: null,
                stdout: Buffer.concat(outBuf).toString('utf8'),
                stderr: Buffer.concat(errBuf).toString('utf8'),
                timedOut: true
            });
        }, OVERLEAF_GIT_TIMEOUT_MS);
        child.stdout.on('data', (c) => outBuf.push(c));
        child.stderr.on('data', (c) => errBuf.push(c));
        child.on('error', (err) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({ ok: false, code: null, stdout: '', stderr: 'git process error: ' + err.message, timedOut: false });
        });
        child.on('close', (code) => {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            resolve({
                ok: code === 0, code: code,
                stdout: Buffer.concat(outBuf).toString('utf8'),
                stderr: Buffer.concat(errBuf).toString('utf8'),
                timedOut: false
            });
        });
    });
}

// origin remote 一致性比较专用的归一化：去首尾空白、去结尾斜杠、去结尾 .git、统一转小写
// （Windows 上 file:// 路径大小写不敏感，且 git clone 落进 .git/config 的写法可能跟传入的
// 原始字符串不完全一致，直接 !== 比较会把同一个地址误判成"不一致"）。
function normalizeGitUrlForCompare(url) {
    if (typeof url !== 'string') return '';
    let s = url.trim();
    s = s.replace(/\/+$/, '');
    s = s.replace(/\.git$/i, '');
    return s.toLowerCase();
}

// 确保 cwd 里有一个叫 origin 的 remote、且指向（不带 token 的）gitUrl——pull/push 共用。
// origin 不存在 → 照常 add。origin 已存在且指向别处 → 拒绝并如实报告，绝不静默 set-url
// 替用户改指向（同一份 origin 被悄悄改指到别处、再 push，等于把用户的真实内容原样双手
// 奉上——这跟"宁可拒绝也不猜测覆盖"是同一条纪律，见文件头安全设计注释）。
async function ensureOriginRemote(projectDir, gitUrl, token) {
    const listResult = await runGitCommand(['remote'], projectDir, token);
    if (!listResult.ok) {
        return { ok: false, error: listResult.stderr || listResult.stdout || 'git remote 查询失败' };
    }
    const remotes = listResult.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
    if (remotes.indexOf('origin') === -1) {
        const addResult = await runGitCommand(['remote', 'add', 'origin', gitUrl], projectDir, token);
        if (!addResult.ok) return { ok: false, error: addResult.stderr || addResult.stdout || 'git remote add 失败' };
        return { ok: true };
    }
    const urlResult = await runGitCommand(['remote', 'get-url', 'origin'], projectDir, token);
    const curUrl = urlResult.ok ? urlResult.stdout.trim() : null;
    if (curUrl !== null && normalizeGitUrlForCompare(curUrl) !== normalizeGitUrlForCompare(gitUrl)) {
        return {
            ok: false,
            action: 'origin-mismatch',
            error: '该目录已有一个 origin remote，但指向的地址和本次请求要求的不一致，为避免误将内容推送/拉取到错误的仓库，不会自动修改。' +
                '当前 origin 指向：' + redactToken(curUrl, token) +
                '；本次请求要求指向：' + redactToken(gitUrl, token) +
                '。如果确实要改，请自己在项目目录里手动执行 git remote set-url origin <新地址>。'
        };
    }
    return { ok: true };
}

// POST /overleaf/pull —— 见文件头安全设计注释 + 交付说明里的分支逻辑表。
async function doOverleafPull(projectDir, gitUrl, token) {
    try {
        const gitDir = path.join(projectDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }

        if (!hasGitDir) {
            let dirExists = false;
            try { dirExists = fs.existsSync(projectDir); } catch (e) {}
            if (!dirExists) {
                try { fs.mkdirSync(projectDir, { recursive: true }); } catch (e) {
                    return { ok: false, action: 'mkdir-failed', error: '创建项目目录失败: ' + e.message };
                }
            } else {
                let entries = [];
                try { entries = fs.readdirSync(projectDir); } catch (e) {
                    return { ok: false, action: 'readdir-failed', error: '读取项目目录失败: ' + e.message };
                }
                if (entries.length > 0) {
                    // 目录已存在文件但不是 git 仓库——绝不清空/覆盖，直接拒绝，交给用户手动处理。
                    return {
                        ok: false,
                        action: 'refused-nonempty-dir',
                        error: '该目录已存在文件但不是 git 仓库，为避免覆盖现有内容，不会自动 clone。请指向一个空目录，或手动在该目录跑 git init/git remote add/git pull 之后再用本功能。'
                    };
                }
            }
            const cloneResult = await runGitCommand(['clone', gitUrl, '.'], projectDir, token);
            if (!cloneResult.ok) {
                return { ok: false, action: 'clone-failed', error: redactToken(cloneResult.stderr || cloneResult.stdout || 'git clone 失败', token) };
            }
            return { ok: true, action: 'cloned' };
        }

        // 已经是 git 仓库：dirty 检查必须先于任何网络操作。
        const statusResult = await runGitCommand(['status', '--porcelain'], projectDir, token);
        if (!statusResult.ok) {
            return { ok: false, action: 'status-failed', error: redactToken(statusResult.stderr || statusResult.stdout || 'git status 失败', token) };
        }
        if (statusResult.stdout.trim().length > 0) {
            return {
                ok: true,
                action: 'skipped-dirty',
                error: '本地有未提交的改动，跳过本次同步（不会自动覆盖），建议先点“推送”或手动处理后再拉取。'
            };
        }

        const remoteResult = await ensureOriginRemote(projectDir, gitUrl, token);
        if (!remoteResult.ok) {
            return { ok: false, action: remoteResult.action || 'remote-failed', error: redactToken(remoteResult.error, token) };
        }

        const fetchResult = await runGitCommand(['fetch', 'origin'], projectDir, token);
        if (!fetchResult.ok) {
            return { ok: false, action: 'fetch-failed', error: redactToken(fetchResult.stderr || fetchResult.stdout || 'git fetch 失败', token) };
        }

        const branchResult = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir, token);
        if (!branchResult.ok) {
            return { ok: false, action: 'branch-failed', error: redactToken(branchResult.stderr || 'git rev-parse 获取当前分支名失败', token) };
        }
        const branch = branchResult.stdout.trim();

        const oldHeadResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, token);
        const oldHead = oldHeadResult.ok ? oldHeadResult.stdout.trim() : null;

        const mergeResult = await runGitCommand(['merge', '--ff-only', 'origin/' + branch], projectDir, token);
        if (!mergeResult.ok) {
            // 非快进（本地和远程各自有新提交）或 origin/<branch> 压根不存在（比如远程默认分支
            // 是 master，本地却在别的分支上）——两种情况都不尝试自动合并/rebase/瞎猜分支名重试，
            // 统一归类为"分叉"，原样报告给用户自己判断。
            return {
                ok: true,
                action: 'diverged',
                error: '本地和 Overleaf 上的版本出现分叉，无法自动合并，请手动处理（打开终端 cd 到项目目录执行 git status / git log 检查，必要时手动 git merge 或 git reset）。如果 Overleaf 上的默认分支名和本地当前分支（' + branch + '）不一致，也会出现这个提示，请手动确认分支名。'
            };
        }

        const newHeadResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, token);
        const newHead = newHeadResult.ok ? newHeadResult.stdout.trim() : null;

        if (oldHead && newHead && oldHead === newHead) {
            return { ok: true, action: 'up-to-date' };
        }

        let changedFiles = [];
        if (oldHead && newHead) {
            const diffResult = await runGitCommand(['diff', '--name-only', oldHead, newHead], projectDir, token);
            if (diffResult.ok) {
                changedFiles = diffResult.stdout.split(/\r?\n/).filter((s) => s.length > 0);
            }
        }
        return { ok: true, action: 'fast-forward', changedFiles: changedFiles };
    } catch (e) {
        return { ok: false, error: redactToken('内部错误: ' + (e && e.message), token) };
    }
}

// POST /overleaf/push —— 见文件头安全设计注释。绝不 force push：非快进被拒绝时提交本身
// 已经落在本地历史里（不回滚），只是没推上去，安全、不丢用户的本地工作。
async function doOverleafPush(projectDir, gitUrl, token, message) {
    try {
        const gitDir = path.join(projectDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }
        if (!hasGitDir) {
            return { ok: false, error: '这个目录还不是 git 仓库，请先拉取一次' };
        }

        const addResult = await runGitCommand(['add', '-A'], projectDir, token);
        if (!addResult.ok) {
            return { ok: false, error: redactToken(addResult.stderr || addResult.stdout || 'git add 失败', token) };
        }

        const stagedResult = await runGitCommand(['diff', '--cached', '--name-only'], projectDir, token);
        if (!stagedResult.ok) {
            return { ok: false, error: redactToken(stagedResult.stderr || stagedResult.stdout || 'git diff --cached 失败', token) };
        }
        if (stagedResult.stdout.trim().length === 0) {
            return { ok: true, action: 'nothing-to-push' }; // 没有改动，不做空提交
        }

        const commitMessage = (message && String(message).trim()) || ('AI-Translator sync ' + new Date().toISOString());
        const commitResult = await runGitCommand(['commit', '-m', commitMessage], projectDir, token);
        if (!commitResult.ok) {
            return { ok: false, error: redactToken(commitResult.stderr || commitResult.stdout || 'git commit 失败', token) };
        }

        const remoteResult = await ensureOriginRemote(projectDir, gitUrl, token);
        if (!remoteResult.ok) {
            return { ok: false, action: remoteResult.action || 'remote-failed', error: redactToken(remoteResult.error, token) };
        }

        const branchResult = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir, token);
        if (!branchResult.ok) {
            return { ok: false, error: redactToken(branchResult.stderr || 'git rev-parse 获取当前分支名失败', token) };
        }
        const branch = branchResult.stdout.trim();

        const pushResult = await runGitCommand(['push', 'origin', branch], projectDir, token);
        if (!pushResult.ok) {
            const combined = (pushResult.stderr || '') + '\n' + (pushResult.stdout || '');
            if (/non-fast-forward|fetch first|rejected/i.test(combined)) {
                return {
                    ok: true,
                    action: 'rejected-non-fastforward',
                    error: '推送被拒绝：Overleaf 上有你本地还没有的新修改，请先点“拉取”同步之后再推送。'
                };
            }
            return { ok: false, error: redactToken(combined, token) };
        }

        return { ok: true, action: 'pushed' };
    } catch (e) {
        return { ok: false, error: redactToken('内部错误: ' + (e && e.message), token) };
    }
}

// 只用于 /overleaf/* 这两个能动用户真实 git 仓库的路由：拒绝来自任意网页的跨域驱动。
// 浏览器发起跨域 fetch 时一定会带 Origin 头且不可伪造，所以白名单足以挡住恶意页面；
// 没有 Origin 头的（curl / node 脚本 / 本地测试）放行，因为那本来就不是这条攻击链。
function ovlOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;              // 非浏览器发起
    if (origin === 'null') return true;    // file:// 页面（本 App 的正常打开方式）
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
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
            sendText(res, 200, 'AI-Translator latex-bridge is running. POST /compile, POST /stop, POST /wordcount, POST /synctex/forward, POST /synctex/edit, POST /pick-folder, GET /health, GET /output/:id/:file, GET /project-asset?projectDir=&path=, POST /clear, POST /overleaf/pull, POST /overleaf/push. WebSocket on same host:port for disk-change push.');
            return;
        }

        // v2 Pass P17：原生文件夹选择框（POST，不带 body）——见 doPickFolder 头部注释。
        if (req.method === 'POST' && pathname === '/pick-folder') {
            const result = await doPickFolder();
            sendJson(res, 200, result);
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
            const result = await doCompile(projectDir, mainFile, {
                engine: body.engine,
                mode: body.mode,
                haltOnError: body.haltOnError,
                forceClean: body.forceClean
            });
            sendJson(res, 200, result);
            return;
        }

        // M4「Stop compilation」：杀掉当前正在跑的编译进程树（如果有）。
        if (req.method === 'POST' && pathname === '/stop') {
            if (currentChild) {
                try { killTree(currentChild.pid); } catch (e) {}
                currentChild = null;
                currentChildId = null;
                sendJson(res, 200, { ok: true, stopped: true });
            } else {
                sendJson(res, 200, { ok: true, stopped: false });
            }
            return;
        }

        // 项目菜单「Word count」：真的走 TeX Live 自带 texcount，不用纯 JS 数词（§4.0 明文要求）。
        if (req.method === 'POST' && pathname === '/wordcount') {
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
            const result = await doWordCount(projectDir, mainFile);
            sendJson(res, 200, result);
            return;
        }

        // M10 SyncTeX 正向：{id, mainFile, projectDir, line, column?} -> {page,x,y,h,v}
        if (req.method === 'POST' && pathname === '/synctex/forward') {
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const outdir = safeOutdirForId(body.id);
            if (!outdir) { sendJson(res, 400, { ok: false, error: 'invalid id（先成功编译一次）' }); return; }
            const projectDir = body.projectDir;
            const mainFile = body.mainFile || 'main.tex';
            const line = parseInt(body.line, 10);
            if (!projectDir || typeof projectDir !== 'string') {
                sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' });
                return;
            }
            if (!line || line < 1) { sendJson(res, 400, { ok: false, error: 'line 必须是正整数' }); return; }
            const mainAbs = path.isAbsolute(mainFile) ? mainFile : path.join(projectDir, mainFile);
            const result = await doSyncTexForward(outdir, mainAbs, line, body.column || 0);
            sendJson(res, 200, result);
            return;
        }

        // M11 SyncTeX 反向：{id, page, x, y} -> {file, line}
        if (req.method === 'POST' && pathname === '/synctex/edit') {
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const outdir = safeOutdirForId(body.id);
            if (!outdir) { sendJson(res, 400, { ok: false, error: 'invalid id（先成功编译一次）' }); return; }
            const page = parseInt(body.page, 10);
            const x = Number(body.x);
            const y = Number(body.y);
            if (!page || page < 1) { sendJson(res, 400, { ok: false, error: 'page 必须是正整数' }); return; }
            if (!isFinite(x) || !isFinite(y)) { sendJson(res, 400, { ok: false, error: 'x/y 必须是有限数字' }); return; }
            const result = await doSyncTexEdit(outdir, page, x, y);
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

        // v2 Pass P18：Visual 模式 \includegraphics 真缩略图资源。GET（不是 POST）——纯读取，
        // 前端 <img src=...> / pdfjsLib.getDocument(url) 都需要能直接当 URL 用，不能带 body。
        if (req.method === 'GET' && pathname === '/project-asset') {
            const projectDir = u.searchParams.get('projectDir');
            const relPath = u.searchParams.get('path');
            if (!projectDir || !relPath) {
                sendJson(res, 400, { ok: false, error: 'projectDir 和 path 都是必填 query 参数' });
                return;
            }
            if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
                sendJson(res, 404, { ok: false, error: 'projectDir 不存在或不是目录: ' + projectDir });
                return;
            }
            const resolved = safeProjectAssetPath(projectDir, relPath);
            if (!resolved) {
                sendJson(res, 404, { ok: false, error: 'invalid path（跑出项目目录范围）' });
                return;
            }
            let st;
            try { st = fs.statSync(resolved); } catch (e) {
                sendJson(res, 404, { ok: false, error: 'file not found: ' + relPath });
                return;
            }
            if (!st.isFile()) {
                sendJson(res, 404, { ok: false, error: 'file not found: ' + relPath });
                return;
            }
            if (st.size > ASSET_MAX_BYTES) {
                sendJson(res, 400, { ok: false, error: '文件过大（' + Math.round(st.size / 1024 / 1024) + 'MB > ' + (ASSET_MAX_BYTES / 1024 / 1024) + 'MB），拒绝提供' });
                return;
            }
            const contentType = ASSET_CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
            let data;
            try { data = fs.readFileSync(resolved); } catch (e) {
                sendJson(res, 404, { ok: false, error: 'read failed: ' + e.message });
                return;
            }
            res.writeHead(200, {
                'Content-Type': contentType,
                'Content-Length': data.length,
                'Cache-Control': 'no-store'
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

        // v2 Pass P24：Overleaf git 集成——见 doOverleafPull 头部注释的安全设计 + 分支逻辑。
        if (req.method === 'POST' && pathname === '/overleaf/pull') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, action: 'forbidden-origin',
                    error: '拒绝来自外部网页的同步请求。这两个接口只接受 AI-Translator 页面本身的调用。' });
                return;
            }
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            const gitUrl = body.gitUrl;
            const token = body.token;
            if (!projectDir || typeof projectDir !== 'string') { sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' }); return; }
            if (!gitUrl || typeof gitUrl !== 'string') { sendJson(res, 400, { ok: false, error: 'gitUrl is required' }); return; }
            if (!token || typeof token !== 'string') { sendJson(res, 400, { ok: false, error: 'token is required' }); return; }
            const result = await doOverleafPull(projectDir, gitUrl, token);
            sendJson(res, 200, result);
            return;
        }

        // v2 Pass P24：Overleaf git 集成——见 doOverleafPush 头部注释，绝不 force push。
        if (req.method === 'POST' && pathname === '/overleaf/push') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, action: 'forbidden-origin',
                    error: '拒绝来自外部网页的同步请求。这两个接口只接受 AI-Translator 页面本身的调用。' });
                return;
            }
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            const gitUrl = body.gitUrl;
            const token = body.token;
            if (!projectDir || typeof projectDir !== 'string') { sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' }); return; }
            if (!gitUrl || typeof gitUrl !== 'string') { sendJson(res, 400, { ok: false, error: 'gitUrl is required' }); return; }
            if (!token || typeof token !== 'string') { sendJson(res, 400, { ok: false, error: 'token is required' }); return; }
            const result = await doOverleafPush(projectDir, gitUrl, token, body.message);
            sendJson(res, 200, result);
            return;
        }

        sendJson(res, 404, { ok: false, error: 'no such route: ' + req.method + ' ' + pathname });
    } catch (err) {
        sendJson(res, 500, { ok: false, error: 'internal error: ' + (err && err.message) });
    }
});

// ---------------------------------------------------------------------------
// WebSocket —— v2 Pass P17：磁盘外部改动推送。跟 HTTP 共用同一个 http.Server 实例/端口
// （ws 库靠监听 'upgrade' 事件挂在同一个 server 上，不另开端口），前端把 http:// 换成 ws://
// 连同一个 host:port 即可。协议：
//   客户端 -> 服务端：{type:'watch', path:'<绝对路径>'}（切换/首次订阅一个文件，自动替换掉
//                      这条连接之前订阅的文件——不允许同一条连接叠加多个 watcher）
//                     {type:'unwatch'}（明确取消订阅，比如关闭文件/切到只读降级模式）
//   服务端 -> 客户端：{type:'changed', path, mtimeMs}（不带文件内容，前端自己用已有的
//                      FSA 句柄重读；自身写入触发的回声由前端拿 mtimeMs 去过滤，桥这边
//                      不掺和"这是不是我们自己刚写的"这个判断——桥根本不知道谁写的）
// 每条连接最多一个 fs.watch()：collectionOf(ws) 才是 leak 高发点，这里干脆把 watcher 直接
// 挂在 ws 对象自己身上（ws._watcher/ws._watchPath），连接关闭/切换文件/出错都统一走
// detachWatcher() 一条路径清掉，不另建一个全局 Map 去对账。
// ---------------------------------------------------------------------------

function detachWatcher(ws) {
    if (ws._watchDebounce) { clearTimeout(ws._watchDebounce); ws._watchDebounce = null; }
    if (ws._watcher) {
        try { ws._watcher.close(); } catch (e) {}
        ws._watcher = null;
    }
    ws._watchPath = null;
}

function attachWatcher(ws, filePath) {
    detachWatcher(ws);
    if (typeof filePath !== 'string' || !filePath || !path.isAbsolute(filePath)) return; // 只认绝对路径，静默忽略，不报错断连接
    if (!fs.existsSync(filePath)) return; // 文件还没建好/项目路径填错——静默不订阅，等前端下次换文件/路径再试
    try {
        const watcher = fs.watch(filePath, { persistent: false }, function () {
            // Windows 上一次保存常常连续触发好几个 fs.watch 事件（写内容 + 改 mtime 分开算），
            // 轻量 debounce 一下再读一次最新 mtimeMs 合并成一条推送，不然前端会收到好几条
            // 内容其实一样的 'changed'。
            if (ws._watchDebounce) clearTimeout(ws._watchDebounce);
            ws._watchDebounce = setTimeout(function () {
                ws._watchDebounce = null;
                let stat;
                try { stat = fs.statSync(filePath); } catch (e) { return; } // 原子替换类写入期间文件短暂不存在，跳过等下一次事件
                if (ws.readyState !== WebSocket.OPEN) return;
                try { ws.send(JSON.stringify({ type: 'changed', path: filePath, mtimeMs: stat.mtimeMs })); } catch (e) {}
            }, 80);
        });
        watcher.on('error', function (e) {
            console.warn('[latex-bridge] fs.watch error for ' + filePath + ': ' + (e && e.message));
            detachWatcher(ws);
        });
        ws._watcher = watcher;
        ws._watchPath = filePath;
    } catch (e) {
        console.warn('[latex-bridge] fs.watch failed for ' + filePath + ': ' + (e && e.message));
    }
}

if (WebSocket && WebSocket.Server) {
    const wss = new WebSocket.Server({ server: server });
    wss.on('connection', function (ws) {
        ws.on('message', function (raw) {
            let msg;
            try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { return; } // 畸形消息直接丢弃，不断连接
            if (!msg || typeof msg !== 'object') return;
            if (msg.type === 'watch') {
                attachWatcher(ws, msg.path);
            } else if (msg.type === 'unwatch') {
                detachWatcher(ws);
            }
        });
        ws.on('close', function () { detachWatcher(ws); });
        ws.on('error', function () { detachWatcher(ws); });
    });
} else {
    console.warn('[latex-bridge] "ws" 模块没装上（npm install 到 tools/latex-bridge 下），磁盘外部改动推送这一块会不可用，其余 HTTP 功能不受影响');
}

server.listen(PORT, HOST, () => {
    console.log('[latex-bridge] listening on http://' + HOST + ':' + PORT);
    console.log('[latex-bridge] latexmk: ' + LATEXMK + (fs.existsSync(LATEXMK) ? ' (found)' : ' (MISSING!)'));
    console.log('[latex-bridge] work root: ' + WORK_ROOT);
});

process.on('SIGINT', () => { try { killTree(currentChild && currentChild.pid); } catch (e) {} process.exit(0); });
