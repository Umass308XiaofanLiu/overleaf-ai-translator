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
            sendText(res, 200, 'AI-Translator latex-bridge is running. POST /compile, POST /stop, POST /wordcount, POST /synctex/forward, GET /health, GET /output/:id/:file, POST /clear');
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
