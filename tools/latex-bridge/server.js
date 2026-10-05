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
const { spawn, execSync, spawnSync } = require('child_process');
let WebSocket = null;
try { WebSocket = require('ws'); } catch (e) { /* 见文件末尾 wss 初始化处的兜底说明 */ }

// v2 Pass P45：/health 里带的能力/版本自报——见该端点注释。每次给桥新增一个"前端需要能
// 判断有没有"的能力（新端点、既有端点的行为变化），就在 BRIDGE_CAPABILITIES 里加一个字符串，
// 版本号也提一位。已经上线的能力不会被撤销，这个数组只做加法。
const BRIDGE_API_VERSION = 60;
const BRIDGE_CAPABILITIES = [
    'overleaf-clone',          // POST /overleaf/clone
    'overleaf-pull-strategy',  // POST /overleaf/pull 认识 body.strategy（abort/stash/discard）
    'fs-ops',                  // POST /fs/list /fs/read /fs/write /fs/mkdir /fs/move /fs/copy /fs/delete /fs/restore
    'fs-capabilities',         // POST /fs/capabilities（只读能力探测）
    'overleaf-discard-checkpoint', // strategy=discard 丢弃前自动打旁路快照，响应带 checkpoint 字段
    'remote-token-auth',       // v2 Pass P49：可绑非回环地址 + 令牌鉴权，见 tokenAuthorized()
    'fs-write-conflict-check', // v2 Pass P50：POST /fs/write 认识 body.expectedMtimeMs，冲突时返回 conflict:true
    'ws-ticket-auth',          // v2 Pass P50：POST /ws-ticket 换一次性短时票据，REMOTE_MODE 下 WebSocket 握手强制校验
    'overleaf-clone-target',   // v2 Pass P53：POST /overleaf/clone 认识 body.parentDir/body.folderName；
                                // 新增 POST /overleaf/check-target 校验存放位置
    'overleaf-origin-read',    // v2 Pass P66：只读 POST /overleaf/origin，回读某目录 .git/config 里的
                                // origin，供前端反查"这个目录到底是哪个 Overleaf 项目"，不写任何东西
    'overleaf-project-rename', // v2 Pass P67：POST /overleaf/rename-project，真的重命名磁盘上的项目
                                // 文件夹（只能改成同级兄弟目录），供顶栏项目名双击改名用
    'fs-restore-respects-gitignore', // v2 Pass P74 §7.2：POST /fs/restore 不再把被 .gitignore
                                // 忽略的文件算进删除名单，响应新增 skippedIgnored/ignoreWarning 字段
    'fs-write-binary',         // v2 Pass P75 §7.1：POST /fs/write-binary，base64 → 原样字节落盘，
                                // 供 PDF→LaTeX 转换写页面栅格图/内嵌图片用（doFsWrite 只能写 utf8 字符串）
    'synctex-cache-rehydrate', // v2 Pass P107：POST /synctex/rehydrate，把项目内已缓存的
                                // PDF/output.synctex.gz（通常在 .ovl-cache/ 下）复制进一个新的
                                // WORK_ROOT/<id> outdir，换回一个可用的 id——供"刷新后从磁盘
                                // 缓存恢复显示的 PDF"接上现成的 /synctex/forward、/synctex/edit
                                // （它们只认 id -> outdir 这一种定位方式），不需要真的重新编译
    'admin-restart',           // v2 Pass P119：POST /admin/restart——桥自己主动以非零退出码
                                // (process.exit(1)) 退出，把"拉起新进程"这件事交给外部计划
                                // 任务的自愈配置（本机 LatexBridge-AutoStart / jump 侧对应任务
                                // 的 RestartCount 设置），供无人值守场景在改完 server.js 后不
                                // 需要人手动重启桥。跟其余端点一样过统一令牌闸门，不进
                                // TOKEN_EXEMPT_PATHS——远程模式必须带令牌，本地模式沿用
                                // tokenAuthorized() 现行语义（无需令牌），没有特殊豁免。
    'fs-root-allowlist'        // v2 Pass P154：可选的 projectDir 根目录白名单
                                // （LATEX_BRIDGE_ALLOWED_ROOTS 环境变量，';' 分隔多条根路径）。
                                // 未设置时行为与之前逐字节一致，不做任何限制；设置后所有接受
                                // projectDir 的端点都会校验落在某个白名单根之下，越界返回 403。
                                // /health 的 fsRootAllowlist.enabled 播报是否启用（不回显具体
                                // 根路径——/health 在 TOKEN_EXEMPT_PATHS 里免令牌，不该顺带
                                // 泄露服务器磁盘上的敏感目录结构）。
    ,'config-sync'             // v2 Pass P222：GET /sync/snapshot、GET /sync/changes、POST /sync/put，
                                // 把术语库/论文卡/最近项目/设置等 localStorage 配置存到桥自己的
                                // data/config-sync.json，多台电脑打开同一个桥时共享；WS 广播 sync-changed。
];

// v2 Pass P49：监听地址可配（LATEX_BRIDGE_HOST），默认仍是 127.0.0.1——不传就跟以前
// 完全一样，不改变任何现有用户的行为。绝不要默认绑 0.0.0.0；要跨机访问请绑到具体的
// Tailscale IP（如 100.98.164.17），绑 0.0.0.0 会把桥暴露给同一网络下的任何设备，
// 启动时会打印醒目警告（见 server.listen 回调）。
const HOST = process.env.LATEX_BRIDGE_HOST || '127.0.0.1';
// LATEX_BRIDGE_PORT 仅供测试用（起在别的空闲端口上，绝不占用用户真实在跑的 8181）：
// 不传时行为跟以前完全一样，还是硬编码 8181。
const PORT = process.env.LATEX_BRIDGE_PORT ? parseInt(process.env.LATEX_BRIDGE_PORT, 10) : 8181;

// 绑在 127.0.0.1/localhost/::1 之外的地址时才算"远程模式"——只有这时才强制校验访问令牌，
// 纯本地跑（默认）保持零配置，行为跟没有这套令牌机制之前逐字节一致。
const REMOTE_MODE = !/^(127\.0\.0\.1|localhost|::1)$/i.test(HOST);
// v2 Pass P110c：桥自己实际监听的这个地址，供 ovlOriginAllowed() 认出"页面就是从这个桥自己
// 加载的"（P110 起支持的用法：同网设备浏览器直接打开 http://<桥地址>/ 使用整个应用）。
const SELF_ORIGIN = 'http://' + HOST + ':' + PORT;

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
// v2 Pass P91 §5：核验编译原来固定复用这个 120s 默认值，真实论文（bibtex + 多图，latexmk
// 要跑好几趟）常被误杀。前端 ovlP2TVerifyCompile 现在按页数算一个伸缩超时，通过请求体
// timeoutMs 字段传进来（doCompile opts.timeoutMs）；这里只做服务端侧的合理性夹逼，防止
// 任何调用方（不管前端算错还是外部直接调 /compile）传入荒谬的值把编译进程卡死或秒杀。
// 不传时保持原来的 COMPILE_TIMEOUT_MS 行为，其它调用方（ovlDoRecompile 等）零回归。
const COMPILE_TIMEOUT_MIN_MS = 10000;
const COMPILE_TIMEOUT_MAX_MS = 600000;

// ---------------------------------------------------------------------------
// v2 Pass P49：远程访问令牌。
// 优先读环境变量 LATEX_BRIDGE_TOKEN；否则读本地令牌文件（同目录 .bridge-token，已加入
// .gitignore，绝不会被提交）；文件不存在就自动生成一个高强度随机令牌写进去。
// v2 Pass P110f：REMOTE_MODE 下的启动横幅**只播报令牌的来源**（.bridge-token 的绝对路径，
// 或"来自环境变量 LATEX_BRIDGE_TOKEN"），令牌值本身绝不写进 stdout/stderr/任何日志——
// start-bridge.ps1 会把 node 的输出 `*>>` 追加重定向到 logs/bridge-stdout-<日期>.log，
// 打印令牌等于把它明文落盘到一个没有 0600 保护的文件里。回归断言见
// tools/e2e/test_p110_remote_serving.js 组 J。
// 令牌只在 REMOTE_MODE 下才会被强制校验（见下面 tokenAuthorized），本地默认用法完全
// 不受影响——不读令牌文件、不生成、不校验都不会改变现有行为的这句话不成立：其实文件
// 总会被生成/读取（哪怕本地模式），但只有 REMOTE_MODE 才会真正拿它去挡请求。
// ---------------------------------------------------------------------------
const TOKEN_HEADER = 'x-latex-bridge-token';
const TOKEN_FILE = path.join(__dirname, '.bridge-token');

// v2 Pass P110：桥顺带把 AI-Translator.html 自己 serve 出去——同一台机器/同一个 Tailscale
// 地址上，浏览器直接打开 http(s)://<桥地址>/ 就能拿到整个 App，不用再手动往目标机器拷一份
// 文件。路径写死相对 server.js（__dirname/../../AI-Translator.html，即仓库根），不接受任何
// 请求参数拼路径——这是唯一的两条静态路由（GET / 和 GET /AI-Translator.html），不是通用静态
// 目录服务，杜绝路径穿越这一整类问题（见下面 serveAppHtml 的固定路径读取）。
const APP_HTML_PATH = path.join(__dirname, '..', '..', 'AI-Translator.html');

// v2 Pass P110b（N-1 非阻塞项，实测：并发 40 次无令牌 GET / 累计下发 108MB，每请求同步
// fs.readFileSync 2.8MB 会阻塞事件循环、跟同时在跑的编译请求抢同一个线程）：启动时异步读一次、
// 缓存成 Buffer + 算好 ETag，后续每个请求直接吐缓存，不再逐请求碰磁盘。缓存在 server.listen()
// 之前发起（见文件末尾），但不阻塞监听——万一还没读完就有请求先进来，serveAppHtml 会退回原来的
// 同步 readFileSync 兜底，正确性不受影响，只是那一次请求没吃到缓存的加速。
//
// v2 Pass P133（B1）：缓存按 mtime+size 失效。P110b 的缓存只在启动时读一次、之后永不重读磁盘，
// 实测后果（.claude/tmp/p133_recon_jump.md §2）：jump 上 scp 覆盖了新版 AI-Translator.html 之后
// 桥仍旧把启动那一刻缓存的旧页面（03.07.00）发给所有设备，直到有人重启桥进程——而 jump 桥是
// SYSTEM 计划任务托管、ssh 用户无权重启，"只更新前端"这种最常见的部署于是被卡死在"必须重启"。
// 现在缓存对象多记两个字段 { mtimeMs, size }，serveAppHtml 每次请求先 fs.statSync 一次（一次 stat
// 的成本相对 3MB 响应体可忽略），mtime 或 size 任一跟缓存记录不一致就同步重读并重算 ETag；stat
// 不到/读不到时保留旧缓存继续服务（scp 覆盖中途的短暂窗口不该让页面 500）。BRIDGE_API_VERSION
// 保持 58：这不是 API 变化，只是同一条路由的新鲜度语义修正。回归见 tools/e2e/test_p133_bridge_serve.js
// 组 A（对 aba52fd 的旧 server.js 做 FAIL-first：改文件后 ETag 不变，即"红"）。
let APP_HTML_CACHE = null; // { body: Buffer, etag: string, mtimeMs: number, size: number } | null
function buildAppHtmlCache(buf, st) {
    return {
        body: buf,
        etag: '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"',
        mtimeMs: st.mtimeMs,
        size: st.size
    };
}
function loadAppHtmlCache() {
    // 先 stat 后 read：两步之间文件若被替换，记下的是"旧"stat + "新"内容，下一次请求 stat 不一致
    // 会再重读一次自愈；反过来（先 read 后 stat）会记下"新"stat + "旧"内容，永远不会再重读——
    // 顺序不能反。
    fs.stat(APP_HTML_PATH, (statErr, st) => {
        if (statErr) {
            console.warn('[latex-bridge] 预读 AI-Translator.html 到缓存失败（不影响服务，每次请求会退回同步读取）：' + (statErr && statErr.message));
            return;
        }
        fs.readFile(APP_HTML_PATH, (err, buf) => {
            if (err) {
                console.warn('[latex-bridge] 预读 AI-Translator.html 到缓存失败（不影响服务，每次请求会退回同步读取）：' + (err && err.message));
                return;
            }
            APP_HTML_CACHE = buildAppHtmlCache(buf, st);
        });
    });
}
// 返回当前应当发出去的缓存对象；缓存不存在/已过期时同步重读。返回 null 表示磁盘上读不到文件且
// 也没有任何旧缓存可用（调用方回 500）。
function freshAppHtmlCache() {
    let st = null;
    try { st = fs.statSync(APP_HTML_PATH); } catch (e) { st = null; }
    if (!st) return APP_HTML_CACHE; // 文件此刻不可见（scp 中途/被删）：有旧缓存就继续用旧缓存
    if (APP_HTML_CACHE && APP_HTML_CACHE.mtimeMs === st.mtimeMs && APP_HTML_CACHE.size === st.size) {
        return APP_HTML_CACHE;
    }
    let buf = null;
    try { buf = fs.readFileSync(APP_HTML_PATH); } catch (e) { buf = null; }
    if (!buf) return APP_HTML_CACHE; // 读失败同上：保留旧缓存
    if (buf.length === 0 && APP_HTML_CACHE) return APP_HTML_CACHE; // 覆盖写入把文件截成 0 字节的瞬间：不缓存半截、不发空页
    APP_HTML_CACHE = buildAppHtmlCache(buf, st);
    return APP_HTML_CACHE;
}

// 令牌来自环境变量还是 .bridge-token 文件——只用于启动横幅播报"来源"，不含令牌值本身。
const TOKEN_FROM_ENV = !!process.env.LATEX_BRIDGE_TOKEN;

function loadOrCreateToken() {
    if (process.env.LATEX_BRIDGE_TOKEN) return process.env.LATEX_BRIDGE_TOKEN;
    try {
        const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
        if (existing) return existing;
    } catch (e) { /* 文件不存在或读不了，走下面的生成分支 */ }
    const generated = crypto.randomBytes(32).toString('hex');
    try { fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 }); } catch (e) {
        console.warn('[latex-bridge] 无法写入令牌文件 ' + TOKEN_FILE + '：' + (e && e.message));
    }
    return generated;
}

const BRIDGE_TOKEN = loadOrCreateToken();

// 定长时间比较，防时序侧信道——不要用 === 直接比字符串。
function timingSafeEqualStr(a, b) {
    const bufA = Buffer.from(String(a || ''), 'utf8');
    const bufB = Buffer.from(String(b || ''), 'utf8');
    if (bufA.length !== bufB.length) {
        // 长度不等也跑一次等长比较（跟自己比），避免"提前返回"这件事本身泄露长度信息。
        try { crypto.timingSafeEqual(bufA, bufA); } catch (e) {}
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

// 令牌只走请求头，绝不出现在 URL 查询串、日志或错误消息里。
function tokenAuthorized(req) {
    if (!REMOTE_MODE) return true;
    const provided = req.headers[TOKEN_HEADER];
    if (!provided || typeof provided !== 'string') return false;
    return timingSafeEqualStr(provided, BRIDGE_TOKEN);
}

// ---------------------------------------------------------------------------
// v2 Pass P50：WebSocket 一次性短时票据存储。REMOTE_MODE 下磁盘变更推送这条 WS 连接原本完全
// 没鉴权（浏览器 WebSocket API 加不了自定义请求头，长期令牌没法像 HTTP 请求那样走请求头带过
// 去）——票据只解决"连接建立时怎么证明你是持有令牌的人"，不是长期令牌的替代品：一次性（用过
// 即从 Map 里删掉）、60 秒短时效、只在 REMOTE_MODE 下强制校验，本地模式（REMOTE_MODE=false）
// WS 连接不受影响，跟没有这套机制之前逐字节一致。
// ---------------------------------------------------------------------------
// LATEX_BRIDGE_WS_TICKET_TTL_MS 仅供测试用（缩短过期时间验证"过期票据被拒"，不用真等 60 秒）：
// 不传时行为跟没有这个覆盖变量之前完全一样，还是硬编码 60000ms。
const WS_TICKET_TTL_MS = process.env.LATEX_BRIDGE_WS_TICKET_TTL_MS ? parseInt(process.env.LATEX_BRIDGE_WS_TICKET_TTL_MS, 10) : 60000;
const wsTickets = new Map(); // ticket -> expiresAt(ms)

function pruneExpiredWsTickets() {
    const now = Date.now();
    for (const [t, exp] of wsTickets) { if (exp <= now) wsTickets.delete(t); }
}

function createWsTicket() {
    pruneExpiredWsTickets();
    const ticket = crypto.randomBytes(24).toString('hex');
    wsTickets.set(ticket, Date.now() + WS_TICKET_TTL_MS);
    return ticket;
}

// 一次性：不管校验成不成功，只要 Map 里存在这个 key 就先删掉——防止同一张票被并发/重放使用
// 第二次（"检查完再删"之间有窗口期，这里改成"先取出再检查"，取的动作本身就是消费）。
function consumeWsTicket(ticket) {
    if (!ticket || typeof ticket !== 'string') return false;
    const exp = wsTickets.get(ticket);
    wsTickets.delete(ticket);
    if (!exp) return false;
    if (exp <= Date.now()) return false;
    return true;
}

// /health 是唯一豁免令牌校验的端点（前端要靠它探活，探活本身不该要求先有令牌）；
// GET / 是人读的欢迎页，同样豁免。v2 Pass P110：GET / 和 GET /AI-Translator.html 现在都是
// serve 页面本身（见 serveAppHtml），必须豁免——否则出现"要令牌才能加载到能填令牌的输入框"
// 的死锁；页面本身没有秘密，加载后它发出的其它一切请求仍然照常过令牌闸门，鉴权模型不变。
// GET /favicon.ico 同样豁免（浏览器自动请求，早于任何令牌可用，见 favicon 处理）。除此之外
// 的一切路由（/fs/*、/overleaf/*、/compile、/stop、/clear、/pick-folder、/synctex/*、
// /output/*、/project-asset、/wordcount……）全部经过下面路由分发前的统一校验，不再逐个端点
// 手动加。
const TOKEN_EXEMPT_PATHS = new Set(['/health', '/', '/AI-Translator.html', '/routes', '/favicon.ico']);

// ---------------------------------------------------------------------------
// v2 Pass P154：可选的 projectDir 根目录白名单。
//
// 背景：resolveInProject()/safeProjectAssetPath() 只保证 relPath 逃不出 projectDir 本身，
// 但 projectDir 这个起点可以是磁盘上任意存在的目录（含 C:\ 本身）——这是给"项目内部用
// ../ 跳出去"设计的防线，从没打算当"整机沙箱"用（见 .claude/tmp/p154_filetree_design.md
// §2）。用户拍板方案 3：加一条可配置的多根白名单，用环境变量 LATEX_BRIDGE_ALLOWED_ROOTS
// （多条路径用 ';' 分隔）声明；不设置这个变量时（默认）——行为必须与之前逐字节一致，不做
// 任何限制，这是硬要求（用户当前就在用不受限的既有路径工作）。
//
// 设置了变量后：所有接受 projectDir 的端点在拿到 projectDir 之后、真正碰文件系统之前，
// 都要先过 checkProjectDirAllowed()；越界返回 403（不是 404——404 意味着"目录不存在"，
// 403 才是"目录存在但不允许访问"，前端要能区分这两种情况分别给用户不同的提示）。
// ---------------------------------------------------------------------------
const ALLOWED_ROOTS_RAW = process.env.LATEX_BRIDGE_ALLOWED_ROOTS || '';

// 规范化一个路径用于白名单比较：先 path.resolve 拿绝对路径，再尽量 realpath 展开
// （解析符号链接/NTFS junction、Windows 上顺带统一短路径名 8.3 形式）；路径此刻不存在
// （常见于"根目录还没建"或调用方传了个错的路径）时 realpath 会抛错，退回 resolve 的结果
// ——两边（白名单元素自己 + 每次请求的 projectDir）用的是同一个函数、同一套规则，规则
// 不对称就没有意义，所以整套白名单校验只认这一个函数出的值。
function normalizeForRootCheck(p) {
    let resolved;
    try { resolved = path.resolve(p); } catch (e) { return null; }
    try { return fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved); }
    catch (e) { return resolved; } // 路径不存在/不可读：退回纯字符串规范化结果
}

// 白名单根列表：启动时算一次（不是每次请求都重新 split/realpath），跟 BRIDGE_CAPABILITIES
// 等其它启动期配置一致的做法。
const ALLOWED_ROOTS = ALLOWED_ROOTS_RAW.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((p) => normalizeForRootCheck(p))
    .filter((p) => p !== null);
const ALLOWED_ROOTS_ENABLED = ALLOWED_ROOTS.length > 0;
// 供 /health 展示用的"原始配置字符串"版本（未经 realpath 展开）——管理员在环境变量里怎么
// 写就怎么显示，比展开后可能变了大小写/解析了符号链接的 ALLOWED_ROOTS 元素更符合直觉；
// 两者描述的是同一组根，只是显示 vs 比较分别用各自更合适的形式。
const ALLOWED_ROOTS_DISPLAY = ALLOWED_ROOTS_RAW.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

// 大小写：Windows 文件系统默认不区分大小写（NTFS 底层区分，但两个大小写不同的路径字符串
// 指向的是同一个文件/目录），前缀比较必须按平台归一化大小写，否则 "c:\\foo" 会被误判成不在
// "C:\\Foo" 白名单根下——这本身就是一种绕过手法（用户随手打错大小写不算"绕过"，但如果
// 白名单只做区分大小写的字符串比对，会把"大小写不同但其实是同一个目录"的合法路径也拒了，
// 属于误伤而不是安全问题，这里一并修正）。
function isPathUnderRoot(candidate, root) {
    const c = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
    const r = process.platform === 'win32' ? root.toLowerCase() : root;
    if (c === r) return true;
    const rWithSep = r.endsWith(path.sep) ? r : r + path.sep;
    return c.indexOf(rWithSep) === 0;
}

// 校验 projectDir 是否落在白名单根之下。未设置 LATEX_BRIDGE_ALLOWED_ROOTS 时永远放行
// （{ok:true}）——跟之前逐字节一致的行为，不因为加了这套机制就在默认情况下多做任何检查。
// 设置了但越界：{ok:false, status:403, error}；projectDir 本身不合法（空/无法 resolve）：
// {ok:false, status:400, error}（不是安全边界问题，是请求本身有毛病，跟未设白名单时其它
// 端点对空 projectDir 的既有 400 处理口径一致）。
function checkProjectDirAllowed(projectDir) {
    if (!ALLOWED_ROOTS_ENABLED) return { ok: true };
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, status: 400, error: 'projectDir 缺失' };
    const norm = normalizeForRootCheck(projectDir);
    if (!norm) return { ok: false, status: 400, error: 'projectDir 无效: ' + projectDir };
    const allowed = ALLOWED_ROOTS.some((root) => isPathUnderRoot(norm, root));
    if (!allowed) {
        return { ok: false, status: 403, error: 'projectDir 不在允许访问的根目录白名单内，拒绝: ' + projectDir };
    }
    return { ok: true };
}

// 路由分发处的统一收口：不通过就直接把 403/400 写回响应并返回 true（调用方据此 return，
// 不再往下执行），通过就返回 false（调用方照常继续）。避免在十来个路由里重复同一段
// "拿到 check 结果 -> 判断 -> sendJson -> return" 样板代码。
function rejectIfProjectDirNotAllowed(res, projectDir) {
    const check = checkProjectDirAllowed(projectDir);
    if (!check.ok) {
        sendJson(res, check.status || 403, { ok: false, error: check.error });
        return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// v2 Pass P154：OneDrive Files On-Demand"云端占位符"友好报错。
//
// 实测事实（.claude/tmp/p154_filetree_design.md 任务书原文 + 本轮 2026-09-10 在 jump 上
// 交叉验证）：一个 OneDrive 按需同步、尚未下载到本地的文件，Windows 属性位包含
// FILE_ATTRIBUTE_OFFLINE（0x1000）和/或 FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS（0x400000）
// （通常还伴随 FILE_ATTRIBUTE_UNPINNED 0x100000、FILE_ATTRIBUTE_SPARSE_FILE 0x200、
// FILE_ATTRIBUTE_REPARSE_POINT 0x400）；本地没有实体数据，Node 的 fs.readFileSync 对它
// 会抛 `UNKNOWN: unknown error`，用户看到的就是这句天书。
//
// Node 的 fs.statSync 在 Windows 上拿不到这些底层 FILE_ATTRIBUTE_* 位（fs.Stats 没有
// attributes 字段，只有 mode/mtime 这类 POSIX 概念的字段），本函数退而求其次调用 Windows
// 自带的 attrib.exe 解析它的人类可读输出——`attrib /?` 明确记录了 O（Offline attribute）
// 和 U（Unpinned attribute）两个跟 OneDrive Files On-Demand 直接相关的字母标记，命中任一
// 个就判定为占位符。
//
// 可靠性（如实记录，不夸大）：本轮在 jump 上对设计文档点名的那个真实占位符文件做了交叉
// 验证——用 PowerShell `(Get-Item path).Attributes.value__` 读原始属性整数（.NET 层面的
// 权威来源）跟同一文件 `attrib` 命令的字母输出对比，两者在该文件当前状态（已被后续某次
// 检查意外"预热"下载、属性从最初记录的 4199968 变成了 525344=Archive+ReparsePoint+
// Pinned）下完全吻合——`attrib` 输出里出现的 P 字母，跟 PowerShell 报告的 Pinned 位
// （0x80000）精确对应。这证明 attrib.exe 的字母输出确实忠实反映 Windows 记录的真实属性
// 位，不是道听途说的猜测。但没能对 Offline/Unpinned 分支做同一种端到端交叉验证——唯一
// 已知的样本文件在本轮实现开始前就已经从"仅云端"变成"已固定本地"（推测是仅有的一次检查
// 过程本身、或后台杀毒/索引触发了 OneDrive 的隐式下载），jump 上目前没有找到第二个仍处于
// 离线占位符状态的样本可供复现。因此：Offline/Unpinned 分支的检测逻辑基于 attrib.exe 自己
// 的文档化字母含义（非独家猜测），但没有本轮的活体样本验证；一旦这个探测在未来因为
// Windows 版本差异/attrib.exe 输出格式变化而失效，表现是"探测不到占位符特征，静默退回
// 原始的 UNKNOWN 错误文案"——不会误报成功，也不会抛出新异常中断请求（spawnSync 的任何
// 失败形态、非零退出码、超时都在 catch/条件判断里被吞成"不是占位符"，绝不是一个悄悄
// 永远不触发的假实现：只要 attrib.exe 存在且遇到真正的占位符文件，这条路径就会命中）。
// ---------------------------------------------------------------------------
function isOneDrivePlaceholderByAttrib(absPath) {
    if (process.platform !== 'win32') return false;
    try {
        const r = spawnSync('attrib', [absPath], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
        if (r.error || typeof r.stdout !== 'string' || !r.stdout) return false;
        const firstLine = r.stdout.split(/\r?\n/)[0] || '';
        const idx = firstLine.lastIndexOf(absPath);
        // 只看路径之前的那一段属性字母，避免路径本身恰好含独立的大写 O/U 字母造成误判
        // （比如某个项目目录名本身叫 "U-Boat" 之类）。
        const attrPart = idx > 0 ? firstLine.slice(0, idx) : firstLine;
        return /(^|\s)O(\s|$)/.test(attrPart) || /(^|\s)U(\s|$)/.test(attrPart);
    } catch (e) {
        return false;
    }
}

const ONEDRIVE_PATH_HINT_RE = /onedrive/i;

// 读文件失败时统一走这里，决定要不要把 Node 的原始报错替换成人话版本。只在
// err.code === 'UNKNOWN'（Node 在 Windows 上对占位符读取失败的典型报错形状）且路径本身
// 含 "OneDrive" 字样时才去调用 attrib.exe 探测——避免给每一次权限错误/文件不存在错误都
// 多打一次子进程；探测不到占位符特征（或探测本身失败/超时/非 Windows）时原样返回
// Node 的原始错误文案，不做任何改写。
function describeFileReadError(err, absPath) {
    const raw = (err && err.message) || String(err);
    if (!err || err.code !== 'UNKNOWN') return raw;
    if (typeof absPath !== 'string' || !ONEDRIVE_PATH_HINT_RE.test(absPath)) return raw;
    if (!isOneDrivePlaceholderByAttrib(absPath)) return raw;
    return '这个文件是 OneDrive 按需同步（Files On-Demand）的云端占位符，本机（桥所在机器）上没有下载实体数据，因此读取失败。'
        + '解决办法：在桥所在机器上对该文件（或所在目录）执行 attrib +P -U "' + absPath + '"，'
        + '或者在文件资源管理器里右键该文件/文件夹 → 「始终保留在此设备上」，等 OneDrive 下载完成后再重试。'
        + '（原始错误：' + raw + '）';
}

let currentChild = null;
let currentChildId = null;

// v2 Pass P119：POST /admin/restart 的排程状态——一旦排上，1 秒退出窗口内的重复调用直接
// 幂等返回，不重复计时、不重复触发下面的 killTree/process.exit。进程一退出这个变量自然
// 归零（跟着整个进程消失），不需要显式重置。
let restartScheduled = false;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

// v2 Pass P49：远程机器上的页面仍是 file://（Origin: null），本地机器上是 http://127.0.0.1
// 之类。不再无脑回显任意 Origin/用 "*"——只认 "null" 和 localhost 家族，其余一律不设
// Access-Control-Allow-Origin（浏览器会因此拦下响应）。真正的防线是令牌
// （见 tokenAuthorized），这里的 Origin 白名单只是浏览器侧的第二层，不是唯一防线。
function corsAllowedOrigin(origin) {
    if (!origin || origin === 'null') return 'null';
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin;
    return null;
}

function cors(req, res) {
    const allowed = corsAllowedOrigin(req.headers.origin);
    if (allowed) res.setHeader('Access-Control-Allow-Origin', allowed);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, ' + TOKEN_HEADER);
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
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

// v2 Pass P110：把 AI-Translator.html 自己 serve 出去。二进制安全读取——不带 'utf8' 编码参数，
// 原样按字节吐出去（该文件含约 27000 个 NUL 字节，走字符串编码会破坏它）。路径固定死
// （APP_HTML_PATH），不吃任何请求参数，跟"通用静态目录服务"是两回事，不存在路径穿越的问题。
// 找不到文件（比如仓库结构被改过）就老实 500，不是这条路由的正常状态。
// v2 Pass P110b（N-1 非阻塞项）：优先用启动时预读好的 APP_HTML_CACHE（含 ETag），命中
// If-None-Match 直接 304 空体；缓存还没就绪（启动瞬间的极小窗口，或预读失败）才退回逐请求同步
// readFileSync 兜底，保证正确性不依赖缓存是否命中。
// v2 Pass P133（B1）：缓存新鲜度改由 freshAppHtmlCache() 统一判定（每请求 stat 一次，mtime/size
// 变了就重读并重算 ETag）——见上面 APP_HTML_CACHE 处的说明。
function serveAppHtml(req, res) {
    const cache = freshAppHtmlCache();
    if (!cache) {
        sendJson(res, 500, { ok: false, error: '读取 AI-Translator.html 失败：磁盘上找不到或读不到 ' + APP_HTML_PATH });
        return;
    }
    const body = cache.body;
    const etag = cache.etag;
    const inm = req && req.headers && req.headers['if-none-match'];
    if (inm && inm === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
        res.end();
        return;
    }
    res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'ETag': etag,
        'Content-Length': body.length
    });
    res.end(body);
}

// v2 Pass P98：逐请求结构化日志——诊断 ImCDN 核验事故（.claude/tmp/diag_imcdn_verify.md）时
// 发现 server.js 全程零逐请求日志，出问题只能靠翻 WORK_ROOT 临时目录的时间戳侧面推断，取证
// 成本高且不精确。这里只打元数据（时间戳/方法/端点/target/jobId/结局），绝不打请求体/响应体/
// 编译日志正文——避免日志膨胀，也避免任何用户论文内容意外落进 stdout。只加日志，不改任何
// 响应契约、不动 BRIDGE_API_VERSION。
function logRequest(fields) {
    const parts = ['[' + new Date().toISOString() + ']', fields.method || '?', fields.pathname || '?'];
    if (fields.target) parts.push('target=' + fields.target);
    if (fields.jobId) parts.push('jobId=' + fields.jobId);
    parts.push('outcome=' + (fields.outcome || '?'));
    if (typeof fields.durationMs === 'number') parts.push(fields.durationMs + 'ms');
    console.log(parts.join(' '));
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

// v2 Pass P91 §5 实测发现的真缺陷（不在原定四项范围内，顺手修）：latexmk.exe 在这台机器上
// 派生 pdflatex.exe 时，实测经过了一层 Git Bash 的 sh.exe（`sh.exe -c "pdflatex ..."`，命令行
// 里 -output-directory 用的还是正斜杠 /tmp/... 路径，跟 Node 这边 path.join 拼出来的反斜杠
// 路径字符串对不上）——taskkill /pid <latexmk 的 pid> /T /F 连 latexmk 直接派生的 sh.exe 都
// 没带走（P91 组 E 用死循环 LaTeX 源测编译超时按页数伸缩时实测复现：两次超时杀掉后各留下一个
// sh.exe + 一个 pdflatex.exe，都在吃 CPU 空转）。核验超时改按页数伸缩（更短、更常触发）之后
// 这条隐患会被放大，顺手补上二次扫荡：jobIdHint 传了就按"命令行包含这个编译任务专属的随机
// job id"精确匹配再杀一遍——job id 是 crypto.randomBytes 生成的唯一字符串，不含路径分隔符，
// 天然不受正斜杠/反斜杠差异影响，也不会误杀别的编译任务或用户自己手跑的 TeX 进程。
function killTree(pid, jobIdHint) {
    // v2 Pass P214 SERVER-5：返回 Promise，调用方可以不等；/admin/restart 与 SIGINT 要等它收尾再退出。
    // taskkill 与二次扫荡都改用异步 spawn（各自带超时上限）：以前都是 execSync，会把整个事件循环
    // （所有 HTTP/WS）卡住——扫荡最长 8 秒，taskkill 在被拒绝/卡住时也可达数秒。
    if (!pid) return Promise.resolve();
    if (process.platform === 'win32') {
        return runTaskkillAsync(pid).then(() => (jobIdHint ? sweepJobIdProcessesAsync(jobIdHint) : undefined));
    } else {
        try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (e2) {} }
        return Promise.resolve();
    }
}

function runTaskkillAsync(pid) {
    return new Promise((resolve) => {
        let done = false;
        const finishOnce = () => { if (!done) { done = true; resolve(); } };
        try {
            const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
            const t = setTimeout(() => { try { tk.kill(); } catch (e) {} finishOnce(); }, 10000);
            tk.on('error', () => { clearTimeout(t); finishOnce(); });
            tk.on('close', () => { clearTimeout(t); finishOnce(); });
        } catch (e) { finishOnce(); }
    });
}

// 按命令行含 job id 精确扫荡（异步，永不 resolve 失败）。排除扫荡用的 powershell 自己
// （它的命令行里也含这个 job id）。
function sweepJobIdProcessesAsync(jobIdHint) {
    return new Promise((resolve) => {
        let done = false;
        const finishOnce = () => { if (!done) { done = true; resolve(); } };
        try {
            const escaped = String(jobIdHint).replace(/'/g, "''");
            const psCmd = "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.ProcessId -ne $PID -and $_.CommandLine -like '*" + escaped + "*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
            const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psCmd, 'utf16le').toString('base64')], { stdio: 'ignore', windowsHide: true });
            const t = setTimeout(() => { try { ps.kill(); } catch (e) {} finishOnce(); }, 8000);
            const t0 = Date.now();
            ps.on('error', () => { clearTimeout(t); finishOnce(); });
            ps.on('close', (code) => {
                clearTimeout(t);
                // 诊断日志：二次扫荡到底有没有跑、花了多久（以前同步执行，全程零日志）。
                try { console.log('[latex-bridge] job-id sweep ' + jobIdHint + ' -> exit ' + code + ' in ' + (Date.now() - t0) + 'ms'); } catch (e) {}
                finishOnce();
            });
        } catch (e) { finishOnce(); }
    });
}

const ID_RE = /^[a-zA-Z0-9_-]+$/;

function safeOutdirForId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return null;
    return path.join(WORK_ROOT, id);
}

// v2 Pass P214 SERVER-8：WORK_ROOT 下的任务目录以前只有手动 /clear 才会删，长期运行的桥会无限涨。
// 现在每次新建任务目录（compile / synctex/rehydrate）时顺带异步清理：超过 3 天、或不在最新 50 个之内的
// 目录删掉；当前任务的目录（刚创建的 + 正在跑的编译）永不删；每小时最多跑一次，绝不阻塞请求。
// 两个环境变量只给测试用，默认值就是上面的口径。
function envIntOr(name, dflt) {
    const v = process.env[name];
    if (v === undefined || v === '') return dflt;
    const n = parseInt(v, 10);
    return isFinite(n) && n >= 0 ? n : dflt;
}
const WORK_PRUNE_MAX_AGE_MS = envIntOr('LATEX_BRIDGE_WORK_MAX_AGE_MS', 3 * 24 * 3600 * 1000);
const WORK_PRUNE_KEEP = envIntOr('LATEX_BRIDGE_WORK_KEEP', 50);
const WORK_PRUNE_INTERVAL_MS = 3600 * 1000;
let lastWorkPruneAt = 0;
let workPruneRunning = false;
function scheduleWorkRootPrune(protectedId) {
    const now = Date.now();
    if (workPruneRunning || (lastWorkPruneAt && now - lastWorkPruneAt < WORK_PRUNE_INTERVAL_MS)) return;
    lastWorkPruneAt = now;
    workPruneRunning = true;
    setImmediate(() => {
        pruneWorkRoot(protectedId).then(() => {}, () => {}).then(() => { workPruneRunning = false; });
    });
}
async function pruneWorkRoot(protectedId) {
    let names;
    try { names = await fs.promises.readdir(WORK_ROOT); } catch (e) { return; }
    const items = [];
    for (const n of names) {
        if (!ID_RE.test(n)) continue;
        try {
            const st = await fs.promises.stat(path.join(WORK_ROOT, n));
            if (st.isDirectory()) items.push({ name: n, mtimeMs: st.mtimeMs });
        } catch (e) {}
    }
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const now = Date.now();
    for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.name === protectedId || it.name === currentChildId) continue;
        if (i >= WORK_PRUNE_KEEP || now - it.mtimeMs > WORK_PRUNE_MAX_AGE_MS) {
            await fsRemoveTree(path.join(WORK_ROOT, it.name), { force: true });
        }
    }
}

// v2 Pass P214 S-C：mainFile 必须落在 projectDir 之内（含符号链接/junction 与 .git 校验，复用 resolveInProject）。
// 以前 /compile、/wordcount、/synctex/forward 对绝对路径或带 .. 的 mainFile 照单全收，白名单只检查了 projectDir。
function resolveMainFileInProject(projectDir, mainFile) {
    if (typeof mainFile !== 'string' || !mainFile) return null;
    const r = resolveInProject(projectDir, mainFile);
    return r.ok ? r.resolved : null;
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
    const fileLineRe = /^((?:[A-Za-z]:)?[^\s:][^:]*\.(?:tex|sty|cls|bbl)):(\d+):\s*(.+)$/; // v2 Pass P214 SERVER-6：允许盘符前缀 C:/...
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
// v2 Pass P214 SERVER-11/12：判断相对路径的某一段是否指向 .git。Windows 文件系统大小写不敏感，
// 且会忽略段尾的点和空格、接受 NTFS 备用数据流后缀（.git::$DATA）与 8.3 短名（GIT~1），所以
// win32 下要先规范化再比较；其他平台保持精确匹配。resolveInProject 与 safeProjectAssetPath 共用。
function isGitPathSegment(seg) {
    let t = String(seg);
    if (process.platform === 'win32') {
        t = t.split(':')[0].replace(/[. ]+$/, '').toLowerCase();
        return t === '.git' || /^git~\d+$/.test(t);
    }
    return t === '.git';
}
function relSegmentsHaveGit(segments) {
    return segments.some(isGitPathSegment);
}

function safeProjectAssetPath(projectDir, relPath) {
    if (typeof projectDir !== 'string' || !projectDir) return null;
    if (typeof relPath !== 'string' || !relPath) return null;
    let base;
    try { base = path.resolve(projectDir); } catch (e) { return null; }
    let resolved;
    try { resolved = path.resolve(base, relPath); } catch (e) { return null; }
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && resolved.indexOf(baseWithSep) !== 0) return null; // 跑出项目目录，一律拒绝
    // v2 Pass P214 SERVER-12：同 resolveInProject，拒绝 .git 内部路径（.git/config 可能含带凭据的 remote URL）。
    if (relSegmentsHaveGit(path.relative(base, resolved).split(path.sep).filter((x) => x.length > 0))) return null;
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
//
// v2 Pass P111 §Bug A 追加发现（.claude/tmp/p111_recon_local.md）：上面这套"拷进 outdir"的
// 机制解决的是 bibtex *真正执行时*的 BIBINPUTS 翻译坑，但 latexmk 在决定"要不要跑 bibtex"
// 之前还有一道更早的、完全独立的"文件是否存在"预检查——这道检查相对 latexmk 自己的进程 cwd
// （=doCompile() 里的 compileCwd=path.dirname(mainAbs)）去找 .bib，跟 outdir 不是同一个目录，
// copyBibResourcesToOutdir 这一步对它完全不起作用。main.tex 挪进子目录、.bib 留在项目根时，
// 这道预检查会失败，latexmk 直接一票否决 bibtex（从不尝试运行）——真正的修复是 doCompile()
// 给 spawn 显式设置 BIBINPUTS/BSTINPUTS 环境变量（见下方），这里的注释只是防止后来者以为
// "这个函数已经处理了 BIBINPUTS 问题"而重复踩坑。
function findBibRecursive(dir, name, maxDepth) {
    if (maxDepth <= 0) return null;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return null; }
    for (const ent of entries) {
        if (ent.isFile() && ent.name === name) return path.join(dir, name);
    }
    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const bn = ent.name;
        if (bn === '.git' || bn === 'node_modules' || bn.charAt(0) === '.') continue; // 跳过噪音目录
        const found = findBibRecursive(path.join(dir, bn), name, maxDepth - 1);
        if (found) return found;
    }
    return null;
}

// v2 Pass P111 返修（.claude/tmp/p111_verify.md 问题 1+2）：copyBibResourcesToOutdir 原来直接对
// mainAbs 原始文本跑 \bibliography{}/\addbibresource{} 正则，有两处漏洞：
//   ① 不剥 LaTeX 行注释（%…）。用户切换 bib 方案时把旧的 \bibliography/\addbibresource 写法
//      注释掉留着是极常见习惯——旧写法照样被正则认出来，若那个名字在项目里哪里都不存在
//      （它当然不存在，只活在注释里），就会往用户完全健康的编译结果里插一条对本次编译失实的
//      红色 error 诊断，点名一个用户根本不认识、只存在于注释里的文件名。
//   ② 只读 mainAbs 一个文件，不跟 \input{}/\include{}。长论文用子文件拆章节是标配写法，
//      \bibliography 常常写在被 \input 进来的子文件里而不是 main.tex 本身——这种布局下引用
//      名字压根不会被发现，后面的递归兜底、诊断都无从触发，退回完全静默的 [?]，跟本函数存在
//      的目的正相反。
// 两处都在"读文本"这一步解决：先剥注释，再沿 \input/\include 浅层展开，把展开后的全部文本
// 拼在一起再跑两条正则；下面两个辅助函数就做这件事。
//
// v2 Pass P111c 根治返修（第2轮核验 .claude/tmp/p111_verify.md §5.2）：① 只剥了 % 注释，
// \iffalse…\fi/\begin{comment}/\begin{verbatim} 等同类"注释掉/不排版"构造换个写法就能重现
// 同一种假红错——静态文本扫描天生堵不完这类构造。这两个辅助函数本身不再改（继续按"名字有没有
// 出现在文本里"扫），真正的根治在下面 doCompile()/finish() 里：诊断该不该插入，改成看"这次
// 编译是否真的有未解析引用的证据"，静态扫描结果降级为"报错时该点名哪个文件"的辅助信息源。

// 剥 LaTeX 行注释：从第一个"未被 \ 转义"的 % 开始到行尾整段删掉。不能用简单的
// /(?<!\\)%.../ ——负向先行断言只看紧邻的一个字符，真正的字面反斜杠后跟注释（"\\%"，即
// TeX 源码里的 "\textbackslash{}" 这类场景之外、直接双反斜杠加百分号）会被错判成转义；标准
// 做法是数连续反斜杠个数，偶数（含 0）个才是未转义。
function stripLatexLineComments(text) {
    return text.split(/\r\n|\r|\n/).map((line) => {
        let searchFrom = 0;
        while (true) {
            const idx = line.indexOf('%', searchFrom);
            if (idx === -1) return line;
            let backslashes = 0;
            let j = idx - 1;
            while (j >= 0 && line.charAt(j) === '\\') { backslashes++; j--; }
            if (backslashes % 2 === 0) return line.slice(0, idx); // 未转义，注释从这里开始，砍掉
            searchFrom = idx + 1; // 是 \% 转义，不是注释，继续往后找下一个 %
        }
    }).join('\n');
}

// 在候选目录里定位 \input{name}/\include{name} 指向的 .tex 文件——候选目录顺序（主文件所在
// 目录优先，项目根兜底）跟本函数其余部分找 .bib 的候选顺序保持一致。
function resolveIncludedTexFile(name, searchDirs) {
    const withExt = name.endsWith('.tex') ? name : name + '.tex';
    for (const dir of searchDirs) {
        const p = path.join(dir, withExt);
        if (fs.existsSync(p)) return p;
    }
    return null;
}

// 从 mainAbs 出发，沿 \input{}/\include{} 浅层展开收集全部文本（已剥注释）。深度上限 8、
// 累计文件数上限 64，防病态深/宽子文件树；用 realpath 去重防止 \input 自环死循环。单个子
// 文件读失败（不存在/权限问题）静默跳过，不影响主文件及其余子文件已扫到的部分。
function collectBibScanText(mainAbs, projectDir) {
    const searchDirs = [path.dirname(mainAbs), projectDir].filter((d, i, arr) => arr.indexOf(d) === i);
    const visited = new Set();
    const chunks = [];
    function visit(absPath, depth) {
        let real;
        try { real = fs.realpathSync(absPath); } catch (e) { real = absPath; }
        if (visited.has(real)) return;
        visited.add(real);
        let raw;
        try { raw = fs.readFileSync(absPath, 'utf8'); } catch (e) { return; }
        const clean = stripLatexLineComments(raw);
        chunks.push(clean);
        if (depth >= 8 || visited.size >= 64) return; // 防病态深/宽子文件树
        // v2 Pass P111c（p111_verify.md §5.3 代码质量提示）：原来是模块级共享的 RegExp 对象，
        // 每次递归手动把 lastIndex 重置为 0 再 exec() 循环——父层调用在子层递归 return 之后会
        // 从头把自己那段文本重扫一遍（O(n²)），且"共享可变状态 + 手动管理 lastIndex"这种写法
        // 本身就脆，后面谁改一下调用顺序就容易出真 bug。改成每次调用 visit() 时当场求值一个
        // 正则字面量喂给 matchAll()——matchAll 内部对 global 正则做的是克隆式迭代，不依赖也不
        // 污染外部 lastIndex，天然没有这个问题，不用手动管理任何状态。行为不变：S3（自指
        // \input 不死循环）、S4（\bibliography 在第二个 \input 里，靠 visited 短路不丢不重复）
        // 两个既有夹具在改动后依旧全过。
        // v2 Pass P118 核验返修（.claude/tmp/p118_verify.md §三.3）：与 mirrorIncludeDirs() 同一处
        // 空格盲区——`\input {name}` / `\include {name}`（控制字与 `{` 间有空白）是合法 TeX 写法，
        // 原正则 `\{` 前无 `\s*` 会漏扫。
        for (const mm of clean.matchAll(/\\(?:input|include)\s*\{([^}]*)\}/g)) {
            const n = mm[1].trim();
            if (!n) continue;
            const target = resolveIncludedTexFile(n, searchDirs);
            if (target) visit(target, depth + 1);
        }
    }
    visit(mainAbs, 0);
    return chunks.join('\n');
}

// 返回诊断信息（v2 Pass P111 新增）：{ referenced, found, missing }——分别是 main.tex（及其
// \input/\include 展开出的子文件）里点名的全部 .bib 文件名（去重）、成功定位并拷贝的、以及
// 哪里都找不到的。调用方（doCompile/finish）用这份信息在找不到时给出明确中文诊断，不是让
// 引用悄悄变成 [?]。
function copyBibResourcesToOutdir(mainAbs, projectDir, outdir) {
    const diag = { referenced: [], found: [], missing: [] };
    let text;
    try { text = collectBibScanText(mainAbs, projectDir); } catch (e) { return diag; }
    if (!text) return diag;
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
        if (diag.referenced.indexOf(name) === -1) diag.referenced.push(name);
        // v2 Pass P60：.bib 常跟主 .tex 放同一目录（子目录报告场景），优先在主文件目录找，
        // 找不到再退回项目根（老项目 .bib 放根目录的既有行为零回归）。
        const srcNextToMain = path.join(path.dirname(mainAbs), name);
        const srcAtRoot = path.join(projectDir, name);
        let src = fs.existsSync(srcNextToMain) ? srcNextToMain : (fs.existsSync(srcAtRoot) ? srcAtRoot : null);
        if (!src) {
            // v2 Pass P111（R2 结论）：.bib 放在专门子目录（bib/、references/ 等）时，上面两处
            // 候选都找不到，加一层"projectDir 下递归查找"兜底，深度上限 8 层防止病态大目录树
            // 拖慢编译；命中第一个同名文件即用（多个同名 .bib 是用户项目结构问题，不是本函数
            // 该猜的事）。
            src = findBibRecursive(projectDir, name, 8);
        }
        if (!src) { if (diag.missing.indexOf(name) === -1) diag.missing.push(name); return; } // 哪里都找不到，交给 bibtex 自己按原样报错，不装作成功
        const dest = path.join(outdir, name);
        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(src, dest);
            if (diag.found.indexOf(name) === -1) diag.found.push(name);
        } catch (e) {
            // 复制失败不算致命：最坏情况退回旧行为（BIBINPUTS 路径翻译问题依旧），但既然找到了
            // 源文件却没能拷成功，仍然记一笔 missing，好让诊断如实反映"最终没能生效"。
            if (diag.missing.indexOf(name) === -1) diag.missing.push(name);
        }
    });
    return diag;
}

// v2 Pass P118（.claude/tmp/p118_diag.md 已用隔离桥实测复现根因）：`\include{<path>}` 在
// nonstopmode 下会先 `\openout \@partaux` 把 aux 直接写到 `-outdir` 下与 `\include` 参数同名
// 的相对路径（例如 `\include{chapters/body}` → `outdir/chapters/body.aux`）。若 `chapters/`
// 子目录在 outdir 里不存在，openout 直接失败，nonstopmode 下升级成 Emergency stop，
// exitCode=12——跟 latexmk 多趟无关，direct 引擎单趟调用同样会触发，2 级嵌套
// （`\include{a/b/body}`）必须把 `a/b` 整条链都预建才行，建一层不够。
// 跟 bib 扫描器同一套思路：复用 collectBibScanText() 沿 \input/\include 展开出的全部可达
// 源码文本（已剥注释、已递归跟随子文件），抓出全部 \include{} 目标（\input 不触发
// \openout \@partaux，不需要预建），把每个目标路径的目录部分在 outdir 下整条镜像预建出来。
// normal 与 draft 两种模式都要挂。静态正则扫描的已知局限与 bib 扫描器同类（\iffalse/宏包裹
// 的 \include 扫不到）——这只是漏建（回退到当前已知的失败状态，不引入新故障），无假阳性
// 风险。刻意不感知 \includeonly：已实测 latexmk/pdflatex 对被 \includeonly 排除掉的目标根本
// 不会尝试 \openout，多建的空目录在一次性临时 outdir 里无副作用，无需多解析一层逗号列表。
// 控制字与 `{` 之间允许空白（`\include {chapters/body}` 是合法 TeX 写法，TeX 跳过控制字后的
// 空白）——正则须 `\s*` 容纳，否则这类写法漏建成"知已扫不到"的一种（P118 核验 §三.3）。
//
// v2 Pass P118 核验返修（.claude/tmp/p118_verify.md §三.2，阻塞项②）：`path.dirname(target)`
// 原样喂给 `path.join(outdir, dir)`，对 `..` 零校验——.tex 里一条 `\include{../../../evil/x}`
// 就能在 outdir **之外**任意可写位置建目录（实测可逃出整个临时目录树落到用户主目录）。这些
// 目标本来就编不过（TeX 自身 openout_any=paranoid 拒绝往 outdir 之外写 aux，建了也救不回任何
// 合法场景），收益为零、纯下行，直接跳过——`path.resolve` 后校验落点仍在 outdir 内部才建。
function mirrorIncludeDirs(mainAbs, projectDir, outdir) {
    let text;
    try { text = collectBibScanText(mainAbs, projectDir); } catch (e) { return; }
    if (!text) return;
    const outdirAbs = path.resolve(outdir);
    for (const mm of text.matchAll(/\\include\s*\{([^}]*)\}/g)) {
        const target = mm[1].trim();
        if (!target) continue;
        const dir = path.dirname(target);
        if (!dir || dir === '.') continue; // 根目录版：outdir 本身已存在，无需再建
        const destAbs = path.resolve(outdir, dir);
        if (destAbs !== outdirAbs && !destAbs.startsWith(outdirAbs + path.sep)) continue; // 越界目标：跳过，不建
        try { fs.mkdirSync(destAbs, { recursive: true }); } catch (e) {}
    }
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
    // v2 Pass P91 §5：可选的每次编译超时覆盖值（毫秒），不传或不是正数就落回默认
    // COMPILE_TIMEOUT_MS；传了就夹逼到 [COMPILE_TIMEOUT_MIN_MS, COMPILE_TIMEOUT_MAX_MS] 之间。
    let compileTimeoutMs = COMPILE_TIMEOUT_MS;
    if (typeof opts.timeoutMs === 'number' && isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
        compileTimeoutMs = Math.max(COMPILE_TIMEOUT_MIN_MS, Math.min(COMPILE_TIMEOUT_MAX_MS, opts.timeoutMs));
    }
    return new Promise((resolve) => {
        const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
        const outdir = path.join(WORK_ROOT, id);
        let resolved = false;
        const startedAt = Date.now();

        try { fs.mkdirSync(outdir, { recursive: true }); } catch (e) {
            resolve({ ok: false, error: 'mkdir outdir failed: ' + e.message });
            return;
        }
        scheduleWorkRootPrune(id); // v2 Pass P214 SERVER-8

        const mainAbs = resolveMainFileInProject(projectDir, mainFile); // v2 Pass P214 S-C
        if (!mainAbs) {
            resolve({ ok: false, error: 'mainFile 必须位于项目目录内: ' + String(mainFile) });
            return;
        }
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
        let bibDiag = { referenced: [], found: [], missing: [] };
        if (mode !== 'draft') bibDiag = copyBibResourcesToOutdir(mainAbs, projectDir, outdir);
        // v2 Pass P118：normal/draft 都要预建 \include{} 目标子目录，问题出在 \include 自身
        // 的 \openout，与 latexmk 多趟无关。
        mirrorIncludeDirs(mainAbs, projectDir, outdir);

        // v2 Pass P60：编译 cwd 必须是主文件所在目录，不能恒为 projectDir——.tex 内部的
        // \includegraphics{figures/fig.png} 这类相对路径是相对"进程 cwd"解析的（latexmk/
        // pdflatex/xelatex/lualatex 都一样，Overleaf/TeXstudio 也是这个语义），不是相对
        // .tex 文件自己所在目录。主文件在子目录（如 report/VR_08_07_2026/）、图片路径又
        // 相对该子目录写时，cwd=projectDir 会让 kpathsea 找不到图。主文件本来就在项目根时
        // path.dirname(mainAbs) === path.resolve(projectDir)，行为不变，零回归。
        const compileCwd = path.dirname(mainAbs);

        // v2 Pass P111 §Bug A：latexmk 在决定要不要跑 bibtex 之前有一道独立的"文件是否存在"
        // 预检查，是相对它自己的进程 cwd（=compileCwd）去找 .bib 的——跟 copyBibResourcesToOutdir
        // 拷贝进 outdir 完全不是同一个目录，main.tex 在子目录、.bib 在项目根时这道预检查会失败，
        // latexmk 直接一票否决 bibtex（从不尝试运行），引用全部变成 [?]（.claude/tmp/
        // p111_recon_local.md 已用 PowerShell 直跑 latexmk 验证）。显式把 BIBINPUTS/BSTINPUTS
        // 指向 projectDir + compileCwd + outdir（分号分隔、末尾留空段位保留 kpathsea 默认搜索
        // 路径，不破坏没有这个问题的既有场景），预检查和真正执行 bibtex 时都能在这些目录里找到
        // .bib——用原生 Windows 路径字符串（本进程是纯 Node spawn，不经过 MSYS/bash，没有
        // server.js 517-522 行注释描述的那种 Cygwin 路径转译坑）。只在 normal 模式设置：draft
        // 模式压根不跑 bibtex，不需要也不该改变它的环境。
        let compileEnv = process.env;
        if (mode !== 'draft') {
            const bibSearchDirs = [projectDir, compileCwd, outdir].filter((d, i, arr) => arr.indexOf(d) === i);
            const bibInputsValue = bibSearchDirs.join(';') + ';';
            compileEnv = Object.assign({}, process.env, {
                BIBINPUTS: bibInputsValue + (process.env.BIBINPUTS || ''),
                BSTINPUTS: bibInputsValue + (process.env.BSTINPUTS || '')
            });
        }

        // 同一时间只允许一个编译在跑；新请求来了先杀掉旧的（§3.1 契约）。
        // v2 Pass P98：这是纯粹的抢占（新杀旧），不是排队/拒绝——被杀一方的 HTTP 请求仍会走
        // finish() 正常拿到一个 200 JSON（诊断实录见 .claude/tmp/diag_imcdn_verify.md），客户端
        // 那边完全看不出"是被抢占的"。显式打一行 preempted 日志，这样下次同类事件能直接从
        // stdout 确认，不用再靠翻 WORK_ROOT 时间戳侧面推断。
        if (currentChild) {
            const preemptedJobId = currentChildId;
            try { killTree(currentChild.pid, preemptedJobId); } catch (e) {} // v2 Pass P214 SERVER-5：带 job id 触发二次扫荡
            logRequest({ method: 'POST', pathname: '/compile', jobId: preemptedJobId, outcome: 'preempted' });
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
            child = spawn(compilerBin, args, { cwd: compileCwd, windowsHide: true, env: compileEnv });
        } catch (e) {
            resolve({ ok: false, error: 'spawn ' + (mode === 'draft' ? engine : 'latexmk') + ' failed: ' + e.message });
            return;
        }
        currentChild = child;
        currentChildId = id;

        const timer = setTimeout(() => {
            if (resolved) return;
            finish(null, true);
        }, compileTimeoutMs);

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
                try { killTree(child.pid, id); } catch (e) {}
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

            // v2 Pass P111 §Bug A：main.tex 引用了 .bib（\bibliography{}/\addbibresource{}）
            // 但 copyBibResourcesToOutdir 在主文件同目录、项目根、以及递归扫描整个项目之后仍然
            // 一无所获时，不能让引用悄悄变成 [?]——插一条明确的中文 error 诊断到 parsed 数组
            // 最前面。前端"日志"面板（ovlRenderLogList）直接渲染这个数组，用户不用去猜"为什么
            // 引用是问号"。
            //
            // v2 Pass P111c 根治返修（第2轮核验 .claude/tmp/p111_verify.md §5.2 阻塞项）：上面
            // 这段话原来的判据只有"bibDiag.missing 非空"——纯静态文本扫描结果，跟这次编译到底
            // 有没有真的出现未解析引用毫无关系。\iffalse…\fi / \begin{comment}…\end{comment}
            // （comment 宏包）/ \begin{verbatim}…\end{verbatim} 这类"能骗过正则、骗不过 LaTeX
            // 排版引擎"的构造，会让一次完全健康、引用全部正确解析成 [1] 的编译也被打上同一条
            // 失实的红色 error（P111 第一次返修只剥了 % 注释，堵不住这些）。这类构造清单本质上
            // 是打不完的地鼠（\iffalse 之后还有 \if0、条件宏包开关……），根治办法是换判据：
            // 诊断该不该插，不再单独依赖静态扫描，改成看"这次编译是否真的留下了未解析引用的
            // 证据"，两个信号取并集——
            //   ① output.log 里出现 "Citation `xxx' ... undefined" 这类 LaTeX/宏包 Warning
            //      （parseLog 已把这类行归类成 level:'warning'，直接在 parsed 里找，不用重新
            //      扫一遍原始日志文本）；
            //   ② 非 draft 模式下 output.bbl 缺失或 0 字节——这正是 R2（jump 现场）诊断出的
            //      原始故障信号本身（.claude/tmp/p111_recon_jump.md）：bibtex 真的没能产出可用
            //      的参考文献列表时必然是这个状态，不会有例外。
            // 静态扫描（collectBibScanText/stripLatexLineComments，两者完整保留）降级为"证据
            // 成立之后，报错该点名哪个文件"的辅助信息源——不再是"该不该报错"本身。找到了的
            // （missing 为空）或压根没引用 .bib 的项目仍然不受影响，不会误报；三种已知构造与
            // 任何构造不明的未来"注释掉/不排版"写法被这一条规则一次性覆盖，不必逐个语法剥文本。
            const hasUndefinedCitationWarning = parsed.some((e) =>
                e.level === 'warning' && /Citation\b[\s\S]*undefined/i.test(e.message || ''));
            let bblMissingOrEmpty = false;
            if (mode !== 'draft') {
                try { bblMissingOrEmpty = fs.statSync(path.join(outdir, 'output.bbl')).size === 0; }
                catch (e) { bblMissingOrEmpty = true; } // 文件不存在，视同"空"
            }
            const hasCompileEvidenceOfUnresolvedCitations = hasUndefinedCitationWarning || bblMissingOrEmpty;

            if (mode !== 'draft' && bibDiag && bibDiag.missing && bibDiag.missing.length && hasCompileEvidenceOfUnresolvedCitations) {
                parsed.unshift({
                    level: 'error',
                    file: null,
                    line: null,
                    message: '未找到参考文献文件：' + bibDiag.missing.join('、') + '（已在主文件同目录、项目根目录、项目内全部子目录中查找，均未找到）。\\cite 引用将显示为 [?]，请确认文件名拼写，或把该文件放入项目文件夹内。'
                });
                counts.error++;
            }

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
        const mainAbs = resolveMainFileInProject(projectDir, mainFile); // v2 Pass P214 S-C
        if (!mainAbs) {
            resolve({ ok: false, error: 'mainFile 必须位于项目目录内: ' + String(mainFile) });
            return;
        }
        if (!fs.existsSync(mainAbs)) {
            resolve({ ok: false, error: 'main file not found: ' + mainAbs });
            return;
        }
        let child;
        try {
            // 实测（本机 texcount）：-sum=all 不是这个版本认识的开关（不报错但也不产出
            // "Sum count:" 那一行）——用 -inc 就够了，"合计"改成前端拿 words+headers+captions
            // 自己加，加数还是 texcount 给的真实数字，不是编的。
            // TODO(v2 Pass P60 §5.4)：这里的 cwd 恒为 projectDir，理论上跟 doCompile() 同一个
            // 根因（texcount -inc 递归 \input 时才会用到相对路径解析）。本 Pass 未复现、未在
            // 用户报告里出现，刻意不动，避免扩大改动的爆炸半径——见 .claude/tmp/p60_plan.md §1.3。
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
            // v2 Pass P214 SERVER-7：PowerShell 默认按控制台 OEM 代码页写 stdout（中文系统 CP936），
            // 而下面是按 UTF-8 解码的，含中文的文件夹路径会变成乱码、随后 existsSync 失败。显式切 UTF-8（无 BOM）。
            '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)',
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

// v2 Pass P121 —— safe.directory 所有权兼容。
//
// 背景：jump 上的桥以计划任务 SYSTEM 身份跑，但 Overleaf 项目克隆目录（本机形如
// C:/Users/xiaofanl/ai-translator-projects/VR、/CG）属主是交互式用户（CAMPUS/xiaofanl）。
// git >= 2.35.2 的 ownership 检查会让 SYSTEM 身份对这些目录的任何 git 操作报 "detected
// dubious ownership"，且 jump 侧没有管理员 ssh、icacls 改属主不可行——必须代码修。
// runGitCommand() 是本仓库全部 git 子进程唯一的 spawn 点（42 处调用全部经过这里：clone/
// pull/push/fetch/status/checkout/log/rev-parse/checkpoint 引用操作等），在这里注入
// 一处即覆盖全部，不需要逐个调用点打补丁。
//
// 取值为什么是通配符 "*" 而不是精确路径——这是实测结果，不是拍脑袋：本地建测试仓库，用
// git 官方测试开关 GIT_TEST_ASSUME_DIFFERENT_OWNER=1 模拟"外来属主"触发同一报错（先 sanity
// check 过它在本机 git 2.45.1.windows.1 上确实让裸 git status 报 dubious ownership），
// 逐一实测 safe.directory 精确路径的几种常见形态：
//   · 正斜杠形式（跟 git 报错里自己建议的那行一致，如 C:/Users/.../p121_safedir_probe）
//     —— 通过；
//   · 原生反斜杠形式（Windows 路径最自然的写法，也是 Node path.join() 在本仓库实际调用点
//     里对 projectDir/targetDir/cloneRoot 产出的形式）—— 不通过，"detected dubious
//     ownership" 原样复现；
//   · 盘符大小写不一致（c: vs C:）——不通过；
//   · 结尾多一个反斜杠/斜杠——不通过。
// 也就是说 safe.directory 精确路径匹配是逐字节字符串比较，git 内部不会先把分隔符/大小写/
// 尾斜杠规整了再比。本函数的 cwd 参数在实际调用点里来源不一（path.join() 拼出的、用户选的
// 文件夹路径、历史存档的项目路径……），Windows 上默认就是反斜杠形式，不能保证每一条都恰好是
// 唯一能匹配的"正斜杠+大小写与磁盘一致+无尾斜杠"形态——任何一处偏差就会让整条 git 链路重新
// 炸回 dubious ownership。逐一保证精确路径可靠，比直接用通配符引入的复杂度/脆弱面更大，
// 因此选 "*"。
// 安全影响：桥进程本就以完整文件系统权限直接读写这些目录（fs.readFile/writeFile 等，不经过
// git 的任何权限中介），ownership 检查挡的是"当前用户对这个目录有没有控制权"这类风险，对
// 已经手握文件系统完整权限的桥自身不构成额外的安全边界，跳过它不新增风险面。
// 注入方式：仅作为这一次 spawn 的 `-c` 参数（args 数组里，不进 shell 字符串），绝不写
// `git config --global`、绝不碰任何仓库的 .git/config——桥进程退出后这条豁免连同子进程一起
// 消失，不留任何持久化痕迹。本机桥（用户自己账号跑，属主本就一致，从不会撞见这个报错）
// 同样吃这一行 -c，因为它只是在这一次子进程的调用范围内放宽了一个不适用于本机场景的检查，
// 不改变任何实际行为、不产生任何副作用。
// 已知边界（实测过，生产无影响，详细复现方法与推理见 tools/e2e/test_p121_safedir.js 文件头
// 注释）：这个 `-c` 只作用于本函数直接 spawn 的这一个 git 进程本身，不会传给 git 自己另外
// fork 出的子 git——当"远程"是本地文件系统路径（或 file:// URL）时，git clone/fetch/push
// 会为了读写那个远程再 fork 一个独立的 git-upload-pack/git-receive-pack 子进程，这个子进程
// 既不继承外层 `-c`，也不继承其对应的 GIT_CONFIG_COUNT/KEY_n/VALUE_n 环境变量。生产环境里
// Overleaf 的远程恒为 https://git.overleaf.com/<projectId>（HTTPS 智能协议，不会为读远程
// fork 一个"打开本地仓库检查属主"的子进程），这条边界因此不成立；只有测试夹具用本地裸仓库
// 冒充远程时才会显形，测试文件里已用独立机制（GIT_CONFIG_GLOBAL 指向临时全局配置）中和。
const GIT_SAFE_DIRECTORY_ARGS = ['-c', 'safe.directory=*'];

// v2 Pass P133e —— 禁用宿主机凭据助手，把凭据来源锁定到桥自己的 GIT_ASKPASS。
//
// 背景：jump 上 Git for Windows 的系统级 gitconfig 设了 `credential.helper=manager`
// （Git Credential Manager，GCM）。桥以非交互会话身份（用户级计划任务/ssh）跑网络类 git
// 操作（clone/fetch/pull/push/ls-remote 等）时，git 的凭据子系统会先尝试调 GCM 去存取
// Windows 凭据管理器（wincredman）——这一步在非交互会话里直接致命失败：
// `fatal: Unable to persist credentials with the 'wincredman' credential store`，整条
// git 命令因此非零退出，即使实际的网络请求本身是通的（DNS/443 都正常）。GCM 这一步排在
// askpass 之前，一旦它自己先崩，本文件头部注释里说的"token 只走 GIT_ASKPASS 环境变量"这
// 条路径根本没有机会被触发——前端看到的"拉取失败：git fetch 失败"就是这个致命失败的表现，
// 不是网络问题也不是 token 本身有问题。
// 修法：在同一处（本函数 spawn 的 `-c` 参数列表）追加 `-c credential.helper=`。git 对
// credential.helper 这个多值 key 的"空字符串"有特殊语义——不是新增一条空助手，而是清空
// 在它之前所有来源（system/global/local）已经累积的助手列表；命令行 `-c` 在“遇到顺序”上
// 排在配置文件之后，因此这一条空值会把 GCM 从这次子进程的助手链里整个摘掉，凭据流程直接
// 落到 askpass（GIT_ASKPASS_HELPER + OVL_GIT_TOKEN，见 runGitCommand 里的 env），GCM
// 及其 wincredman 交互从头到尾不会被调用，也就不会再有致命崩溃挡路。
// 注入方式与上面的 safe.directory 完全同构：只作为这一次 spawn 的 `-c` 参数（args 数组
// 里，不进 shell 字符串），绝不写 `git config --global/--system`、绝不碰任何仓库的
// .git/config——桥进程退出后这条豁免连同子进程一起消失，不留任何持久化痕迹，不影响宿主机
// 上其他 git 使用者（比如用户交互式终端里的 git）继续用 GCM。
// 安全影响：清空助手列表只是让 git 不再尝试"读取/写入宿主机已保存的凭据"，桥本来就不依赖
// 宿主机保存的凭据——它自己通过 GIT_ASKPASS 精确控制每次用哪个 token（见文件头注释的整段
// token 处理原则），这里只是移除了一个会致命崩溃、且桥根本用不到的中间环节，不新增攻击面、
// 不弱化 token 本身的保密性（token 仍然只走环境变量，不落盘、不进 argv）。
// GIT_TERMINAL_PROMPT=0 已经在下面 spawn 的 env 里设置（P41 起就有，askpass 出问题时不
// 会卡在交互式终端输入等待），这里不重复设置。
const GIT_NO_CREDENTIAL_HELPER_ARGS = ['-c', 'credential.helper='];

// v2 Pass P191 —— Overleaf 远程仓库里的文件名（论文标题当文件名）经常导致克隆目标的
// 完整路径超过 Windows MAX_PATH（260 字符），即使单个路径组件本身没超 NTFS 的 255 字节
// 上限，git for Windows 也会报 "Filename too long" 直接失败（诊断见
// .claude/tmp/p191_clone_longpath_diag.md：三条实测失败路径分别 268/336/307 字符，最长
// 单组件仅 84/118/105 字节，本机三级 git config 均未设置 core.longpaths）。
// 修法：给这次 spawn 加 `-c core.longpaths=true`，让 Git for Windows 内部用 `\\?\` 前缀
// 绕开整体路径长度上限（只要求单组件 ≤255 字节，本例三条都满足）。放在 runGitCommand()
// 里意味着 clone/pull/push/status 等所有调用点统一受益，不需要逐个路由各改一次——克隆
// 成功后如果远程又加了新的超长文件名，后续 pull 会复现同一个坑，这里一次性堵上。
// 注入方式与上面两个 `-c` 完全同构：只作为这一次 spawn 的参数（args 数组里，不进 shell
// 字符串），绝不写 `git config --global/--system`；对短路径场景零副作用，只是放宽了 git
// 自己对超长路径的内部限制。持久化到具体仓库（供用户之后手敲 git 用）由
// doOverleafClone() 在克隆成功后单独调用 `git config core.longpaths true` 完成，见那里
// 的注释。
const GIT_LONGPATHS_ARGS = ['-c', 'core.longpaths=true'];

// 仅供 e2e 测试使用（tools/e2e/test_p121_safedir.js）：设置环境变量 OVL_TEST_GIT_ARGV_LOG
// 为一个文件路径时，每次 spawn 前把最终 argv（含上面注入的 safe.directory）追加写一行 JSON
// 到该文件——用于断言"确实注入了"，而不是仅凭链路跑通就推测注入生效。不设置该环境变量时
// （生产/常规使用）这段代码完全不执行，对真实桥零影响、零开销。
function logGitArgvForTest(finalArgs) {
    const logPath = process.env.OVL_TEST_GIT_ARGV_LOG;
    if (!logPath) return;
    try { fs.appendFileSync(logPath, JSON.stringify(finalArgs) + '\n'); } catch (e) { /* 测试探针写失败不该影响真实 git 调用 */ }
}

// 跑一条 git 命令，token 只走环境变量（GIT_ASKPASS），绝不拼进 args/URL——见文件头注释。
// 不抛异常：spawn 失败、超时、非零退出码统统汇总成 {ok, code, stdout, stderr, timedOut} 返回。
// timeoutMs 可选：不传时保持原来的 OVERLEAF_GIT_TIMEOUT_MS（pull/push 现有行为完全不变），
// clone 一个带图片的论文仓库可能远超 30 秒，调用方会显式传一个更长的值。
// extraEnv 可选（v2 Pass P41 新增，全部既有调用点都不传，行为完全不变）：额外合并进子进程
// 环境变量的 {KEY: value} 对象，用于 fsGitCheckpoint()/doFsRestore() 借 GIT_INDEX_FILE 等
// 变量把 git 操作限制在一个临时索引/工作树上，绝不触碰真实的 .git/index。
function runGitCommand(args, cwd, token, timeoutMs, extraEnv) {
    return new Promise((resolve) => {
        const finalArgs = GIT_SAFE_DIRECTORY_ARGS.concat(GIT_NO_CREDENTIAL_HELPER_ARGS, GIT_LONGPATHS_ARGS, args);
        logGitArgvForTest(finalArgs);
        let child;
        try {
            child = spawn('git', finalArgs, {
                cwd: cwd,
                windowsHide: true,
                env: Object.assign({}, process.env, {
                    GIT_ASKPASS: GIT_ASKPASS_HELPER,
                    OVL_GIT_TOKEN: token || '',
                    OVL_GIT_USERNAME: 'git', // v2 Pass P133f：Overleaf 要求 Basic 认证用户名固定为字面量 'git'（密码=token）；
                                              // 常量注入，不开新配置项——见 git-askpass-helper.js 头部注释的完整背景
                    GIT_TERMINAL_PROMPT: '0' // askpass 出问题时不许卡在交互式输入等待上
                }, extraEnv || {})
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
        }, timeoutMs || OVERLEAF_GIT_TIMEOUT_MS);
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
    // 剥掉 URL 里的 userinfo 段（user:pass@ 或 user@）——只影响"是不是同一个仓库"这一步比较，
    // 绝不改写任何落盘的 remote URL（ensureOriginRemote 仍然绝不自动 set-url，那是 P24 特意
    // 加的保护，这里不碰）。origin 从别的机器搬过来、或者当初是用
    // `git clone https://git@git.overleaf.com/<id>` 这种带用户名的地址克隆的，都会导致"同一个
    // 仓库"的两个 URL 只差这一段——不剥掉就会被误判成 origin-mismatch，挡住正常的拉取。
    s = s.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, '$1');
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

// v2 Pass P66：只读反查某目录当前 origin 指向哪——前端拿不到 .git/config（/fs/read 明确
// 拒绝 .git/ 内部路径，见 safeFsPath），需要一个语义受限的只读端点顶上，给前端一个权威判据：
// "这个本地目录到底是哪个 Overleaf 项目"，用来在切换项目目录时反向同步 UI 上显示的项目 ID，
// 从根上避免 P66 那种「目录是 A、发出去的 gitUrl 却还是上一个项目 B」的错配。
// 只执行 `git remote get-url origin`，不 add/set-url/fetch，不写任何东西；不是 git 仓库/没有
// origin 都不当错误处理，如实回报 hasOrigin:false，让前端自己决定怎么降级。
// 返回前必须剥掉 userinfo（跟 ensureOriginRemote 报错文案用的是同一条正则）——手动
// `git clone https://user:token@git.overleaf.com/<id>` 出来的目录，origin 里会带凭据；
// 这条 URL 一律不写日志。
async function doOverleafOrigin(projectDir) {
    try {
        const gitDir = path.join(projectDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }
        if (!hasGitDir) return { ok: true, hasOrigin: false, originUrl: null };
        const urlResult = await runGitCommand(['remote', 'get-url', 'origin'], projectDir, null);
        if (!urlResult.ok) return { ok: true, hasOrigin: false, originUrl: null };
        const raw = (urlResult.stdout || '').trim();
        if (!raw) return { ok: true, hasOrigin: false, originUrl: null };
        // 剥 userinfo：本端点不持有 token（调用方没传，也不需要传——get-url 是纯本地读操作），
        // 所以这里没有 redactToken() 可用的 token 值；userinfo 剥离已经覆盖了"URL 里带凭据"
        // 这唯一的泄露面。
        const stripped = raw.replace(/^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^@/]*@/, '$1');
        return { ok: true, hasOrigin: true, originUrl: stripped };
    } catch (e) {
        return { ok: true, hasOrigin: false, originUrl: null };
    }
}

// v2 Pass P67：顶栏项目名双击改名——用户明确选定的语义是"真的重命名磁盘上的项目文件夹"，
// 不是只改一个显示名。前端已经做过一轮校验，但这里必须独立再校验一遍（前端校验不算数，
// 见下方 ovlValidateRenameName），并且只允许改成同级兄弟目录（新路径 = path.join(该目录的
// 父目录, newName)），不接受任意目标路径——防止这个端点被当成一个"移动到任意地方"的后门。
const OVL_RESERVED_DEVICE_NAME_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const OVL_FORBIDDEN_NAME_CHARS_RE = /[<>:"/\\|?*]/;
function ovlValidateRenameName(newName) {
    if (typeof newName !== 'string') return '新名称不能为空';
    const trimmed = newName.trim();
    if (!trimmed) return '新名称不能为空';
    if (trimmed.length > 255) return '新名称过长（最多 255 个字符）';
    if (OVL_FORBIDDEN_NAME_CHARS_RE.test(trimmed)) return '新名称不能包含 < > : " / \\ | ? * 这些字符';
    if (trimmed.indexOf('..') !== -1) return '新名称不能包含连续两个英文句点 ".."';
    if (/[ .]$/.test(trimmed)) return '新名称不能以空格或英文句点结尾';
    if (OVL_RESERVED_DEVICE_NAME_RE.test(trimmed)) return '新名称不能是 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）';
    // 纯 basename 校验：含任何路径分隔符或 ".." 一律拒绝——path.basename 在遇到分隔符时会
    // 把它们之前的部分都截掉，跟原始字符串不相等就说明带了路径结构，不是单纯的文件夹名。
    if (path.basename(trimmed) !== trimmed) return '新名称不能包含路径分隔符';
    return null; // 合法
}

async function doOverleafRenameProject(projectDir, newName) {
    try {
        if (!projectDir || typeof projectDir !== 'string') return { ok: false, error: 'projectDir is required (绝对路径)' };
        const invalidReason = ovlValidateRenameName(newName);
        if (invalidReason) return { ok: false, error: invalidReason };
        const trimmedName = newName.trim();

        // 正在编译时改名会把 latexmk 的 cwd 从脚下拽走，必须拒绝（跟 clone/pull 时的
        // "先杀掉正在跑的旧编译"是完全不同的场景——那是我们自己主动结束旧进程，这里是
        // 用户的编译还在正常进行，不能替他打断）。
        if (currentChild) {
            return { ok: false, error: '当前有编译正在进行，改名可能打断编译进程的工作目录，请等编译结束后再改名' };
        }

        let srcStat;
        try { srcStat = fs.statSync(projectDir); } catch (e) { return { ok: false, error: '源目录不存在' }; }
        if (!srcStat.isDirectory()) return { ok: false, error: '源路径不是一个目录' };

        const parentDir = path.dirname(projectDir);
        if (!parentDir || parentDir === projectDir) {
            return { ok: false, error: '该目录没有父目录（已经是磁盘根目录），无法重命名' };
        }

        const newPath = path.join(parentDir, trimmedName);
        if (newPath !== projectDir) {
            let destExists = false;
            try { fs.statSync(newPath); destExists = true; } catch (e) { destExists = false; }
            if (destExists) return { ok: false, error: '目标名称已存在，请换一个名字' };
        }

        try {
            await fs.promises.rename(projectDir, newPath);
        } catch (e) {
            if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES')) {
                return { ok: false, error: '目录正被占用（可能有文件被其他程序打开，或 OneDrive 正在同步），请稍后再试' };
            }
            return { ok: false, error: '重命名失败：' + (e && e.message ? e.message : String(e)) };
        }
        return { ok: true, newPath: newPath };
    } catch (e) {
        return { ok: false, error: '重命名失败：' + (e && e.message ? e.message : String(e)) };
    }
}

// 解析 `git status --porcelain`（v1 格式）的一行为 {status, path}——status 是原始两字符
// code（保留原样，含空格，例如 " M"/"M "/"??"/"UU"），path 从第 4 个字符开始到行尾（重命名
// 的情况下是 "旧路径 -> 新路径" 整段原样带出，不单独拆分，前端只是展示用，不解析这段）。
// pull 的 dirty 检查（-uno）和 stash-pop 冲突之后的现场检查都靠它，避免各自重复写一遍解析。
function parseGitStatusPorcelain(stdout) {
    return stdout.split(/\r?\n/)
        .filter((line) => line.length > 3)
        .map((line) => ({ status: line.slice(0, 2), path: line.slice(3) }));
}

// 冲突状态判定：两字符里只要出现 'U'（未合并）就是冲突；'AA'（双方都新增同名文件）、
// 'DD'（双方都删除）这两种不含 'U' 的组合也算冲突。用于 stash pop 冲突后过滤 conflictFiles。
function isConflictStatus(status) {
    return status.indexOf('U') !== -1 || status === 'AA' || status === 'DD';
}

// stash pop 冲突后用来判断这条 stash 记录是否还在——git 在 apply 冲突时按设计不会自动
// drop stash（保留在 stash list 里"以防万一"），但这里不假设，实测一遍给用户一个确定的
// 答案。查询失败（几乎不会）时返回 null，调用方保守地当作"还没 drop"。
async function stashStillPresent(projectDir, token, message) {
    const listResult = await runGitCommand(['stash', 'list'], projectDir, token);
    if (!listResult.ok) return null;
    return listResult.stdout.indexOf(message) !== -1;
}

const OVERLEAF_STASH_MESSAGE = 'AI-Translator 自动暂存';

// POST /overleaf/pull —— 见文件头安全设计注释 + 交付说明里的分支逻辑表。
// v2 Pass P27：strategy 参数（'abort' | 'stash' | 'discard'，缺省 'abort'，白名单校验，
// 非法值直接 ok:false）决定遇到"本地有已跟踪文件改动"时怎么办：
//   - abort（默认，向后兼容旧行为）：不动手，原样把改动文件清单报给前端，交给用户在弹窗里选。
//   - stash：先 `git stash push --no-include-untracked` 把已跟踪文件的改动存起来，拉完再
//     `git stash pop` 恢复；pop 冲突就保持仓库在冲突状态，不自动回滚、不自动二选一。
//   - discard：`git checkout -- .` 丢弃已跟踪文件的改动（不可逆，前端要求走过二次确认才会
//     带这个 strategy 进来），然后正常拉取。
// dirty 判定统一用 `git status --porcelain -uno`，只看已跟踪文件——未跟踪文件不可能被 pull
// 覆盖（唯一例外是远程新增同名文件，那种情况 git 自己会在 merge/checkout 时报错拒绝，不需要
// 在这里提前挡），旧版裸 --porcelain 把未跟踪文件也算成"脏"是这一轮要修的根因 bug。
// countUntrackedFiles() 单独用不带 -uno 的 --porcelain 去数 ?? 开头的未跟踪文件，两件事分开
// 做，任何 strategy 都绝不碰未跟踪文件一根汗毛（不 stash、不 discard、更不会 clean/删除）。
// v2 Pass P214 SERVER-10：同一个项目目录上的 Overleaf pull / push / fs restore 串行，
// 避免 stash push/pop、add -u/commit 与 merge 互相交错（index.lock 报错、stash 被别的请求弹走）。
const projectOpTails = new Map();
function withProjectLock(projectDir, fn) {
    let key = String(projectDir);
    try { key = path.resolve(key); } catch (e) {}
    if (process.platform === 'win32') key = key.toLowerCase();
    const prev = projectOpTails.get(key) || Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(() => {}, () => {});
    projectOpTails.set(key, tail);
    tail.then(() => { if (projectOpTails.get(key) === tail) projectOpTails.delete(key); });
    return run;
}
function doOverleafPull(projectDir, gitUrl, token, strategy) {
    return withProjectLock(projectDir, () => doOverleafPullImpl(projectDir, gitUrl, token, strategy));
}
async function doOverleafPullImpl(projectDir, gitUrl, token, strategy) {
    if (strategy === undefined || strategy === null || strategy === '') strategy = 'abort';
    if (['abort', 'stash', 'discard'].indexOf(strategy) === -1) {
        return { ok: false, error: '非法的 strategy 参数: ' + strategy + '（只接受 abort/stash/discard）' };
    }
    try {
        const gitDir = path.join(projectDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }

        if (!hasGitDir) {
            // v2 Pass P55（Bug 1 修复）：以前这里发现目标目录不存在/不是 git 仓库时，会自己
            // mkdir 再 git clone——「拉取」和「克隆」被悄悄合并成了一个动作。后果是：只要前端
            // 传进来的 projectDir 是一个过期路径（比如用户把项目挪到了别处，输入框/localStorage
            // 里还留着旧路径没同步），点一下"拉取"就会在那个过期路径上凭空造出一个新项目目录，
            // 这正是用户报告的"点击拉取会在原本的位置克隆一个项目文件夹出来"。
            // 现在拉取绝不新建目录、绝不 clone——目录不存在就是不存在，明确报错交回给用户去
            // 核对/重选项目路径；克隆只应该由专门的"克隆"按钮（doOverleafClone，见下文/前端
            // ovlOverleafClone 相关代码）触发，那条路径本来就要求用户走一次"存放位置"弹窗确认，
            // 不会有过期路径静默生效的问题。
            let dirExists = false;
            try { dirExists = fs.existsSync(projectDir); } catch (e) {}
            if (!dirExists) {
                return {
                    ok: false,
                    action: 'dir-not-found',
                    error: '目标路径不存在：' + projectDir + '。拉取不会自动创建目录或克隆新项目——如果项目已经被移动或删除，请重新打开正确的项目文件夹后再拉取；需要克隆全新项目请使用"克隆"功能。'
                };
            }
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
            // 目录存在但是空的：同样不隐式 clone——「拉取」不应该在任何情况下悄悄变成「克隆」，
            // 克隆只应该由用户主动点"克隆"按钮触发（该按钮会弹"存放位置"确认弹窗，见 P53）。
            // 空目录多半也是同一类过期/误传路径的产物，报错比凭空造一个项目更安全。
            return {
                ok: false,
                action: 'refused-empty-dir-not-repo',
                error: '目标目录存在但不是 git 仓库（是空目录）：' + projectDir + '。拉取不会自动 clone——如果想在这个目录克隆项目，请使用"克隆"功能；如果这是一个过期路径，请重新打开正确的项目文件夹。'
            };
        }

        // 已经是 git 仓库：dirty 检查必须先于任何网络操作。只看已跟踪文件（-uno）。
        const statusResult = await runGitCommand(['status', '--porcelain', '-uno'], projectDir, token);
        if (!statusResult.ok) {
            return { ok: false, action: 'status-failed', error: redactToken(statusResult.stderr || statusResult.stdout || 'git status 失败', token) };
        }
        const dirtyFiles = parseGitStatusPorcelain(statusResult.stdout);
        const isDirty = dirtyFiles.length > 0;

        if (isDirty && strategy === 'abort') {
            return {
                ok: true,
                action: 'skipped-dirty',
                dirtyFiles: dirtyFiles,
                error: '本地有未提交的改动，跳过本次同步（不会自动覆盖），建议先点“推送”或手动处理后再拉取。'
            };
        }

        let stashPushed = false;
        if (isDirty && strategy === 'stash') {
            const stashResult = await runGitCommand(
                ['stash', 'push', '--no-include-untracked', '-m', OVERLEAF_STASH_MESSAGE],
                projectDir, token
            );
            if (!stashResult.ok) {
                return { ok: false, action: 'stash-failed', error: redactToken(stashResult.stderr || stashResult.stdout || 'git stash push 失败', token) };
            }
            stashPushed = true;
        }

        let discardedFiles = [];
        let discardCp = { available: null, checkpoint: null, warning: null };
        if (isDirty && strategy === 'discard') {
            // v2 Pass P45：真正丢弃之前先打一个旁路快照（不动分支/索引/工作区，见
            // fsGitCheckpoint 头部注释）——用户反馈"丢弃"点起来太吓人，给一条回退保障。
            // 打快照失败不阻断丢弃本身（那是既有的"丢弃"功能，不能因为新增的保障机制本身
            // 出故障就连累主流程），只是响应里 checkpointAvailable 会如实为 false。
            discardCp = await fsGitCheckpoint(projectDir, 'overleaf pull discard');
            // v2 Pass P214 SERVER-2：没有成功生成回退检查点（git add 超时 / 自检失败 / 不是工作树）时，
            // 绝不执行 git checkout -- .——否则未提交的已跟踪改动无任何恢复途径。客户端对 ok:false 的
            // 拉取结果会原样 toast「拉取失败：<error>」。
            if (!discardCp.checkpoint) {
                return Object.assign({
                    ok: false, action: 'discard-no-checkpoint',
                    error: '无法在丢弃前创建回退检查点' + (discardCp.warning ? '（' + discardCp.warning + '）' : '') +
                        '，为避免本地改动永久丢失，已取消「丢弃本地改动」，本地文件原样保留。请先手动提交或备份，或改用「暂存」后再拉取。'
                }, checkpointFields(discardCp));
            }
            // 只丢弃已跟踪文件的改动——绝不用 git clean，一个未跟踪文件都不许删。
            const discardResult = await runGitCommand(['checkout', '--', '.'], projectDir, token);
            if (!discardResult.ok) {
                return Object.assign(
                    { ok: false, action: 'discard-failed', error: redactToken(discardResult.stderr || discardResult.stdout || 'git checkout -- . 失败', token) },
                    checkpointFields(discardCp)
                );
            }
            discardedFiles = dirtyFiles;
        }

        // stash 分支专用：往下任何一步失败都要先把 stash pop 回来再报错，兑现前端弹窗里
        // "拉取完成后自动恢复，不会丢失"的承诺——不能让用户的改动只是因为比如 fetch 超时
        // 就悄无声息地扔在 stash 里（对 strategy !== 'stash' 是安全的空操作）。
        async function bailOut(result) {
            if (stashPushed) {
                // 这里不检查 pop 是否成功——工作区此时应该跟 stash push 之前完全一致（还没有
                // 任何 fetch/merge 动过工作区），正常不会冲突；万一意外冲突，用户至少能在
                // `git stash list` 里把改动找回来，不算真的丢失，也不在这个失败路径上二次报告。
                await runGitCommand(['stash', 'pop'], projectDir, token);
            }
            return result;
        }

        const remoteResult = await ensureOriginRemote(projectDir, gitUrl, token);
        if (!remoteResult.ok) {
            return await bailOut({ ok: false, action: remoteResult.action || 'remote-failed', error: redactToken(remoteResult.error, token) });
        }

        const fetchResult = await runGitCommand(['fetch', 'origin'], projectDir, token);
        if (!fetchResult.ok) {
            return await bailOut({ ok: false, action: 'fetch-failed', error: redactToken(fetchResult.stderr || fetchResult.stdout || 'git fetch 失败', token) });
        }

        const branchResult = await runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD'], projectDir, token);
        if (!branchResult.ok) {
            return await bailOut({ ok: false, action: 'branch-failed', error: redactToken(branchResult.stderr || 'git rev-parse 获取当前分支名失败', token) });
        }
        const branch = branchResult.stdout.trim();

        const oldHeadResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, token);
        const oldHead = oldHeadResult.ok ? oldHeadResult.stdout.trim() : null;

        const mergeResult = await runGitCommand(['merge', '--ff-only', 'origin/' + branch], projectDir, token);
        if (!mergeResult.ok) {
            // 非快进（本地和远程各自有新提交）或 origin/<branch> 压根不存在（比如远程默认分支
            // 是 master，本地却在别的分支上）——两种情况都不尝试自动合并/rebase/瞎猜分支名重试，
            // 统一归类为"分叉"，原样报告给用户自己判断。
            return await bailOut({
                ok: true,
                action: 'diverged',
                error: '本地和 Overleaf 上的版本出现分叉，无法自动合并，请手动处理（打开终端 cd 到项目目录执行 git status / git log 检查，必要时手动 git merge 或 git reset）。如果 Overleaf 上的默认分支名和本地当前分支（' + branch + '）不一致，也会出现这个提示，请手动确认分支名。'
            });
        }

        const newHeadResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, token);
        const newHead = newHeadResult.ok ? newHeadResult.stdout.trim() : null;
        const upToDate = !!(oldHead && newHead && oldHead === newHead);

        let changedFiles = [];
        if (!upToDate && oldHead && newHead) {
            const diffResult = await runGitCommand(['diff', '--name-only', oldHead, newHead], projectDir, token);
            if (diffResult.ok) {
                changedFiles = diffResult.stdout.split(/\r?\n/).filter((s) => s.length > 0);
            }
        }

        if (strategy === 'discard' && isDirty) {
            const untrackedCount = await countUntrackedFiles(projectDir, token);
            return Object.assign(
                { ok: true, action: 'pulled-with-discard', discardedFiles: discardedFiles, changedFiles: changedFiles, untrackedCount: untrackedCount },
                checkpointFields(discardCp)
            );
        }

        if (stashPushed) {
            const popResult = await runGitCommand(['stash', 'pop'], projectDir, token);
            const untrackedCount = await countUntrackedFiles(projectDir, token);
            if (popResult.ok) {
                return { ok: true, action: 'pulled-with-stash', changedFiles: changedFiles, untrackedCount: untrackedCount };
            }
            // pop 冲突：保持仓库在冲突状态，不自动回滚、不自动二选一——这是 P28（AI 协助合并）
            // 的入口。
            const conflictStatusResult = await runGitCommand(['status', '--porcelain', '-uno'], projectDir, token);
            const conflictFiles = conflictStatusResult.ok
                ? parseGitStatusPorcelain(conflictStatusResult.stdout).filter((f) => isConflictStatus(f.status))
                : [];
            const stillPresent = await stashStillPresent(projectDir, token, OVERLEAF_STASH_MESSAGE);
            return {
                ok: true,
                action: 'stash-pop-conflict',
                conflictFiles: conflictFiles,
                stashDropped: stillPresent === false,
                error: '暂存的改动在恢复时和拉取下来的新内容冲突，仓库现在处于冲突状态，需要手动解决（查看 git status，编辑冲突文件后 git add，再自行决定 git stash drop 或保留）。'
            };
        }

        const untrackedCount = await countUntrackedFiles(projectDir, token);
        return { ok: true, action: upToDate ? 'up-to-date' : 'fast-forward', changedFiles: changedFiles, untrackedCount: untrackedCount };
    } catch (e) {
        return { ok: false, error: redactToken('内部错误: ' + (e && e.message), token) };
    }
}

// POST /overleaf/push —— 见文件头安全设计注释。绝不 force push：非快进被拒绝时提交本身
// 已经落在本地历史里（不回滚），只是没推上去，安全、不丢用户的本地工作。
// push 前数一下工作区里还有多少未跟踪文件（?? 开头）——只用于告知，不影响任何行为。
// 失败就当 0（这只是个提示性数字，不能因为它查询失败就搞坏整个 push 的返回）。
// v2 Pass P27 审计结论：这里特意不加 -uno——这个函数存在的唯一目的就是数 ?? 开头的未跟踪
// 文件，跟 doOverleafPull 里 dirty 判定用 -uno（只看已跟踪文件）是两件相反的事，不要改成
// 一样。push 本身也没有另一处用 --porcelain 当"脏"的判断闸门：它靠 `git add -u`（本来就只碰
// 已跟踪文件，不会动未跟踪文件）之后 `git diff --cached --name-only` 是否为空来决定有没有
// 东西要提交，跟这里的 --porcelain 查询完全独立，不受这个函数改动影响。
async function countUntrackedFiles(projectDir, token) {
    const statusResult = await runGitCommand(['status', '--porcelain'], projectDir, token);
    if (!statusResult.ok) return 0;
    return statusResult.stdout.split(/\r?\n/).filter((line) => line.indexOf('??') === 0).length;
}

function doOverleafPush(projectDir, gitUrl, token, message) {
    return withProjectLock(projectDir, () => doOverleafPushImpl(projectDir, gitUrl, token, message));
}
async function doOverleafPushImpl(projectDir, gitUrl, token, message) {
    try {
        const gitDir = path.join(projectDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }
        if (!hasGitDir) {
            return { ok: false, error: '这个目录还不是 git 仓库，请先拉取一次' };
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

        // 在任何 add/commit 之前先查是否落后于远程——落后就立刻拒绝，绝不先 commit 再让 push
        // 失败。origin/<branch> 不存在（远程还没有这个分支，比如首次推送新分支）时 rev-list
        // 会失败，这不算"落后"，按 behind=0 正常往下走。
        const fetchResult = await runGitCommand(['fetch', 'origin'], projectDir, token);
        if (!fetchResult.ok) {
            return { ok: false, action: 'fetch-failed', error: redactToken(fetchResult.stderr || fetchResult.stdout || 'git fetch 失败', token) };
        }

        const behindResult = await runGitCommand(['rev-list', '--count', 'HEAD..origin/' + branch], projectDir, token);
        if (behindResult.ok) {
            const behind = parseInt(behindResult.stdout.trim(), 10) || 0;
            if (behind > 0) {
                return {
                    ok: true,
                    action: 'behind-remote',
                    behind: behind,
                    error: 'Overleaf 上有 ' + behind + ' 个你本地还没有的更新，为避免产生分叉，已中止推送。请先点「拉取」同步之后再推送。'
                };
            }
        }
        // behindResult 失败（多半是 origin/<branch> 不存在）——不算落后，继续往下走。

        // 只暂存已被 git 跟踪的文件的修改/删除，绝不把本地新增的未跟踪文件（drawio 源文件、
        // 预览图、构建产物……）扫进去——Overleaf 项目里该有什么文件由用户在 Overleaf 上决定，
        // 本工具只负责同步"Overleaf 已经知道的那些文件"的本地修改。见本轮头部注释。
        const addResult = await runGitCommand(['add', '-u'], projectDir, token);
        if (!addResult.ok) {
            return { ok: false, error: redactToken(addResult.stderr || addResult.stdout || 'git add 失败', token) };
        }

        const stagedResult = await runGitCommand(['diff', '--cached', '--name-only'], projectDir, token);
        if (!stagedResult.ok) {
            return { ok: false, error: redactToken(stagedResult.stderr || stagedResult.stdout || 'git diff --cached 失败', token) };
        }
        if (stagedResult.stdout.trim().length === 0) {
            const untrackedCount = await countUntrackedFiles(projectDir, token);
            return { ok: true, action: 'nothing-to-push', untrackedCount: untrackedCount }; // 没有改动，不做空提交
        }

        const commitMessage = (message && String(message).trim()) || ('AI-Translator sync ' + new Date().toISOString());
        const commitResult = await runGitCommand(['commit', '-m', commitMessage], projectDir, token);
        if (!commitResult.ok) {
            return { ok: false, error: redactToken(commitResult.stderr || commitResult.stdout || 'git commit 失败', token) };
        }

        const pushResult = await runGitCommand(['push', 'origin', branch], projectDir, token);
        if (!pushResult.ok) {
            const combined = (pushResult.stderr || '') + '\n' + (pushResult.stdout || '');
            if (/non-fast-forward|fetch first|rejected/i.test(combined)) {
                // fetch 之后、push 之前远程又有新提交的竞态——最后一道保险，仍然保留。
                return {
                    ok: true,
                    action: 'rejected-non-fastforward',
                    error: '推送被拒绝：Overleaf 上有你本地还没有的新修改，请先点“拉取”同步之后再推送。'
                };
            }
            return { ok: false, error: redactToken(combined, token) };
        }

        const untrackedCount = await countUntrackedFiles(projectDir, token);
        return { ok: true, action: 'pushed', untrackedCount: untrackedCount };
    } catch (e) {
        return { ok: false, error: redactToken('内部错误: ' + (e && e.message), token) };
    }
}

// v2 Pass P24（追加）：POST /overleaf/clone —— 首次从 Overleaf 整体拉一个新项目下来。
// 目标目录 180 秒超时（clone 一个带图片的论文仓库可能远超 pull 的 30 秒）。
const OVERLEAF_CLONE_TIMEOUT_MS = 180000;

// 在 text 里找第一处 "\cmdName{...}"，花括号手动配对（支持嵌套，不用贪婪正则），
// 返回花括号内部的原文；找不到或花括号不闭合就返回 null。供 extractSuggestedProjectName
// 提取 \title{...} 用。
function extractBracedArg(text, cmdName) {
    const marker = '\\' + cmdName;
    const idx = text.indexOf(marker);
    if (idx === -1) return null;
    let i = idx + marker.length;
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] !== '{') return null;
    let depth = 0, start = -1, end = -1;
    for (let j = i; j < text.length; j++) {
        const ch = text[j];
        if (ch === '{') { depth++; if (depth === 1) start = j + 1; }
        else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (start === -1 || end === -1) return null;
    return text.slice(start, end);
}

// 清洗标题用：找出 text 里所有 "\cmdName{...}"（同样手动配对花括号），keepInner=true 时
// 替换成花括号内部的文字（\textbf{...} 之类"命令壳"只留文字），keepInner=false 时整体删掉
// （\thanks{...} 这种脚注不该出现在标题里）。花括号不闭合就放弃剩余部分的清洗、原样拼回去，
// 不死循环、不丢内容。
function stripBracedCommand(text, cmdName, keepInner) {
    const marker = '\\' + cmdName + '{';
    let result = '';
    let i = 0;
    while (i < text.length) {
        const idx = text.indexOf(marker, i);
        if (idx === -1) { result += text.slice(i); break; }
        result += text.slice(i, idx);
        let depth = 0, start = -1, end = -1;
        for (let j = idx + marker.length - 1; j < text.length; j++) {
            const ch = text[j];
            if (ch === '{') { depth++; if (depth === 1) start = j + 1; }
            else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (start === -1 || end === -1) { result += text.slice(idx); break; }
        if (keepInner) result += text.slice(start, end);
        i = end + 1;
    }
    return result;
}

// clone 成功后尽力从项目里挑一个可读名字，纯锦上添花：任何一步失败都吞掉异常返回 null，
// 绝不能让这一步拖垮整个 clone（见路由处的分支 4-6）。顶层找 main.tex，没有就取第一个
// .tex 文件（不递归，只看顶层）；读 \title{...}（花括号手动配对，支持嵌套）；清洗掉
// \thanks{...}、\\、\textbf{} 之类命令壳；压缩空白；截断到 60 字符。
function extractSuggestedProjectName(targetDir) {
    try {
        let entries = [];
        try { entries = fs.readdirSync(targetDir); } catch (e) { return null; }
        const texFiles = entries.filter((name) => /\.tex$/i.test(name)).filter((name) => {
            try { return fs.statSync(path.join(targetDir, name)).isFile(); } catch (e) { return false; }
        });
        let texFile = null;
        if (texFiles.indexOf('main.tex') !== -1) texFile = 'main.tex';
        else if (texFiles.length > 0) texFile = texFiles[0];
        if (!texFile) return null;

        let content;
        try { content = fs.readFileSync(path.join(targetDir, texFile), 'utf8'); } catch (e) { return null; }

        let title = extractBracedArg(content, 'title');
        if (title === null) return null;

        title = stripBracedCommand(title, 'thanks', false);
        title = title.replace(/\\\\/g, ' ');
        ['textbf', 'textit', 'textrm', 'texttt', 'emph', 'text', 'mathrm'].forEach((cmd) => {
            title = stripBracedCommand(title, cmd, true);
        });
        title = title.replace(/\s+/g, ' ').trim();
        if (!title) return null;
        if (title.length > 60) title = title.slice(0, 60);
        return title;
    } catch (e) {
        return null;
    }
}

// POST /overleaf/clone —— 首次从 Overleaf 整体拉一个新项目下来建本地副本。目标目录不接受
// 调用方指定（故意的，见路由处校验注释），完全由服务端按 projectId 算出，避免任意页面借
// 这个接口让桥往任意路径写文件；凭据同 pull/push，走 GIT_ASKPASS + OVL_GIT_TOKEN，URL 里
// 绝不带 token。
//
// OVL_TEST_CLONE_ROOT / OVL_TEST_GIT_BASE 两个环境变量仅供 e2e 测试使用：分别让测试把 clone
// 目标根目录、Overleaf git 服务地址重定向到临时目录 / file:// 假仓库，避免测试写进真实的
// %LOCALAPPDATA%\AI-Translator。能设环境变量的人本来就能直接改代码，这不构成新的攻击面。
//
// v2 Pass P53：parentDir/folderName 是新增的可选显式目标位置——用户在前端弹窗里选的"存放
// 位置"+"文件夹名"。两者都不传（或传空）时完全退回上面这条旧默认路径，向后兼容旧调用方/
// 既有测试。传了就必须是绝对路径（不接受相对路径，避免意外相对于服务端 cwd 解析）。
function defaultOverleafCloneRoot() {
    return process.env.OVL_TEST_CLONE_ROOT
        || (process.platform === 'win32' && process.env.LOCALAPPDATA
              ? path.join(process.env.LOCALAPPDATA, 'AI-Translator', 'overleaf')
              : path.join(os.homedir(), '.ai-translator', 'overleaf'));
}

function computeOverleafCloneTargetDir(projectId, parentDir, folderName) {
    const cloneRoot = defaultOverleafCloneRoot();
    if (parentDir && folderName) {
        if (!path.isAbsolute(parentDir)) {
            return { ok: false, error: '存放位置必须是绝对路径: ' + parentDir };
        }
        // v2 Pass P80 W2（server-endpoints confirmed med）：folderName 来自前端"存放位置"弹窗
        // 里用户手填的自由文本框（AI-Translator.html 里 folderInput.value.trim()），原来这里
        // 没有任何 basename/".." 校验——对照 /overleaf/rename-project 对 newName 的双重校验
        // （ovlValidateRenameName + 路由层再查一遍，注释明确写着是为了防止端点被当成"移动到
        // 任意地方"的后门），clone 这条同样会真实 mkdir+git clone 写盘的路径原来完全没有同款
        // 防护。这里复用同一份 ovlValidateRenameName，folderName 必须是不含路径分隔符/".."的
        // 纯目录名，跟 rename-project 对齐。doOverleafCheckTarget 是纯只读预检（不落盘，函数
        // 注释已明确说明），不在本次改动范围——真正的写操作只有这里（被 doOverleafClone 调用），
        // 校验在这个唯一收口点做，checkTarget 预检结果的准确性留给后续 Pass 再补，不影响本次
        // 修复要堵的安全缺口（拒绝后 doOverleafClone 会把 ok:false/error 原样透传给前端，前端
        // 已有的 `if (!data || !data.ok)` 分支会正常展示"克隆失败：..."提示，不需要额外改前端）。
        const nameErr = ovlValidateRenameName(folderName);
        if (nameErr) return { ok: false, error: '存放文件夹名: ' + nameErr };
        return { ok: true, targetDir: path.join(path.resolve(parentDir), folderName) };
    }
    return { ok: true, targetDir: path.join(cloneRoot, projectId) };
}

async function doOverleafClone(projectId, token, parentDir, folderName) {
    const targetResult = computeOverleafCloneTargetDir(projectId, parentDir, folderName);
    if (!targetResult.ok) return { ok: false, error: targetResult.error };
    const targetDir = targetResult.targetDir;
    const cloneRoot = path.dirname(targetDir);
    const gitBase = process.env.OVL_TEST_GIT_BASE || 'https://git.overleaf.com';
    const gitUrl = gitBase.replace(/\/+$/, '') + '/' + projectId;

    try {
        let dirExists = false;
        try { dirExists = fs.existsSync(targetDir); } catch (e) { dirExists = false; }

        let entries = null;
        if (dirExists) {
            try {
                entries = fs.readdirSync(targetDir);
            } catch (e) {
                // 存在但读不了（比如其实是个文件、或权限问题）——保护性中止，绝不当"不存在"处理，
                // 免得后面误判成"本次调用新建"，进而把本来就存在的东西删掉。
                return { ok: true, action: 'target-occupied', dir: targetDir };
            }
        }
        const isMissing = !dirExists;
        const isEmpty = dirExists && entries.length === 0;

        if (isMissing || isEmpty) {
            // 分支 a：目标目录不存在，或存在但为空——可以安全 clone。
            let createdByUs = false;
            if (isMissing) {
                try {
                    fs.mkdirSync(cloneRoot, { recursive: true });
                    createdByUs = true;
                } catch (e) {
                    return { ok: false, action: 'mkdir-failed', error: '创建目标目录失败: ' + e.message };
                }
            }
            const cloneResult = await runGitCommand(['clone', gitUrl, targetDir], cloneRoot, token, OVERLEAF_CLONE_TIMEOUT_MS);
            if (!cloneResult.ok) {
                if (createdByUs) {
                    // 只删自己刚建的半成品目录，绝不删本来就存在的目录（哪怕它当初是空的）。
                    // v2 Pass P133b 收口2：改走 fsRemoveTree——targetDir 是用户自选路径，含中文时
                    // 旧的 fs.rmSync 不但删不掉半成品，还可能删掉那条乱码路径上碰巧存在的别的目录。
                    await fsRemoveTree(targetDir, { force: true });
                }
                return { ok: false, error: redactToken(cloneResult.stderr || cloneResult.stdout || 'git clone 失败', token) };
            }
            // v2 Pass P191：runGitCommand() 里注入的 `-c core.longpaths=true`（见该常量
            // GIT_LONGPATHS_ARGS 处的注释）只对这一次 spawn 生效，不写进任何 .git/config。
            // 克隆成功后在新仓库里单独持久化一次，否则用户自己在这个目录里手敲 git
            // （比如以后 pull）会因为宿主机三级 git config 都没设 core.longpaths 而重新
            // 撞上同一个 "Filename too long"。best-effort：这一步失败不影响本次克隆的
            // 成功结果，只记日志（不抛异常、不改变返回值），避免"持久化这种锦上添花的
            // 收尾步骤"反而拖垮"克隆本体已经成功"这个更重要的结果。
            try {
                const persistResult = await runGitCommand(['config', 'core.longpaths', 'true'], targetDir, null);
                if (!persistResult.ok) {
                    console.error('[P191] 克隆成功但持久化 core.longpaths 失败（不影响本次克隆结果）：', persistResult.stderr || persistResult.stdout);
                }
            } catch (e) {
                console.error('[P191] 克隆成功但持久化 core.longpaths 时抛出异常（不影响本次克隆结果）：', e && e.message);
            }
            return { ok: true, action: 'cloned', dir: targetDir, suggestedName: extractSuggestedProjectName(targetDir) };
        }

        // 分支 b/c：目标目录已存在且非空——先判断它是不是"这个" Overleaf 项目自己的仓库。
        const gitDir = path.join(targetDir, '.git');
        let hasGitDir = false;
        try { hasGitDir = fs.existsSync(gitDir); } catch (e) { hasGitDir = false; }
        if (hasGitDir) {
            const urlResult = await runGitCommand(['remote', 'get-url', 'origin'], targetDir, token);
            const curUrl = urlResult.ok ? urlResult.stdout.trim() : null;
            if (curUrl !== null && normalizeGitUrlForCompare(curUrl) === normalizeGitUrlForCompare(gitUrl)) {
                // 分支 b：已经是这个项目的本地副本，不做任何写操作。
                return { ok: true, action: 'already-cloned', dir: targetDir, suggestedName: extractSuggestedProjectName(targetDir) };
            }
        }
        // 分支 c：非空但不是该仓库（不是 git 仓库，或 origin 取不到/不匹配）——保护性中止，
        // 不删除任何东西，原样报告给前端自己处理。
        return { ok: true, action: 'target-occupied', dir: targetDir };
    } catch (e) {
        return { ok: false, error: redactToken('内部错误: ' + (e && e.message), token) };
    }
}

// v2 Pass P53：克隆前置的"存放位置"弹窗要在真正 clone 之前就能告诉用户"这个位置行不行"，
// 尤其是远程模式（桥跑在别的机器上，用户没法用本机原生文件夹选择框、只能手填路径，手填就
// 更容易填错）。这个接口故意做得比 /fs/list 窄得多：只回答"父目录存不存在/能不能写"、
// "目标子目录存不存在/是否非空"，绝不返回目录里有什么文件——克隆目标按定义在任何已知项目
// 之外，不能套用 resolveInProject() 那套"必须落在某个 projectDir 内部"的越界防护语义，
// 但也不该为了这一个校验需求就去放宽 /fs/* 那几个通用文件操作端点的防护范围。父目录必须
// 是绝对路径，本身不做任何写操作（accessSync/statSync/readdirSync 全部只读探测）。
async function doOverleafCheckTarget(parentDir, folderName) {
    if (!parentDir || typeof parentDir !== 'string') {
        return { ok: false, error: '存放位置不能为空' };
    }
    if (!path.isAbsolute(parentDir)) {
        return { ok: true, parentStatus: 'not-absolute', targetStatus: null, targetDir: null };
    }
    let parentStatus;
    try {
        const st = fs.statSync(parentDir);
        if (!st.isDirectory()) {
            parentStatus = 'not-directory';
        } else {
            try {
                fs.accessSync(parentDir, fs.constants.W_OK);
                parentStatus = 'ok';
            } catch (e) {
                parentStatus = 'not-writable';
            }
        }
    } catch (e) {
        parentStatus = 'missing';
    }

    if (parentStatus !== 'ok') {
        return { ok: true, parentStatus: parentStatus, targetStatus: null, targetDir: null };
    }

    const name = (typeof folderName === 'string' && folderName.trim()) ? folderName.trim() : null;
    if (!name) {
        return { ok: true, parentStatus: parentStatus, targetStatus: null, targetDir: null };
    }
    const targetDir = path.join(path.resolve(parentDir), name);
    let targetStatus;
    try {
        const tst = fs.statSync(targetDir);
        if (!tst.isDirectory()) {
            targetStatus = 'occupied'; // 存在但是个文件——同样是"占着"，保护性地按占用处理
        } else {
            let entries;
            try { entries = fs.readdirSync(targetDir); } catch (e) { entries = null; }
            targetStatus = (entries === null || entries.length > 0) ? 'occupied' : 'available';
        }
    } catch (e) {
        targetStatus = 'available'; // 不存在——clone 时会自动创建
    }
    return { ok: true, parentStatus: parentStatus, targetStatus: targetStatus, targetDir: targetDir };
}

// ---------------------------------------------------------------------------
// v2 Pass P40：/fs/* —— 受限文件操作端点，服务"AI 聊天窗当 agent 操纵项目文件树"这个
// 需求（协助移动/复制/修改/删除任意文件，并借项目自己的 git 提供误操作回退）。
//
// 安全护栏（跟 /overleaf/* 那段头部注释同一个纪律：宁可拒绝也不猜测覆盖）：
//   1. 路径必须严格限制在调用方传入的 projectDir 内。resolveInProject() 先按字符串
//      resolve+前缀比对拦一轮，再对"路径链上第一个真实存在的祖先目录"做一次 realpath
//      展开、拿展开后的真实路径再比一次前缀——防的是 base 内部藏了个指向 base 之外的
//      符号链接/junction（纯字符串前缀比对看不出这种绕法，见任务里点名的攻击向量）。
//   2. 任何落在 .git/ 内部的路径（按路径分段精确匹配 ".git"，不是子串匹配，避免
//      "xxx.gitignore" 这种正常文件被误伤）一律拒绝读写删除。
//   3. write/mkdir/move/copy/delete 五个改变文件系统的操作，动手前都先调用
//      fsGitCheckpoint() 打一个检查点（v2 Pass P41 起改为"旁路 ref 快照"，见该函数
//      头部注释）：projectDir 是 git 工作树就把"这次操作之前"的完整现场落成一个不
//      挂在任何分支上的提交对象、挂到 refs/ovl-checkpoints/<id> 这个旁路 ref 下，
//      绝不移动当前分支 HEAD、绝不产生分支上的提交、绝不碰用户真实的索引/工作区，
//      返回它的 commit hash 给前端展示"可回退到 X"；不是 git 工作树就明确
//      available:false + 中文 warning，绝不装作有回退保障。
//      （P40 的旧实现是直接 `git add -A -- .` + `git commit` 到当前分支——这在
//      projectDir 是用户真实项目仓库时会污染分支历史、且 push 时随手带进 Overleaf，
//      已在 P41 彻底删除，不留开关。）
//   4. move/delete 的响应里带 affected：受影响的完整相对路径清单（目录会展开成
//      它下面全部文件的清单，不只报目录名）。
//   5. 所有失败路径统一走 sendJson({ok:false, error:'中文错误'})，不会把未捕获异常
//      直接摔成 500 堆栈——顶层路由的 try/catch 只是最后一道保险，各 do* 函数自己也是
//      "不抛异常、统统汇总成 {ok,...} 返回" 的既有风格（镜像 runGitCommand 的写法）。
//   6. 长操作走已有的 runGitCommand() 超时机制（30s），不新起一套超时逻辑。
//   7. /fs/restore（P41 新增）：把工作区恢复到某个检查点当时的快照，语义与已知差异
//      见 doFsRestore() 头部注释。
// ---------------------------------------------------------------------------

const FS_READ_MAX_BYTES = 1024 * 1024; // 1MB：读文件硬上限，见任务要求。
const FS_GIT_TIMEOUT_MS = 30000;

function fsRealpath(p) {
    try { return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); }
    catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// v2 Pass P133b 收口2：Windows 上 fs.rmSync / fs.cpSync 会静默破坏含非 ASCII 字符的路径
// ---------------------------------------------------------------------------
// 根因（本机 Node v24.12.0 / win32-x64，ANSI 代码页 ACP=936，已用最小脚本逐条坐实）：
// Node ≥22 把 fs.rmSync / fs.cpSync 的实现挪进了 C++ 的 std::filesystem
// （`fs.rmSync.toString()` 就是 `binding.rmSync(getValidatedPath(path), …)`），而 MSVC 的
// `std::filesystem::path` 从**窄字符串**构造时按 Windows ANSI 代码页把字节转成 UTF-16——
// Node 递下去的却是 UTF-8 字节。于是路径里只要有一个非 ASCII 字符，C++ 那边看到的就是另一条
// 「乱码路径」：
//   · rmSync('…/图片-测试.txt') 实际操作的是 '…/鍥剧墖-娴嬭瘯.txt'（UTF-8 字节按 CP936 重解释）。
//     该路径通常不存在 → std::filesystem::status() 报 not_found → 实现直接 return，**不抛异常**
//     → doFsDelete 只看"没抛异常"就回 ok:true。这就是 /fs/delete 说删了、文件还在的全部原因。
//   · 更危险的是它并非"什么都不做"：那条乱码路径**万一真的存在**，被删掉的就是它。实测
//     （同时建「删除目标目录」与其乱码同名目录，rmSync 传入前者）：中文目录原封不动，乱码目录
//     连同里面的文件被整棵删光——这是会删错用户文件的数据损坏面，不只是"没生效"。
//   · cpSync 同理把目标建到乱码路径上：cpSync(src, '…/副本目录') 之后磁盘上出现的是 '鍓湰鐩綍'，
//     调用方看到的 '副本目录' 根本不存在。
//   · 某些字节序列（实测日文片假名 'テスト'、以及中文目录名做 cpSync 来源）在转换时让整个进程
//     以 0xC0000409 STATUS_STACK_BUFFER_OVERRUN 硬退出——桥进程当场死掉，页面报"桥接服务未启动"。
// 不是根因的几处（都已逐条排除）：请求体解码（readBody 是 Buffer.concat(...).toString('utf8')，
// JSON.parse 后拿到的 JS 字符串正确）、URL/查询串的 decodeURIComponent（/fs/* 全走 POST JSON 体）、
// 路径拼接/normalize/realpath 与越界校验（resolveInProject 用的 path.resolve / fs.existsSync /
// fs.statSync / fs.realpathSync 在中文路径上全部正常）。走 libuv 的那批 API——unlink / rmdir /
// rename / mkdir / stat / lstat / readdir / copyFile / realpath / writeFile / readFile / glob——
// 一律正确（它们把 UTF-8 正确转成 UTF-16）；fs.promises.rm / fs.promises.cp 是 JS 实现、底下只用
// 这批 API，实测 ascii/中文/日文/emoji/西里尔/空格/深层嵌套/只读文件全部正常。
//
// 因此本文件**一律不再使用 fs.rmSync / fs.cpSync**，改走下面两个包装；并且每个写操作之后都
// **回头校验磁盘上的真实结果**——即便将来 Node 把 promises 版也挪进 C++、或者换一台 ACP 不同的
// 机器，最坏也只是得到一条明确的错误，不会再出现"回 ok:true 却什么都没干"。
function fsPathStillThere(p) {
    // 用 lstat 而不是 existsSync：断链的符号链接本身也算"还在"，不能被当成已删除。
    try { fs.lstatSync(p); return true; } catch (e) { return false; }
}

// 递归删除；语义对齐原来的 fs.rmSync(p, {recursive:true, force}) 调用形状。
// 永不抛异常，一律返回 {ok:true} 或 {ok:false, code, error}。
async function fsRemoveTree(absPath, opts) {
    opts = opts || {};
    const force = !!opts.force;
    try {
        await fs.promises.rm(absPath, { recursive: true, force: force, maxRetries: 3, retryDelay: 60 });
    } catch (e) {
        if (force && e && e.code === 'ENOENT') return { ok: true };
        return { ok: false, code: 'RM_FAILED', error: (e && e.message) ? e.message : String(e) };
    }
    if (fsPathStillThere(absPath)) {
        return { ok: false, code: 'RM_NOT_EFFECTIVE', error: '删除未生效：调用没有报错，但目标在磁盘上仍然存在' };
    }
    return { ok: true };
}

// 递归复制；语义对齐原来的 fs.cpSync(src, dest, {recursive:true, errorOnExist:true})。
// 复制完必须真的落在 dest 上：类型要跟来源一致，单文件比字节数，目录比递归展开的文件条数。
async function fsCopyTree(src, dest) {
    try {
        await fs.promises.cp(src, dest, { recursive: true, errorOnExist: true });
    } catch (e) {
        return { ok: false, code: 'CP_FAILED', error: (e && e.message) ? e.message : String(e) };
    }
    let ss = null, ds = null;
    try { ss = fs.lstatSync(src); } catch (e) {}
    try { ds = fs.lstatSync(dest); } catch (e) {}
    if (!ds) {
        return { ok: false, code: 'CP_NOT_EFFECTIVE', error: '复制未生效：调用没有报错，但目标路径在磁盘上不存在' };
    }
    if (ss && ss.isDirectory() !== ds.isDirectory()) {
        return { ok: false, code: 'CP_NOT_EFFECTIVE', error: '复制未生效：目标的类型（' + (ds.isDirectory() ? '目录' : '文件') + '）与来源（' + (ss.isDirectory() ? '目录' : '文件') + '）不一致' };
    }
    if (ss && ss.isFile() && ds.isFile() && ss.size !== ds.size) {
        return { ok: false, code: 'CP_NOT_EFFECTIVE', error: '复制未生效：目标字节数 ' + ds.size + ' 与来源 ' + ss.size + ' 不一致' };
    }
    if (ss && ss.isDirectory() && ds.isDirectory()) {
        const nSrc = collectAffectedRelPaths(path.dirname(src), src).length;
        const nDst = collectAffectedRelPaths(path.dirname(dest), dest).length;
        if (nSrc !== nDst) {
            return { ok: false, code: 'CP_NOT_EFFECTIVE', error: '复制未生效：目标下有 ' + nDst + ' 个文件，来源有 ' + nSrc + ' 个，复制不完整' };
        }
    }
    return { ok: true };
}

// 把 relPath 解析到 projectDir 内部的绝对路径，做双重防越界校验（字符串前缀 + realpath
// 展开后再比一次前缀），并拒绝任何落在 .git/ 内部的路径。校验不过一律返回 {ok:false}，
// 绝不静默放行——调用方按 r.ok 分流，成功时 r.resolved 是可以直接拿去用的绝对路径。
function resolveInProject(projectDir, relPath) {
    if (typeof projectDir !== 'string' || !projectDir) return { ok: false, error: 'projectDir 缺失' };
    if (typeof relPath !== 'string' || !relPath) return { ok: false, error: 'path 缺失' };
    let base;
    try { base = path.resolve(projectDir); } catch (e) { return { ok: false, error: 'projectDir 无效' }; }
    if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        return { ok: false, error: 'projectDir 不存在或不是目录: ' + projectDir };
    }
    const realBase = fsRealpath(base);
    if (!realBase) return { ok: false, error: 'projectDir 无法解析真实路径' };

    let resolved;
    try { resolved = path.resolve(base, relPath); } catch (e) { return { ok: false, error: 'path 无效' }; }
    const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
    if (resolved !== base && resolved.indexOf(baseWithSep) !== 0) {
        return { ok: false, error: 'path 跑出项目目录范围，拒绝' };
    }

    const relForCheck = path.relative(base, resolved);
    const segments = relForCheck.split(path.sep).filter((s) => s.length > 0);
    if (relSegmentsHaveGit(segments)) { // v2 Pass P214 SERVER-11：大小写/尾点空格不敏感
        return { ok: false, error: '拒绝访问 .git 内部路径' };
    }

    // realpath 二次校验：找路径链上第一个真实存在的祖先（目标本身可能还不存在，比如
    // write/mkdir 的目标），展开它的真实路径，再跟 realBase 比一次前缀——防 base 内部
    // 有符号链接/junction 指向 base 之外（纯字符串比对看不出这种绕法）。
    let probe = resolved;
    while (!fs.existsSync(probe)) {
        const parent = path.dirname(probe);
        if (parent === probe) { probe = null; break; }
        probe = parent;
    }
    if (probe) {
        const realProbe = fsRealpath(probe);
        if (!realProbe) return { ok: false, error: '路径解析失败' };
        const realBaseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep;
        if (realProbe !== realBase && realProbe.indexOf(realBaseWithSep) !== 0) {
            return { ok: false, error: 'path 通过符号链接/junction 跑出项目目录范围，拒绝' };
        }
    }

    return { ok: true, resolved: resolved, base: base };
}

// 收集"实际受影响的完整路径清单"（相对 base）：单个文件就是它自己，目录就展开成它
// 下面全部文件（跳过 .git），供 move/delete 的响应用，方便前端在执行前后展示确切影响面。
function collectAffectedRelPaths(base, absPath) {
    let st;
    // v2 Pass P80 W2（server-endpoints confirmed high）：顶层和递归展开都改用 fs.lstatSync（不
    // 跟随符号链接/junction），跟下面 walk() 里的判断保持一致——原来这里用 fs.statSync 会跟随
    // 顶层 absPath 本身是符号链接的情况。
    try { st = fs.lstatSync(absPath); } catch (e) { return []; }
    if (st.isSymbolicLink()) return [];
    if (!st.isDirectory()) return [path.relative(base, absPath)];
    const out = [];
    (function walk(dir) {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        names.forEach((name) => {
            if (name === '.git') return;
            const full = path.join(dir, name);
            let s;
            try { s = fs.lstatSync(full); } catch (e) { return; }
            // v2 Pass P80 W2（server-endpoints confirmed high）：这里原来用 fs.statSync（会跟随
            // 符号链接/NTFS junction），doFsRestore 拿 collectAffectedRelPaths 的结果当"待删除
            // 候选"用 fs.rmSync 物理删除——项目目录内如果存在一个指向外部的 junction/symlink
            // （Windows 上 mklink /J 或 npm 在 node_modules 下建的 junction 都不需要管理员权限），
            // 联接目标里的每个文件都会被这里的递归展开成"检查点之后新建、快照里没有"，恢复时
            // 物理删除的其实是联接目标里的真实外部文件（已用隔离的临时目录 + PowerShell
            // New-Item -ItemType Junction 实测复现：fs.lstatSync(junction路径).isSymbolicLink()
            // === true，改用 lstat 后直接跳过、不展开、联接本身也不纳入候选，doFsRestore 就不会
            // 再碰它，也不会碰它指向的任何东西）。
            if (s.isSymbolicLink()) return;
            if (s.isDirectory()) walk(full); else out.push(path.relative(base, full));
        });
    })(absPath);
    return out;
}

function looksBinary(buf) {
    const len = Math.min(buf.length, 8000);
    for (let i = 0; i < len; i++) { if (buf[i] === 0) return true; }
    return false;
}

const FS_CHECKPOINT_REF_PREFIX = 'refs/ovl-checkpoints/';

// 生成一个不会跟并发调用撞名、也不跟真实 .git/index 撞路径的临时索引文件路径。
function fsTempIndexPath() {
    return path.join(os.tmpdir(), 'ai-translator-ckpt-' + process.pid + '-' + Date.now() + '-' +
        crypto.randomBytes(6).toString('hex') + '.index');
}

// 拿 <commit-ish>（可以是 HEAD，也可以是任何 tree-ish）下面的完整"已跟踪路径"清单
// （相对仓库根，'/' 分隔）。commit-ish 不存在（比如全新仓库还没有第一个提交）时返回
// 空数组而不是报错——调用方按"没有 HEAD 就没有基线可比对"处理。
async function fsListTreeFiles(projectDir, commitish) {
    const r = await runGitCommand(['ls-tree', '-r', '--name-only', commitish], projectDir, null, FS_GIT_TIMEOUT_MS);
    if (!r.ok) return [];
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

// 改变文件系统前打的自动 git 检查点——v2 Pass P41：旁路 ref 快照，不是分支提交。
// v2 Pass P46（本次修复，事故编号见函数外的调用方注释）：修了两处：
//   (a) 临时索引不再从空白开始，先 `git read-tree HEAD` 把 HEAD 的已跟踪文件集合读进去，
//       再 `git add -A -- .`——这样这些文件在这个临时索引里"本来就是已跟踪的"，
//       `.gitignore` / `.git/info/exclude` 的忽略规则不会把它们从快照里排除掉（忽略规则
//       只对"未跟踪"路径生效，这是 git 本身的语义，不是本函数发明的）。
//       事故复盘：旧实现临时索引从空白开始，对空索引而言仓库里每个文件都是"未跟踪"的，
//       于是 `.git/info/exclude` 里的 `/report/`、`*.drawio` 之类规则会静默漏掉这些
//       已跟踪文件，快照树因此比 HEAD 少 248 个文件，全程没有任何报错信号。
//   (b) 生成快照树之后，跟 HEAD 做一次完整性自检（见 fsCheckpointIntegrityCheck）：
//       HEAD 里已跟踪、且当前工作区仍然存在的文件，必须每一个都出现在快照树里；
//       少了就不再静默返回一个"看起来正常、其实残缺"的检查点——直接判定
//       available:false + 明确中文 warning，前端/调用方不能再假装这次操作有回退保障。
//
// projectDir 不是 git 工作树 -> available:false + 中文 warning，绝不装作能回退。
//
// 是工作树 -> 用 git plumbing 把"此刻工作区的完整状态"（含未跟踪文件，尊重 .gitignore）
// 落成一个提交对象，挂到 refs/ovl-checkpoints/<id> 这个旁路 ref 下，具体步骤：
//   1. 用一个刚生成、此前不存在的临时文件路径当 GIT_INDEX_FILE（绝不是仓库真实的
//      .git/index）。HEAD 存在时先 `git read-tree HEAD` 把已跟踪文件集合读进这个临时
//      索引（HEAD 不存在——全新仓库——就跳过，临时索引仍从空白开始，这种情况下仓库里
//      本来也没有"已跟踪文件"需要保护）。
//   2. 在这个临时索引上跑 `git add -A -- .`——工作区状态（新增/修改/删除）被记进临时
//      索引，用户真实的暂存区（无论里面有没有未提交的改动）全程没被这条命令碰过。
//   3. `git write-tree`（仍指着这个临时索引）把它写成一个 tree 对象。
//   4. 完整性自检：HEAD 存在时，比对 HEAD 的已跟踪文件清单 与 这棵新 tree 的文件清单；
//      HEAD 里"当前工作区仍然存在"的每个路径都必须在新 tree 里出现，少一个就判定失败。
//   5. `git commit-tree <tree> [-p <当前HEAD>]` 造一个提交对象——不写 refs/heads/*，
//      HEAD 不存在时不带 -p。
//   6. `git update-ref refs/ovl-checkpoints/<id> <commit>` 把提交对象挂到旁路 ref 上。
//      refs/ovl-checkpoints/* 不在 refs/heads/* 下，git push 默认不会推它。
// 全程没有一步移动过当前分支、没有一步写过真实 .git/index、没有一步改过工作区文件。
// 临时索引文件用完即删（finally 块，即使中途失败也清）。
async function fsGitCheckpoint(projectDir, label) {
    const treeCheck = await runGitCommand(['rev-parse', '--is-inside-work-tree'], projectDir, null, FS_GIT_TIMEOUT_MS);
    if (!treeCheck.ok || treeCheck.stdout.trim() !== 'true') {
        return { available: false, checkpoint: null, warning: '该目录不是 git 仓库（或不在 git 工作树内），本次操作无法提供回退保障。' };
    }
    const headResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, null, FS_GIT_TIMEOUT_MS);
    const headHash = headResult.ok ? headResult.stdout.trim() : null;

    const tmpIndex = fsTempIndexPath();
    try {
        if (headHash) {
            // 关键修复 (a)：先把 HEAD 的已跟踪文件集合读进临时索引，后面的 `git add -A`
            // 才不会把它们当"未跟踪"处理，忽略规则也就不会误伤它们。
            const readTreeResult = await runGitCommand(['read-tree', headHash], projectDir, null, FS_GIT_TIMEOUT_MS,
                { GIT_INDEX_FILE: tmpIndex });
            if (!readTreeResult.ok) {
                return { available: true, checkpoint: null, warning: '生成回退检查点失败（git read-tree HEAD，临时索引）：' + (readTreeResult.stderr || readTreeResult.stdout || '未知错误') };
            }
        }
        const addResult = await runGitCommand(['add', '-A', '--', '.'], projectDir, null, FS_GIT_TIMEOUT_MS,
            { GIT_INDEX_FILE: tmpIndex });
        if (!addResult.ok) {
            return { available: true, checkpoint: null, warning: '生成回退检查点失败（git add，临时索引）：' + (addResult.stderr || addResult.stdout || '未知错误') };
        }
        const writeTreeResult = await runGitCommand(['write-tree'], projectDir, null, FS_GIT_TIMEOUT_MS,
            { GIT_INDEX_FILE: tmpIndex });
        if (!writeTreeResult.ok) {
            return { available: true, checkpoint: null, warning: '生成回退检查点失败（git write-tree）：' + (writeTreeResult.stderr || writeTreeResult.stdout || '未知错误') };
        }
        const tree = writeTreeResult.stdout.trim();

        // 关键修复 (b)：完整性自检——HEAD 里已跟踪、且当前工作区仍然存在的文件，
        // 必须每一个都出现在快照树里。少了就不允许静默返回一个看起来正常的检查点。
        if (headHash) {
            const missing = await fsCheckpointMissingTrackedFiles(projectDir, headHash, tree);
            if (missing.length > 0) {
                return {
                    available: false, checkpoint: null,
                    warning: '生成回退检查点失败：完整性自检未通过——快照树缺少 ' + missing.length +
                        ' 个 HEAD 中已跟踪且当前仍存在的文件（例如: ' + missing.slice(0, 5).join(', ') +
                        (missing.length > 5 ? ' 等' : '') + '），可能是 .gitignore/.git/info/exclude 的忽略规则误伤了已跟踪文件。' +
                        '本次操作无法提供可信的回退保障，已拒绝生成检查点。'
                };
            }
        }

        const commitMsg = 'AI-Translator fs checkpoint: ' + label + ' ' + new Date().toISOString();
        const commitArgs = headHash
            ? ['commit-tree', tree, '-p', headHash, '-m', commitMsg]
            : ['commit-tree', tree, '-m', commitMsg];
        const commitResult = await runGitCommand(commitArgs, projectDir, null, FS_GIT_TIMEOUT_MS);
        if (!commitResult.ok) {
            return { available: true, checkpoint: null, warning: '生成回退检查点失败（git commit-tree）：' + (commitResult.stderr || commitResult.stdout || '未知错误') };
        }
        const commitHash = commitResult.stdout.trim();
        const refName = FS_CHECKPOINT_REF_PREFIX + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
        const updateRefResult = await runGitCommand(['update-ref', refName, commitHash], projectDir, null, FS_GIT_TIMEOUT_MS);
        if (!updateRefResult.ok) {
            return { available: true, checkpoint: commitHash, warning: '检查点提交对象已生成，但挂旁路 ref 失败（git update-ref）：' + (updateRefResult.stderr || updateRefResult.stdout || '未知错误') };
        }
        return { available: true, checkpoint: commitHash, ref: refName };
    } finally {
        try { fs.unlinkSync(tmpIndex); } catch (e) {}
    }
}

// fsGitCheckpoint 完整性自检的核心比对：HEAD 已跟踪文件清单 中，"当前工作区仍然
// 存在"的那些路径，有哪些没有出现在刚生成的快照树里。返回缺失路径清单（相对仓库根，
// '/' 分隔），空数组代表完整性自检通过。
// 之所以要先过滤"当前工作区仍然存在"：HEAD 里有、但用户在本次操作之前就已经手动删除
// （或本次操作本身就是删除它）的文件，快照里没有它是正确行为，不算完整性问题。
async function fsCheckpointMissingTrackedFiles(projectDir, headHash, snapshotTree) {
    const headFiles = await fsListTreeFiles(projectDir, headHash);
    if (headFiles.length === 0) return [];
    const snapshotFiles = new Set(await fsListTreeFiles(projectDir, snapshotTree));
    const missing = [];
    headFiles.forEach((rel) => {
        if (snapshotFiles.has(rel)) return;
        const abs = path.join(projectDir, rel.split('/').join(path.sep));
        if (fs.existsSync(abs)) missing.push(rel);
    });
    return missing;
}

function checkpointFields(cp) {
    return { checkpoint: cp.checkpoint, checkpointAvailable: cp.available, checkpointWarning: cp.warning || null };
}

// v2 Pass P44：纯只读的能力查询——只回答"这个目录能不能提供回退保障"，不产生任何副作用。
// 跟 fsGitCheckpoint() 的关键区别：只跑一次 `git rev-parse --is-inside-work-tree`，
// 绝不 add / write-tree / commit-tree / update-ref，因此不会在 refs/ovl-checkpoints/ 下
// 留下任何 ref，也不碰真实 .git/index 或工作区文件。字段命名沿用 checkpointFields()，
// 前端不用改数据结构；checkpoint 字段恒为 null（没有生成任何检查点对象）。
async function doFsCapabilities(projectDir) {
    const treeCheck = await runGitCommand(['rev-parse', '--is-inside-work-tree'], projectDir, null, FS_GIT_TIMEOUT_MS);
    if (!treeCheck.ok || treeCheck.stdout.trim() !== 'true') {
        return Object.assign({ ok: true }, checkpointFields({
            available: false, checkpoint: null,
            warning: '该目录不是 git 仓库（或不在 git 工作树内），本次操作无法提供回退保障。'
        }));
    }
    return Object.assign({ ok: true }, checkpointFields({ available: true, checkpoint: null }));
}

async function doFsList(projectDir, relPath) {
    const r = resolveInProject(projectDir, relPath || '.');
    if (!r.ok) return { ok: false, error: r.error };
    let st;
    try { st = fs.statSync(r.resolved); } catch (e) { return { ok: false, error: '路径不存在: ' + relPath }; }
    if (!st.isDirectory()) return { ok: false, error: '不是目录: ' + relPath };
    let names;
    try { names = fs.readdirSync(r.resolved); } catch (e) { return { ok: false, error: '读取目录失败: ' + e.message }; }
    const entries = [];
    names.forEach((name) => {
        if (name === '.git') return; // .git 内部一律不列出
        const full = path.join(r.resolved, name);
        let s;
        try { s = fs.statSync(full); } catch (e) { return; }
        entries.push({ name: name, isDir: s.isDirectory(), size: s.isDirectory() ? null : s.size, mtimeMs: s.mtimeMs });
    });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, path: relPath, entries: entries };
}

async function doFsRead(projectDir, relPath) {
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    let st;
    try { st = fs.statSync(r.resolved); } catch (e) { return { ok: false, error: '文件不存在: ' + relPath }; }
    if (!st.isFile()) return { ok: false, error: '不是文件: ' + relPath };
    if (st.size > FS_READ_MAX_BYTES) {
        return { ok: false, error: '文件过大（' + st.size + ' 字节 > ' + FS_READ_MAX_BYTES + ' 字节上限），拒绝读取', size: st.size, tooLarge: true };
    }
    let buf;
    try { buf = fs.readFileSync(r.resolved); } catch (e) { return { ok: false, error: '读取失败: ' + describeFileReadError(e, r.resolved) }; }
    if (looksBinary(buf)) {
        return { ok: true, path: relPath, size: st.size, binary: true, content: null, mtimeMs: st.mtimeMs };
    }
    // v2 Pass P214 SERVER-3：内容往返不一致（Latin-1/GBK 等非 UTF-8 文件）时置 nonUtf8:true——
    // content 里已经是 U+FFFD 替换字符，原样写回会永久丢字节。内容本身不改，交给客户端决定只读还是确认。
    const textContent = buf.toString('utf8');
    const nonUtf8 = !Buffer.from(textContent, 'utf8').equals(buf);
    return { ok: true, path: relPath, size: st.size, binary: false, content: textContent, nonUtf8: nonUtf8, mtimeMs: st.mtimeMs };
}

// v2 Pass P50：expectedMtimeMs 是可选的乐观并发冲突检测——远程模式下浏览器读到的文件内容
// 跟真正落盘之间可能隔了任意长时间（用户切走标签页、断网重连……），这段时间里别人（或用户
// 自己另一个标签页）可能已经改过磁盘上的同一个文件；不检测直接写会把对方的修改静默覆盖掉。
// 只在调用方明确传了这个数字时才检查（新建文件等场景不传，语义上"不关心冲突"）；文件此刻
// 不存在时不算冲突（新建场景），只有"文件存在且 mtime 跟调用方读到时不一致"才判冲突。
//
// v2 Pass P214 SERVER-1：同一路径上的 write / write-binary / delete / move 串行（见 withPathLocks），
// 且 mtime 在 fsGitCheckpoint（约 9 次 git 子进程，最长 30 秒）之后、真正落盘之前再核对一次——
// 以前只在 checkpoint 之前核对，这段窗口里的外部改动会被静默覆盖，两个重叠的保存也会乱序落盘。
// 刻意保留原地写（不改 temp+rename）：rename 会改变 fs.watch、OneDrive、杀软看到的事件形状。
const pathWriteTails = new Map();
function withPathLocks(paths, fn) {
    const keys = Array.from(new Set(paths.map((p) => process.platform === 'win32' ? String(p).toLowerCase() : String(p)))).sort();
    const step = (i) => {
        if (i >= keys.length) return fn();
        const key = keys[i];
        const prev = pathWriteTails.get(key) || Promise.resolve();
        const run = prev.then(() => step(i + 1));
        const tail = run.then(() => {}, () => {});
        pathWriteTails.set(key, tail);
        tail.then(() => { if (pathWriteTails.get(key) === tail) pathWriteTails.delete(key); });
        return run;
    };
    return step(0);
}
function fsMtimeConflict(absPath, expectedMtimeMs) {
    if (typeof expectedMtimeMs !== 'number' || !isFinite(expectedMtimeMs)) return null;
    let curStat = null;
    try { curStat = fs.statSync(absPath); } catch (e) { curStat = null; }
    if (curStat && curStat.mtimeMs !== expectedMtimeMs) {
        return {
            ok: false, conflict: true, currentMtimeMs: curStat.mtimeMs,
            error: '文件已被外部修改（磁盘上的 mtime 跟你上次读取时不一致），为避免覆盖对方的修改，本次保存已取消。'
        };
    }
    return null;
}
async function doFsWrite(projectDir, relPath, content, expectedMtimeMs) {
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    if (typeof content !== 'string') return { ok: false, error: 'content 必须是字符串' };
    return withPathLocks([r.resolved], () => doFsWriteImpl(projectDir, relPath, content, expectedMtimeMs));
}
async function doFsWriteImpl(projectDir, relPath, content, expectedMtimeMs) {
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    const early = fsMtimeConflict(r.resolved, expectedMtimeMs);
    if (early) return early;
    const cp = await fsGitCheckpoint(projectDir, 'write ' + relPath);
    const late = fsMtimeConflict(r.resolved, expectedMtimeMs);
    if (late) return Object.assign(late, checkpointFields(cp));
    try { fs.mkdirSync(path.dirname(r.resolved), { recursive: true }); }
    catch (e) { return Object.assign({ ok: false, error: '创建父目录失败: ' + e.message }, checkpointFields(cp)); }
    try { fs.writeFileSync(r.resolved, content, 'utf8'); }
    catch (e) { return Object.assign({ ok: false, error: '写入失败: ' + e.message }, checkpointFields(cp)); }
    // v2 Pass P133b 收口2：落盘自检——写完必须真的是一个文件、字节数跟内容对得上，
    // 对不上就明确报错，绝不因为"调用没抛异常"就回 ok:true（同一类"静默写坏"在
    // fs.rmSync/fs.cpSync 上已经踩过，见 fsRemoveTree 头部注释）。
    const wantBytes = Buffer.byteLength(content, 'utf8');
    let st2 = null;
    try { st2 = fs.statSync(r.resolved); } catch (e) { st2 = null; }
    if (!st2 || !st2.isFile()) {
        return Object.assign({ ok: false, code: 'WRITE_NOT_EFFECTIVE', error: '写入未生效：调用没有报错，但磁盘上没有出现这个文件: ' + relPath }, checkpointFields(cp));
    }
    if (st2.size !== wantBytes) {
        return Object.assign({ ok: false, code: 'WRITE_NOT_EFFECTIVE', error: '写入未生效：磁盘上的字节数 ' + st2.size + ' 与待写内容的 ' + wantBytes + ' 不一致' }, checkpointFields(cp));
    }
    return Object.assign({ ok: true, path: relPath, bytesWritten: wantBytes, mtimeMs: st2.mtimeMs }, checkpointFields(cp));
}

// v2 Pass P75 §7.1：doFsWrite 只能写 UTF-8 字符串（fs.writeFileSync(..., 'utf8')），PDF→LaTeX
// 转换产物里的页面栅格图/内嵌图片需要原样字节落盘；远程桥模式下浏览器侧
// OvlRemoteFileHandle.createWritable().write() 对 Blob/ArrayBuffer 会先 TextDecoder('utf-8')
// 解码成字符串再走 /fs/write，二进制必被写坏（shim 注释自陈"不承诺任意二进制字节流原样落盘"）。
// 本端点走 base64 传输 + 服务端原样 Buffer 落盘，绕开这条坑；本地 FSA 句柄写二进制本来就没有
// 这个问题（ovlPerformUpload 直接 write(arrayBuffer)），前端只在远程模式下才会调用这个端点。
async function doFsWriteBinary(projectDir, relPath, contentBase64, opts) {
    const r0 = resolveInProject(projectDir, relPath);
    if (!r0.ok) return { ok: false, error: r0.error };
    return withPathLocks([r0.resolved], () => doFsWriteBinaryImpl(projectDir, relPath, contentBase64, opts)); // v2 Pass P214 SERVER-1
}
async function doFsWriteBinaryImpl(projectDir, relPath, contentBase64, opts) {
    opts = opts || {};
    const skipCheckpoint = !!opts.skipCheckpoint;
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    if (typeof contentBase64 !== 'string') return { ok: false, error: 'contentBase64 必须是字符串' };
    const b64 = contentBase64.replace(/\s+/g, '');
    if (b64.length > 4000000) {
        return { ok: false, error: '单次二进制写入超过约 3 MB 上限，拒绝' };
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
        return { ok: false, error: 'contentBase64 不是合法的 base64' };
    }
    const buf = Buffer.from(b64, 'base64');
    // 往返自检：Buffer.from 对垃圾输入不报错、只静默丢字节——这是刻意补的一道防线，避免
    // "看起来正常、实际有损"地写坏二进制文件（本仓库栽过同一类"静默写坏"的地雷）。
    if (buf.toString('base64') !== b64) {
        return { ok: false, error: 'base64 解码结果与输入不一致，拒绝写入（避免静默写坏文件）' };
    }
    const cp = skipCheckpoint
        ? { available: false, checkpoint: null, warning: '本次写入按调用方要求跳过了检查点' }
        : await fsGitCheckpoint(projectDir, 'write-binary ' + relPath);
    try { fs.mkdirSync(path.dirname(r.resolved), { recursive: true }); }
    catch (e) { return Object.assign({ ok: false, error: '创建父目录失败: ' + e.message }, checkpointFields(cp)); }
    try { fs.writeFileSync(r.resolved, buf); }
    catch (e) { return Object.assign({ ok: false, error: '写入失败: ' + e.message }, checkpointFields(cp)); }
    // v2 Pass P133b 收口2：落盘自检——本端点的全部意义就是"原样字节落盘"，所以直接读回来
    // 逐字节比一遍（上面的 4,000,000 字符 base64 上限保证读回量 ≲3 MB）。对不上一律 ok:false。
    let back = null;
    try { back = fs.readFileSync(r.resolved); } catch (e) { back = null; }
    if (!back) {
        return Object.assign({ ok: false, code: 'WRITE_BINARY_NOT_EFFECTIVE', error: '写入未生效：调用没有报错，但磁盘上读不到这个文件: ' + relPath }, checkpointFields(cp));
    }
    if (back.length !== buf.length || !back.equals(buf)) {
        return Object.assign({ ok: false, code: 'WRITE_BINARY_NOT_EFFECTIVE', error: '写入未生效：读回的 ' + back.length + ' 字节与待写的 ' + buf.length + ' 字节不一致（拒绝谎报成功）' }, checkpointFields(cp));
    }
    let newMtimeMs = null;
    try { newMtimeMs = fs.statSync(r.resolved).mtimeMs; } catch (e) {}
    return Object.assign({ ok: true, path: relPath, bytesWritten: buf.length, mtimeMs: newMtimeMs }, checkpointFields(cp));
}

async function doFsMkdir(projectDir, relPath) {
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    const cp = await fsGitCheckpoint(projectDir, 'mkdir ' + relPath);
    try { fs.mkdirSync(r.resolved, { recursive: true }); }
    catch (e) { return Object.assign({ ok: false, error: '建目录失败: ' + e.message }, checkpointFields(cp)); }
    // v2 Pass P133b 收口2：落盘自检——建完必须真的是一个目录。
    let stMk = null;
    try { stMk = fs.statSync(r.resolved); } catch (e) { stMk = null; }
    if (!stMk || !stMk.isDirectory()) {
        return Object.assign({ ok: false, code: 'MKDIR_NOT_EFFECTIVE', error: '建目录未生效：调用没有报错，但磁盘上没有出现这个目录: ' + relPath }, checkpointFields(cp));
    }
    return Object.assign({ ok: true, path: relPath }, checkpointFields(cp));
}

async function doFsMove(projectDir, fromRel, toRel) {
    const rf0 = resolveInProject(projectDir, fromRel);
    if (!rf0.ok) return { ok: false, error: '来源路径: ' + rf0.error };
    const rt0 = resolveInProject(projectDir, toRel);
    if (!rt0.ok) return { ok: false, error: '目标路径: ' + rt0.error };
    return withPathLocks([rf0.resolved, rt0.resolved], () => doFsMoveImpl(projectDir, fromRel, toRel)); // v2 Pass P214 SERVER-1
}
async function doFsMoveImpl(projectDir, fromRel, toRel) {
    const rf = resolveInProject(projectDir, fromRel);
    if (!rf.ok) return { ok: false, error: '来源路径: ' + rf.error };
    const rt = resolveInProject(projectDir, toRel);
    if (!rt.ok) return { ok: false, error: '目标路径: ' + rt.error };
    if (!fs.existsSync(rf.resolved)) return { ok: false, error: '来源不存在: ' + fromRel };
    if (fs.existsSync(rt.resolved)) return { ok: false, error: '目标已存在，拒绝覆盖: ' + toRel };
    const affected = collectAffectedRelPaths(rf.base, rf.resolved);
    const cp = await fsGitCheckpoint(projectDir, 'move ' + fromRel + ' -> ' + toRel);
    try { fs.mkdirSync(path.dirname(rt.resolved), { recursive: true }); } catch (e) { /* 后面 rename 会自己报错 */ }
    try { fs.renameSync(rf.resolved, rt.resolved); }
    catch (e) { return Object.assign({ ok: false, error: '移动失败: ' + e.message }, checkpointFields(cp)); }
    // v2 Pass P133b 收口2：落盘自检——移动/改名完成后来源必须消失、目标必须出现。
    // （fs.renameSync 走 libuv、对非 ASCII 路径本来就正常，这里是统一的"不成功不报成功"兜底。）
    if (fsPathStillThere(rf.resolved) || !fsPathStillThere(rt.resolved)) {
        return Object.assign({
            ok: false, code: 'MOVE_NOT_EFFECTIVE',
            error: '移动/改名未生效：调用没有报错，但磁盘上' +
                (fsPathStillThere(rf.resolved) ? '来源「' + fromRel + '」仍然存在' : '') +
                (fsPathStillThere(rf.resolved) && !fsPathStillThere(rt.resolved) ? '、且' : '') +
                (!fsPathStillThere(rt.resolved) ? '目标「' + toRel + '」没有出现' : '')
        }, checkpointFields(cp));
    }
    return Object.assign({ ok: true, from: fromRel, to: toRel, affected: affected }, checkpointFields(cp));
}

async function doFsCopy(projectDir, fromRel, toRel) {
    const rf = resolveInProject(projectDir, fromRel);
    if (!rf.ok) return { ok: false, error: '来源路径: ' + rf.error };
    const rt = resolveInProject(projectDir, toRel);
    if (!rt.ok) return { ok: false, error: '目标路径: ' + rt.error };
    if (!fs.existsSync(rf.resolved)) return { ok: false, error: '来源不存在: ' + fromRel };
    if (fs.existsSync(rt.resolved)) return { ok: false, error: '目标已存在，拒绝覆盖: ' + toRel };
    const cp = await fsGitCheckpoint(projectDir, 'copy ' + fromRel + ' -> ' + toRel);
    try { fs.mkdirSync(path.dirname(rt.resolved), { recursive: true }); }
    catch (e) { return Object.assign({ ok: false, error: '创建目标父目录失败: ' + e.message }, checkpointFields(cp)); }
    // v2 Pass P133b 收口2：原来这里是 fs.cpSync——它在 Windows 上对含非 ASCII 字符的路径会把
    // 目标建到"乱码路径"上（回 ok 却什么都没复制），中文来源目录甚至直接让进程 0xC0000409 崩掉。
    // 见 fsRemoveTree 头部的根因注释；fsCopyTree 走 fs.promises.cp 并自带落盘校验。
    const cpRes = await fsCopyTree(rf.resolved, rt.resolved);
    if (!cpRes.ok) {
        return Object.assign({ ok: false, code: cpRes.code, error: '复制失败: ' + cpRes.error }, checkpointFields(cp));
    }
    const affected = collectAffectedRelPaths(rt.base, rt.resolved);
    return Object.assign({ ok: true, from: fromRel, to: toRel, affected: affected }, checkpointFields(cp));
}

async function doFsDelete(projectDir, relPath) {
    const r0 = resolveInProject(projectDir, relPath);
    if (!r0.ok) return { ok: false, error: r0.error };
    return withPathLocks([r0.resolved], () => doFsDeleteImpl(projectDir, relPath)); // v2 Pass P214 SERVER-1
}
async function doFsDeleteImpl(projectDir, relPath) {
    const r = resolveInProject(projectDir, relPath);
    if (!r.ok) return { ok: false, error: r.error };
    if (!fs.existsSync(r.resolved)) return { ok: false, error: '路径不存在: ' + relPath };
    if (r.resolved === r.base) return { ok: false, error: '拒绝删除项目根目录本身' };
    const affected = collectAffectedRelPaths(r.base, r.resolved);
    const cp = await fsGitCheckpoint(projectDir, 'delete ' + relPath);
    // v2 Pass P133b 收口2：原来这里是 fs.rmSync——它在 Windows 上对含非 ASCII 字符的路径
    // 既可能"静默什么都不删还不抛异常"（于是这里回 ok:true 谎报删除成功），也可能删掉那条
    // 乱码路径上碰巧存在的**别的**文件/目录。见 fsRemoveTree 头部的根因注释。
    const rmRes = await fsRemoveTree(r.resolved, { force: false });
    if (!rmRes.ok) {
        return Object.assign({ ok: false, code: rmRes.code, error: '删除失败: ' + rmRes.error }, checkpointFields(cp));
    }
    return Object.assign({ ok: true, path: relPath, affected: affected }, checkpointFields(cp));
}

// 递归删除 root 下面因为 doFsRestore 删文件而产生的空目录（跳过 .git，且从不删 root 自己）。
// 纯尽力而为：git 本来就不追踪空目录，这一步只是让恢复后的目录树看起来更干净，
// 不是恢复语义正确性的一部分，失败了也不影响 doFsRestore 的主流程。
function pruneEmptyDirs(root) {
    (function walk(dir) {
        let names;
        try { names = fs.readdirSync(dir); } catch (e) { return; }
        names.forEach((name) => {
            if (name === '.git') return;
            const full = path.join(dir, name);
            let st;
            try { st = fs.statSync(full); } catch (e) { return; }
            if (!st.isDirectory()) return;
            walk(full);
            try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full); } catch (e) {}
        });
    })(root);
}

// 回退一次性删除文件数超过这个阈值就触发熔断，默认拒绝执行，要求调用方显式传 force:true。
// 取值理由：这次事故里静默删除了 248 个文件——熔断阈值必须远低于这个量级才有意义；
// 但正常使用中「删除一个中等大小的子目录再回退」之类的操作，一次牵涉几个到十几个文件很
// 常见，阈值太低会导致熔断变成噪音、用户被迫每次都加 force，反而养成无脑加 force 的习惯。
// 取 30 作为折中：小到能在 248 这个事故量级面前提供实质性拦截，大到不会误伤"删掉一个装了
// 十来个素材文件的 figures 子目录"这种日常操作。
const FS_RESTORE_DELETE_CIRCUIT_BREAKER = 30;

// v2 Pass P41：/fs/restore —— 把工作区恢复到某个 fsGitCheckpoint() 返回过的检查点当时
// 的快照。checkpoint 既可以是旁路 ref 的 commit hash，也可以是任何 git 能识别的
// commit-ish（比如 refs/ovl-checkpoints/<id> 本身）。
//
// v2 Pass P46（本次修复）：原实现「工作区有、快照没有 ⇒ 删」这条规则本身就是这次数据
// 丢失事故的第二个缺陷——一个残缺快照会被当成"这些文件都是快照之后新建的"，然后真的删掉。
// 修复后的语义（opts = { dryRun, force }，均可省略，默认 false）：
//   0. 先决安全闸门：拿到目标快照的文件清单后，如果当前 HEAD 存在，就把"当前 HEAD 里
//      已跟踪、且工作区里仍然存在、但目标快照里没有"的文件单独挑出来（headOnlyMissing）。
//      这批文件如果不为空，直接判定为"快照本身有问题"，整个恢复中止、不删除任何文件、
//      明确中文报错列出这些路径——绝不当成"这些文件是快照之后新建的"去删。这是本次修复
//      的核心：一个文件在 HEAD 里存在，就永远不能被本函数当成"待删除的新建文件"处理。
//   1. dryRun:true 时，只计算并返回将要发生的变更清单（willDelete / willCreate /
//      willOverwrite），不打检查点、不碰任何磁盘文件，供前端在真正执行前把确切影响面
//      摆给用户确认。
//   2. 熔断：willDelete 清单长度超过 FS_RESTORE_DELETE_CIRCUIT_BREAKER 时，非 dryRun
//      调用且没有传 force:true 一律拒绝执行，返回 requiresForce:true + 完整清单（前端可以
//      直接把这份清单当成确认对话框的内容，不用再发一次 dryRun 请求）。
//   3. 实际执行：先对"恢复前的当前状态"调用 fsGitCheckpoint() 打一个检查点——回退这个
//      动作自己也可以再回退。然后删除 willDelete 里的文件（recursive prune 顺手清掉因此
//      产生的空目录），再用一次性临时索引 `git read-tree <目标tree>` + `git checkout-index
//      -a -f` 把目标快照内容写回工作区。全程仍然不碰真实的 .git/index，也不移动当前分支。
// 已知差异（如实说明，不是"完全等价"）：
//   - 文件权限位（比如可执行位）不保证复原——checkout-index 写普通文件不保留 tree 里的
//     可执行位以外的位（Windows 文件系统本来也没有 Unix 权限位的概念，这条在本项目的
//     实际运行环境下影响可以忽略，但如实记录）。
//   - 恢复后残留的空目录清理是尽力而为（pruneEmptyDirs 内部吞掉异常），极端情况下
//     （比如某个空目录被占用无法删除）可能留下一个 git 本来就不追踪的空目录，不影响
//     任何文件内容的正确性。
function doFsRestore(projectDir, checkpointRef, opts) {
    return withProjectLock(projectDir, () => doFsRestoreImpl(projectDir, checkpointRef, opts));
}
async function doFsRestoreImpl(projectDir, checkpointRef, opts) {
    opts = opts || {};
    const dryRun = !!opts.dryRun;
    const force = !!opts.force;

    if (typeof checkpointRef !== 'string' || !checkpointRef.trim()) {
        return { ok: false, error: 'checkpoint 缺失' };
    }
    const treeCheck = await runGitCommand(['rev-parse', '--is-inside-work-tree'], projectDir, null, FS_GIT_TIMEOUT_MS);
    if (!treeCheck.ok || treeCheck.stdout.trim() !== 'true') {
        return { ok: false, error: '该目录不是 git 仓库（或不在 git 工作树内），无法恢复。' };
    }
    const targetTreeResult = await runGitCommand(['rev-parse', '--verify', checkpointRef + '^{tree}'], projectDir, null, FS_GIT_TIMEOUT_MS);
    if (!targetTreeResult.ok) {
        return { ok: false, error: '找不到该检查点，或它不是一个有效的提交: ' + (targetTreeResult.stderr || targetTreeResult.stdout || '未知错误') };
    }
    const targetTree = targetTreeResult.stdout.trim();

    const targetFiles = new Set(await fsListTreeFiles(projectDir, targetTree));
    const currentFiles = collectAffectedRelPaths(projectDir, projectDir).map((p) => p.split(path.sep).join('/'));
    const currentSet = new Set(currentFiles);

    // 待删除候选：当前有、目标快照没有的文件。
    let deleteCandidates = currentFiles.filter((rel) => !targetFiles.has(rel));

    // v2 Pass P74 §7.2：被 .gitignore 忽略的文件从来不会出现在任何检查点树里，旧实现会把
    // 它们全部当成"检查点之后新建的、可以删"——node_modules/、tests/reports/、.bridge-token、
    // 以及 PDF→LaTeX 的输出目录都会被一次回退整个删掉（今天已经在删 .bridge-token）。这里
    // 显式把它们排除在删除名单之外。
    let skippedIgnored = [];
    let ignoreWarning = null;
    const ign = await runGitCommand(['ls-files', '-o', '-i', '--exclude-standard', '-z'],
        projectDir, null, FS_GIT_TIMEOUT_MS);
    if (ign.ok) {
        const list = ign.stdout.split('\0').filter((s) => s.length > 0);
        if (list.length > 200000) {
            ignoreWarning = '被忽略的文件超过 20 万个，未做忽略判定（按旧行为处理）。';
        } else {
            const ignoredSet = new Set(list);
            skippedIgnored = deleteCandidates.filter((rel) => ignoredSet.has(rel));
            deleteCandidates = deleteCandidates.filter((rel) => !ignoredSet.has(rel));
        }
    } else {
        ignoreWarning = '无法判定哪些文件被 .gitignore 忽略（git ls-files 执行失败：'
            + (ign.stderr || ign.stdout || '未知').slice(0, 200) + '），本次按旧行为处理。';
    }

    // 安全闸门：这批候选里，有哪些其实是 HEAD 里已跟踪的文件——如果有，说明快照残缺，
    // 不是"这些文件是快照之后新建的"，整个恢复必须中止，一个文件都不许删。
    const headResult = await runGitCommand(['rev-parse', 'HEAD'], projectDir, null, FS_GIT_TIMEOUT_MS);
    const headHash = headResult.ok ? headResult.stdout.trim() : null;
    let headOnlyMissing = [];
    if (headHash) {
        const headFiles = new Set(await fsListTreeFiles(projectDir, headHash));
        headOnlyMissing = deleteCandidates.filter((rel) => headFiles.has(rel));
    }
    if (headOnlyMissing.length > 0) {
        return {
            ok: false,
            error: '拒绝恢复：检查点快照缺少 ' + headOnlyMissing.length + ' 个当前 HEAD 中已跟踪、工作区里也确实存在的文件' +
                '（例如: ' + headOnlyMissing.slice(0, 5).join(', ') + (headOnlyMissing.length > 5 ? ' 等' : '') + '）。' +
                '这说明该检查点快照本身不完整/不可信，不是"这些文件是检查点之后新建的"——为避免误删已跟踪文件，' +
                '本次恢复已整体中止，未删除任何文件。请改用其它检查点，或先确认该检查点是否可信。',
            headOnlyMissing: headOnlyMissing
        };
    }

    const willDelete = deleteCandidates; // 此时已确认里面不含任何 HEAD 已跟踪文件，可以安全删除。
    const willCreate = Array.from(targetFiles).filter((rel) => !currentSet.has(rel));
    const willOverwrite = Array.from(targetFiles).filter((rel) => currentSet.has(rel));

    if (dryRun) {
        return {
            ok: true,
            dryRun: true,
            restoredTo: checkpointRef,
            willDelete: willDelete,
            willCreate: willCreate,
            willOverwrite: willOverwrite,
            requiresForce: willDelete.length > FS_RESTORE_DELETE_CIRCUIT_BREAKER,
            circuitBreakerThreshold: FS_RESTORE_DELETE_CIRCUIT_BREAKER,
            skippedIgnored: skippedIgnored,
            ignoreWarning: ignoreWarning
        };
    }

    if (willDelete.length > FS_RESTORE_DELETE_CIRCUIT_BREAKER && !force) {
        return {
            ok: false,
            error: '拒绝执行：本次恢复将删除 ' + willDelete.length + ' 个文件，超过熔断阈值（' +
                FS_RESTORE_DELETE_CIRCUIT_BREAKER + '）。如确认要继续，请显式传 force:true 重新调用。',
            requiresForce: true,
            willDelete: willDelete,
            willCreate: willCreate,
            willOverwrite: willOverwrite,
            circuitBreakerThreshold: FS_RESTORE_DELETE_CIRCUIT_BREAKER,
            skippedIgnored: skippedIgnored,
            ignoreWarning: ignoreWarning
        };
    }

    // 恢复前先给当前状态打一个检查点，保证这次恢复本身也可回退。
    const preCp = await fsGitCheckpoint(projectDir, 'before restore to ' + checkpointRef);

    // v2 Pass P133b 收口2：原来这里是 fs.rmSync + "只要没抛异常就 push 进 removedExtraFiles"。
    // 在 Windows 上含非 ASCII 字符的路径根本没被删掉（rmSync 静默返回），于是 removedExtraFiles
    // 会把一堆其实还躺在磁盘上的文件报成"已删除"；更糟的是那条乱码路径上碰巧存在别的文件时会
    // 删错东西。见 fsRemoveTree 头部的根因注释。现在只有**确认真的没了**才记进 removedExtraFiles，
    // 删不掉的单独进 failedToRemove 并在响应里给出警告，不再谎报。
    const removedExtraFiles = [];
    const failedToRemove = [];
    for (const rel of willDelete) {
        const res = await fsRemoveTree(path.join(projectDir, rel.split('/').join(path.sep)), { force: true });
        if (res.ok) removedExtraFiles.push(rel);
        else failedToRemove.push({ path: rel, error: res.error });
    }
    try { pruneEmptyDirs(projectDir); } catch (e) {}

    const tmpIndex = fsTempIndexPath();
    try {
        const extraEnv = { GIT_INDEX_FILE: tmpIndex, GIT_WORK_TREE: projectDir };
        const readTreeResult = await runGitCommand(['read-tree', targetTree], projectDir, null, FS_GIT_TIMEOUT_MS, extraEnv);
        if (!readTreeResult.ok) {
            return Object.assign({ ok: false, error: '恢复失败（git read-tree）：' + (readTreeResult.stderr || readTreeResult.stdout || '未知错误') }, checkpointFields(preCp));
        }
        const checkoutResult = await runGitCommand(['checkout-index', '-a', '-f'], projectDir, null, FS_GIT_TIMEOUT_MS, extraEnv);
        if (!checkoutResult.ok) {
            return Object.assign({ ok: false, error: '恢复失败（git checkout-index）：' + (checkoutResult.stderr || checkoutResult.stdout || '未知错误') }, checkpointFields(preCp));
        }
    } finally {
        try { fs.unlinkSync(tmpIndex); } catch (e) {}
    }

    return Object.assign({
        ok: true,
        restoredTo: checkpointRef,
        filesRestored: targetFiles.size,
        removedExtraFiles: removedExtraFiles,
        // v2 Pass P133b 收口2：删不掉的多余文件如实单列，绝不混进 removedExtraFiles 冒充已删除。
        failedToRemove: failedToRemove,
        removeWarning: failedToRemove.length
            ? ('有 ' + failedToRemove.length + ' 个检查点之后新建的多余文件没能删掉（例如: ' +
                failedToRemove.slice(0, 5).map((x) => x.path).join(', ') + (failedToRemove.length > 5 ? ' 等' : '') +
                '），它们仍然留在工作区里；检查点里的文件已按快照恢复。')
            : null,
        skippedIgnored: skippedIgnored,
        ignoreWarning: ignoreWarning,
        note: '已恢复到检查点当时的文件内容。已知差异：不保证复原文件权限位；恢复后残留空目录的清理是尽力而为。'
    }, checkpointFields(preCp));
}

// 只用于 /overleaf/* 这三个能动用户真实 git 仓库的路由：拒绝来自任意网页的跨域驱动。
// 浏览器发起跨域 fetch 时一定会带 Origin 头且不可伪造，所以白名单足以挡住恶意页面；
// 没有 Origin 头的（curl / node 脚本 / 本地测试）放行，因为那本来就不是这条攻击链。
// v2 Pass P49 补充定位：这道 Origin 检查在本地模式下仍然是真实防线（同源浏览器页面
// 才带得出白名单里的 Origin）；但在 REMOTE_MODE 下它形同虚设——file:// 页面的 Origin
// 恒为 "null" 本来就放行，任何能拿到令牌的调用方也天然能带上任意 Origin。REMOTE_MODE
// 下真正的防线是上面路由分发前的 tokenAuthorized() 令牌闸门，这个函数不再是防线本身，
// 只是本地模式下的历史防线，保留不动。
function ovlOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;              // 非浏览器发起
    if (origin === 'null') return true;    // file:// 页面（本 App 的正常打开方式）
    // v2 Pass P110c（核验第 3 轮 IX2-a 连带发现并修复）：页面就是从桥自己的地址加载的——
    // REMOTE_MODE 下这条同源请求以前会被下面那条只认 localhost/127.0.0.1 的白名单当成
    // "外部网页跨站发起"一律拒掉（实测：GET http://<桥地址>/ 打开整个应用后，哪怕访问令牌
    // 填对了，POST /fs/* 一律 403，P110 主打的"同网设备浏览器直接打开使用"这条路径的文件
    // 操作完全不可用）。真正的防线本来就是上面路由分发前的 tokenAuthorized() 令牌闸门，这里
    // 放行"桥自己服务的页面发起的同源请求"不会削弱那条防线，只是不再误伤合法用法。
    if (origin === SELF_ORIGIN) return true;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

// v2 Pass P214 S-B：以前只有 /fs/*、/overleaf/*、/admin/restart 过 ovlOriginAllowed；下面这些同样有
// 副作用的 POST 端点没有——跨站页面用不触发预检的 text/plain POST 就能发起编译、清缓存、杀掉正在跑的
// 编译、弹出文件夹选择框。统一在路由分发前挡一道。放行规则不变：无 Origin（curl）、"null"（file://
// 打开的 App）、桥自己服务的页面（SELF_ORIGIN）、localhost/127.0.0.1。
const ORIGIN_GATED_POST_PATHS = new Set([
    '/pick-folder', '/compile', '/stop', '/wordcount', '/clear',
    '/synctex/forward', '/synctex/edit', '/synctex/rehydrate'
]);


// ---------------------------------------------------------------------------
// v2 Pass P222：配置同步存储（多台电脑共享同一份"在线版"配置）。
//
// 存的是前端 localStorage 的原始字符串，键名走服务器端白名单（精确名 + 文档化的一个族），
// 其余一律 400。数据文件：<DATA_DIR>/config-sync.json，DATA_DIR 默认 <serve 根>/data
// （deploy-jump.sh 只覆盖它清单里的 8 个文件，不碰兄弟目录 data/），可用 LATEX_BRIDGE_DATA_DIR 覆盖。
// 没有任何路由会把 data/ 下的文件当静态文件吐出去（路由全是写死的），GET /data/... 恒为 404。
// 写盘：tmp + fsync + rename（原子）；覆盖前把旧文件复制成 config-sync.prev.json；每天第一次写入
// 前把"当天开始时的状态"存进 snapshots/YYYYMMDD.json，只留最近 14 份。加载失败（缺失/损坏）依次
// 退回 .prev、空仓，并打日志。
// ---------------------------------------------------------------------------
const SYNC_DATA_DIR = process.env.LATEX_BRIDGE_DATA_DIR
    ? path.resolve(process.env.LATEX_BRIDGE_DATA_DIR)
    : path.join(__dirname, '..', '..', 'data');
const SYNC_FILE = path.join(SYNC_DATA_DIR, 'config-sync.json');
const SYNC_PREV_FILE = path.join(SYNC_DATA_DIR, 'config-sync.prev.json');
const SYNC_SNAP_DIR = path.join(SYNC_DATA_DIR, 'snapshots');
const SYNC_KEY_MAX_BYTES = 1024 * 1024;
const SYNC_STORE_MAX_BYTES = 8 * 1024 * 1024;
const SYNC_SNAP_KEEP = 14;
const SYNC_KEYS_EXACT = new Set([
    'ovl.termDbByPathRemote', 'ovl.termDbGlobal', 'ovl.termDbGlossaryMigratedRemote',
    'ovl.paperCardByPathRemote', 'ovl.projectDomainHintByPathRemote', 'ovl.projectGlossaryByPathRemote',
    'ovl.overleafAddrByPathRemote', 'ovl.pdf2texMapRemote', 'ovlProjectHistoryRemote',
    'chatArchive', 'ovl.settings', 'ovl.compileSettings',
    'apiProvider', 'selectedModel', 'modelVisibility', 'reasoningByModel', 'showDatedSnapshots',
    'ovl.builderModel', 'chatParams', 'chatSurfaceDefaults', 'customPrompts', 'synonymDefaultMode',
    'historyLimit', 'autoSaveInterval', 'localBaseUrl', 'qwenBaseUrl', 'claudeProxyUrl',
    'geminiApiKey', 'openaiApiKey', 'claudeApiKey', 'qwenApiKey'
]);
const SYNC_KEY_FAMILY_RE = /^qwen[A-Za-z0-9_]{0,40}ByModel$/;
function syncKeyAllowed(k) {
    return typeof k === 'string' && (SYNC_KEYS_EXACT.has(k) || SYNC_KEY_FAMILY_RE.test(k));
}

let syncStore = { version: 0, keys: {} };
let syncWss = null; // 由文件末尾 WebSocket.Server 初始化后赋值；没装 ws 时保持 null，广播静默跳过

function syncValidShape(o) {
    return !!(o && typeof o === 'object' && o.keys && typeof o.keys === 'object' && !Array.isArray(o.keys)
        && Number.isFinite(o.version));
}
function syncLoadFile(f) {
    const raw = fs.readFileSync(f, 'utf8');
    const o = JSON.parse(raw);
    if (!syncValidShape(o)) throw new Error('bad shape');
    return o;
}
function syncLoadStore() {
    let st = null;
    const cands = [[SYNC_FILE, 'config-sync.json'], [SYNC_PREV_FILE, 'config-sync.prev.json']];
    for (let i = 0; i < cands.length; i++) {
        const f = cands[i][0], label = cands[i][1];
        if (!fs.existsSync(f)) continue;
        try {
            st = syncLoadFile(f);
            if (i > 0) console.warn('[latex-bridge] config-sync.json 缺失/损坏，已从 ' + label + ' 恢复');
            break;
        } catch (e) { console.warn('[latex-bridge] 读取 ' + label + ' 失败：' + (e && e.message)); }
    }
    if (!st) {
        st = { version: 0, keys: {} };
        if (fs.existsSync(SYNC_FILE)) console.warn('[latex-bridge] config-sync 无可用备份，按空仓启动');
    }
    let maxV = st.version;
    for (const k of Object.keys(st.keys)) {
        const e = st.keys[k];
        if (!syncKeyAllowed(k) || !e || typeof e !== 'object' || !Number.isFinite(e.v)) { delete st.keys[k]; continue; }
        if (e.v > maxV) maxV = e.v;
    }
    st.version = maxV;
    syncStore = st;
}
function syncWriteAtomic(file, text) {
    const tmp = file + '.tmp-' + process.pid;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, text, 0, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
}
function syncDayStamp() {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + p2(d.getMonth() + 1) + p2(d.getDate());
}
function syncPersist() {
    fs.mkdirSync(SYNC_DATA_DIR, { recursive: true });
    if (fs.existsSync(SYNC_FILE)) {
        try {
            fs.mkdirSync(SYNC_SNAP_DIR, { recursive: true });
            const snap = path.join(SYNC_SNAP_DIR, syncDayStamp() + '.json');
            if (!fs.existsSync(snap)) fs.copyFileSync(SYNC_FILE, snap);
            const names = fs.readdirSync(SYNC_SNAP_DIR).filter((n) => /^\d{8}\.json$/.test(n)).sort();
            while (names.length > SYNC_SNAP_KEEP) { try { fs.unlinkSync(path.join(SYNC_SNAP_DIR, names.shift())); } catch (e) { break; } }
        } catch (e) { console.warn('[latex-bridge] config-sync 日快照失败：' + (e && e.message)); }
        try { fs.copyFileSync(SYNC_FILE, SYNC_PREV_FILE); } catch (e) { console.warn('[latex-bridge] config-sync.prev 备份失败：' + (e && e.message)); }
    }
    syncWriteAtomic(SYNC_FILE, JSON.stringify(syncStore));
}
function syncStoreBytes(st) {
    let n = 0;
    for (const k of Object.keys(st.keys)) { const v = st.keys[k].value; if (typeof v === 'string') n += Buffer.byteLength(v, 'utf8'); }
    return n;
}
function syncBroadcast(msg) {
    if (!syncWss) return;
    const text = JSON.stringify(msg);
    syncWss.clients.forEach(function (c) { try { if (c.readyState === 1) c.send(text); } catch (e) {} });
}
function syncPick(entry) { return { v: entry.v, updatedAt: entry.updatedAt, by: entry.by, value: entry.value }; }
try { syncLoadStore(); } catch (e) { console.warn('[latex-bridge] config-sync 初始化失败，按空仓运行：' + (e && e.message)); }

// ---------------------------------------------------------------------------
// HTTP 路由
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
    // v2 Pass P98：逐请求日志——注册在最前面，覆盖包括 OPTIONS 预检在内的一切请求，收尾
    // （res 'finish'）时兜底打一行。具体路由处理完之后可以把更精确的 target/jobId/outcome
    // 写进 req._log*（目前只有 /compile 这么做），没写就按状态码粗略推断 outcome。
    const _logStartedAt = Date.now();
    res.on('finish', () => {
        const outcome = req._logOutcome || (res.statusCode < 400 ? 'ok' : ('error(HTTP ' + res.statusCode + ')'));
        logRequest({
            method: req.method,
            pathname: req._logPathname != null ? req._logPathname : req.url,
            target: req._logTarget || null,
            jobId: req._logJobId || null,
            outcome: outcome,
            durationMs: Date.now() - _logStartedAt
        });
    });

    cors(req, res);

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // v2 Pass P110 核验返修（I3）：这两行原来在 try 块之外、且在令牌闸门之前——未鉴权即可远程
    // 触发（GET // 让 new URL() 抛 TypeError，GET /% 让 decodeURIComponent() 抛 URIError），
    // 全文又没有 unhandledRejection/uncaughtException 兜底，会直接把整个 Node 进程崩掉退出。
    // 实测：地址栏多打一个斜杠（.../8181//）就能把桥打死，tailnet 上任何人都不需要令牌。
    // 单独包一层 try/catch，格式非法就回 400，不再让请求解析阶段的异常有机会冒到进程顶层。
    let u, pathname;
    try {
        u = new URL(req.url, 'http://' + HOST + ':' + PORT);
        pathname = decodeURIComponent(u.pathname);
    } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求路径格式非法' });
        return;
    }
    req._logPathname = pathname;

    // v2 Pass P49：统一令牌校验闸门——REMOTE_MODE 下除 TOKEN_EXEMPT_PATHS 里的路径外，
    // 一切路由都要求正确的访问令牌，放在路由分发之前一次性挡住，不用逐个端点手动加。
    // v2 Pass P110b（IX1）：豁免集在 P110 已扩到 5 条（/health、/、/AI-Translator.html、
    // /routes、/favicon.ico，见 233 行 TOKEN_EXEMPT_PATHS），不再只是 /health、GET /——
    // 改这个 Set 时记得同步改上面 REMOTE_MODE 启动横幅那句话，那是用户唯一会读到的鉴权说明。
    // 本地默认模式（REMOTE_MODE=false）tokenAuthorized 恒真，这段代码不改变任何现有行为。
    if (!TOKEN_EXEMPT_PATHS.has(pathname) && !tokenAuthorized(req)) {
        sendJson(res, 401, { ok: false, error: '缺少或错误的访问令牌，请在设置里填写桥启动日志打印的访问令牌' });
        return;
    }

    try {
        if (req.method === 'GET' && pathname === '/health') {
            const healthBody = {
                ok: true,
                pid: process.pid,
                node: process.version,
                latexmkExists: fs.existsSync(LATEXMK),
                // v2 Pass P45：能力/版本自报——前端判断"这个桥支不支持某个新功能"必须靠这里，
                // 不能靠解析下面 GET / 那段人读的文字列表（刚出过 P44 加了 /fs/capabilities
                // 却漏更新那段文字的事故，字符串列表跟真实路由不同步这类问题不会自愈）。
                // 老版本桥（这个字段加入之前编译、没重启过）压根不会返回这两个字段——前端那边
                // 的判定必须把"字段缺失"当成"旧桥、什么都不支持"处理，不能因为缺字段就报错
                // 或者误判成新桥（这个推断方向是单向且安全的：新桥必然带字段，缺字段只可能
                // 是旧桥，不可能反过来）。
                bridgeApiVersion: BRIDGE_API_VERSION,
                bridgeCapabilities: BRIDGE_CAPABILITIES,
                // v2 Pass P154：/health 在 TOKEN_EXEMPT_PATHS 里免令牌，任何能连上这个地址的人
                // 都能读到它——默认只播报"启不启用"，不回显具体根路径，避免顺带泄露服务器磁盘
                // 上的敏感目录结构给完全没有令牌的探测者。真正需要具体根路径列表来渲染"预设
                // 位置"按钮的是已经持有合法令牌的前端本身——tokenAuthorized(req) 是纯函数，跟
                // 这条路由要不要强制要求令牌无关，这里只是"如果这次请求恰好带对了令牌，就多给
                // 一点信息"，不改变 /health 本身免令牌可访问这件事。
                fsRootAllowlist: { enabled: ALLOWED_ROOTS_ENABLED }
            };
            if (ALLOWED_ROOTS_ENABLED && tokenAuthorized(req)) {
                healthBody.fsRootAllowlist.roots = ALLOWED_ROOTS_DISPLAY;
            }
            // v2 Pass P49：/health 在 REMOTE_MODE 下豁免令牌校验（前端要靠它探活），所以绝不能
            // 顺带泄露本机敏感路径——latexmkPath/workRoot 只在本地模式下返回。
            if (!REMOTE_MODE) {
                healthBody.latexmkPath = LATEXMK;
                healthBody.workRoot = WORK_ROOT;
                // v2 Pass P53：本地模式下把"克隆存放位置"弹窗的默认父目录告诉前端——跟
                // doOverleafClone 不传 parentDir/folderName 时用的默认根目录是同一个值，
                // 只是这里提前算出来给用户看、允许他改，不代表任何写操作。
                healthBody.defaultOverleafCloneRoot = defaultOverleafCloneRoot();
            }
            sendJson(res, 200, healthBody);
            return;
        }

        // v2 Pass P110：GET / 和 GET /AI-Translator.html 都直接把整个 App 页面 serve 出去——
        // 同网内任何设备打开 http(s)://<桥地址>/ 就能用整个 App，不用再手动往目标机器拷一份
        // AI-Translator.html。旧版这里是一句纯文本端点列表（诊断用），改造后端点列表挪到
        // GET /routes（同样豁免令牌，纯诊断，不影响任何现有调用点——全仓库搜过，没有代码
        // 依赖 GET / 返回那句纯文本）。
        if (req.method === 'GET' && pathname === '/') {
            serveAppHtml(req, res);
            return;
        }
        if (req.method === 'GET' && pathname === '/AI-Translator.html') {
            serveAppHtml(req, res);
            return;
        }
        if (req.method === 'GET' && pathname === '/routes') {
            sendText(res, 200, 'AI-Translator latex-bridge is running. GET /, GET /AI-Translator.html, POST /compile, POST /stop, POST /wordcount, POST /synctex/forward, POST /synctex/edit, POST /synctex/rehydrate, POST /pick-folder, GET /health, GET /output/:id/:file, GET /project-asset?projectDir=&path=, POST /clear, POST /overleaf/pull, POST /overleaf/push, POST /overleaf/clone, POST /overleaf/check-target, POST /fs/list, POST /fs/read, POST /fs/write, POST /fs/write-binary, POST /fs/mkdir, POST /fs/move, POST /fs/copy, POST /fs/delete, POST /fs/restore, POST /fs/capabilities, POST /ws-ticket, POST /admin/restart. WebSocket on same host:port for disk-change push.');
            return;
        }
        // v2 Pass P110：浏览器打开页面会自动请求 favicon.ico——204 是最省事的"没有，但也不算
        // 错误"回应，不占日志噪音、不牵扯任何静态资源。
        if (req.method === 'GET' && pathname === '/favicon.ico') {
            res.writeHead(204);
            res.end();
            return;
        }

        // v2 Pass P17：原生文件夹选择框（POST，不带 body）——见 doPickFolder 头部注释。
        if (req.method === 'POST' && ORIGIN_GATED_POST_PATHS.has(pathname) && !ovlOriginAllowed(req)) {
            sendJson(res, 403, { ok: false, error: '拒绝来自外部网页的请求。这个接口只接受 AI-Translator 页面本身的调用。' });
            return;
        }

        if (req.method === 'POST' && pathname === '/pick-folder') {
            const result = await doPickFolder();
            sendJson(res, 200, result);
            return;
        }

        if (req.method === 'POST' && pathname === '/compile') {
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                req._logOutcome = 'error(invalid JSON body)';
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            const mainFile = body.mainFile || 'main.tex';
            // v2 Pass P98：日志用的 target 只取 basename，不落全路径（跟响应体本身对 projectDir
            // 的处理口径一致，日志量克制，也避免在 stdout 里堆真实用户目录全路径）。
            req._logTarget = (projectDir ? path.basename(projectDir) : '?') + '/' + path.basename(mainFile);
            if (!projectDir || typeof projectDir !== 'string') {
                req._logOutcome = 'error(projectDir required)';
                sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' });
                return;
            }
            // v2 Pass P154：根目录白名单——未设置 LATEX_BRIDGE_ALLOWED_ROOTS 时 rejectIfProjectDirNotAllowed
            // 恒放行，逐字节不改变既有行为。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) { req._logOutcome = 'error(projectDir not allowed)'; return; }
            if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
                req._logOutcome = 'error(projectDir not found)';
                sendJson(res, 400, { ok: false, error: 'projectDir 不存在或不是目录: ' + projectDir });
                return;
            }
            const result = await doCompile(projectDir, mainFile, {
                engine: body.engine,
                mode: body.mode,
                haltOnError: body.haltOnError,
                forceClean: body.forceClean,
                timeoutMs: body.timeoutMs // v2 Pass P91 §5：可选，见 doCompile 内部夹逼逻辑
            });
            req._logJobId = (result && result.id) ? result.id : null;
            req._logOutcome = (result && result.ok) ? 'ok' : ('error:' + String((result && result.error) || '(no pdf)').slice(0, 160));
            sendJson(res, 200, result);
            return;
        }

        // M4「Stop compilation」：杀掉当前正在跑的编译进程树（如果有）。
        if (req.method === 'POST' && pathname === '/stop') {
            if (currentChild) {
                try { killTree(currentChild.pid, currentChildId); } catch (e) {} // v2 Pass P214 SERVER-5
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
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
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
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            if (!line || line < 1) { sendJson(res, 400, { ok: false, error: 'line 必须是正整数' }); return; }
            const mainAbs = resolveMainFileInProject(projectDir, mainFile); // v2 Pass P214 S-C
            if (!mainAbs) { sendJson(res, 400, { ok: false, error: 'mainFile 必须位于项目目录内' }); return; }
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

        // v2 Pass P107：{projectDir, pdfRelPath, synctexRelPath} -> {ok, id, synctexExists}。
        // "编译产物持久缓存"恢复显示时用——把项目内已经落盘的缓存文件（通常是 .ovl-cache/
        // 下的 <key>.pdf + <key>.synctex.gz，路径不强制这个前缀，只要在 projectDir 内）原样
        // 复制进一份新的 WORK_ROOT/<id>/output.pdf + output.synctex.gz，跟 doCompile() 真的
        // 编译一次产出的 outdir 形状完全一样——换回的这个 id 直接喂给现成的 /synctex/forward、
        // /synctex/edit 就能用，不用给这两个端点另开一条"不靠 id"的旁路。只读复制，不跑任何
        // 编译器；路径校验复用 safeProjectAssetPath 同一条防越权纪律（不许跑出 projectDir）。
        // pdfRelPath 缺失/文件不存在直接判失败（缓存显然名不副实）；synctexRelPath 缺失/不存在
        // 静默降级成 synctexExists:false（只有 PDF 没有 synctex 缓存不算错，只是这次恢复的
        // 显示没法用 SyncTeX 跳转）。
        if (req.method === 'POST' && pathname === '/synctex/rehydrate') {
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            if (!projectDir || typeof projectDir !== 'string') {
                sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' });
                return;
            }
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            if (!fs.existsSync(projectDir) || !fs.statSync(projectDir).isDirectory()) {
                sendJson(res, 400, { ok: false, error: 'projectDir 不存在或不是目录: ' + projectDir });
                return;
            }
            const pdfAbs = safeProjectAssetPath(projectDir, body.pdfRelPath);
            if (!pdfAbs) { sendJson(res, 400, { ok: false, error: 'invalid pdfRelPath' }); return; }
            if (!fs.existsSync(pdfAbs) || !fs.statSync(pdfAbs).isFile()) {
                sendJson(res, 404, { ok: false, error: '缓存的 PDF 文件不存在: ' + body.pdfRelPath });
                return;
            }
            let synctexAbs = null;
            if (body.synctexRelPath) {
                const resolved = safeProjectAssetPath(projectDir, body.synctexRelPath);
                if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) synctexAbs = resolved;
            }
            const id = Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex');
            const outdir = path.join(WORK_ROOT, id);
            try {
                fs.mkdirSync(outdir, { recursive: true });
                fs.copyFileSync(pdfAbs, path.join(outdir, 'output.pdf'));
                if (synctexAbs) fs.copyFileSync(synctexAbs, path.join(outdir, 'output.synctex.gz'));
                scheduleWorkRootPrune(id); // v2 Pass P214 SERVER-8
            } catch (e) {
                // v2 Pass P154：OneDrive 占位符人话报错——两个候选源文件里，先看 output.pdf
                // 是不是没落地（没落地说明是 pdfAbs 那次拷贝失败的），落地了就是 synctexAbs
                // 那次失败；describeFileReadError 内部只在 err.code==='UNKNOWN' 且路径含
                // "OneDrive" 时才会真的去探测，探测不到照样原样透传 e.message。
                let failedSrc = pdfAbs;
                try { if (fs.existsSync(path.join(outdir, 'output.pdf'))) failedSrc = (synctexAbs || pdfAbs); } catch (e2) {}
                sendJson(res, 500, { ok: false, error: 'rehydrate failed: ' + describeFileReadError(e, failedSrc) });
                return;
            }
            sendJson(res, 200, { ok: true, id: id, synctexExists: !!synctexAbs });
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
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
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
                // v2 Pass P154：OneDrive 按需占位符人话报错——见 describeFileReadError 头部注释。
                sendJson(res, 404, { ok: false, error: 'read failed: ' + describeFileReadError(e, resolved) });
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
                // v2 Pass P133b 收口2：统一走 fsRemoveTree（禁用 fs.rmSync，见其头部根因注释）。
                // WORK_ROOT 在 os.tmpdir() 下，Windows 用户名含非 ASCII 时整条路径就带非 ASCII。
                await fsRemoveTree(outdir, { force: true });
                sendJson(res, 200, { ok: true, cleared: body.id });
                return;
            }
            // 不带 id：清空全部缓存的编译产物（对应 Overleaf 的 "Clear cached files"）。
            try {
                const entries = fs.readdirSync(WORK_ROOT);
                for (const e of entries) {
                    await fsRemoveTree(path.join(WORK_ROOT, e), { force: true });
                }
            } catch (e) {}
            sendJson(res, 200, { ok: true, clearedAll: true });
            return;
        }

        // v2 Pass P40：/fs/* 受限文件操作端点——见 resolveInProject/fsGitCheckpoint 头部注释。
        // 跟 /overleaf/* 同样能真的改写用户磁盘上的文件，复用同一条跨域白名单纪律。
        if (req.method === 'POST' && (pathname === '/fs/list' || pathname === '/fs/read' || pathname === '/fs/mkdir'
            || pathname === '/fs/write' || pathname === '/fs/write-binary' || pathname === '/fs/move' || pathname === '/fs/copy' || pathname === '/fs/delete'
            || pathname === '/fs/restore' || pathname === '/fs/capabilities')) {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, error: '拒绝来自外部网页的文件操作请求。这些接口只接受 AI-Translator 页面本身的调用。' });
                return;
            }
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            if (!projectDir || typeof projectDir !== 'string') {
                sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' });
                return;
            }
            // v2 Pass P154：根目录白名单——单点覆盖本 if 块下面全部 10 个 /fs/* 子路由
            // （capabilities/list/read/mkdir/write/write-binary/move/copy/delete/restore）。
            // 未设置 LATEX_BRIDGE_ALLOWED_ROOTS 时 rejectIfProjectDirNotAllowed 恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;

            if (pathname === '/fs/capabilities') {
                sendJson(res, 200, await doFsCapabilities(projectDir));
                return;
            }
            if (pathname === '/fs/list') {
                sendJson(res, 200, await doFsList(projectDir, body.path));
                return;
            }
            if (pathname === '/fs/read') {
                if (!body.path || typeof body.path !== 'string') { sendJson(res, 400, { ok: false, error: 'path is required' }); return; }
                sendJson(res, 200, await doFsRead(projectDir, body.path));
                return;
            }
            if (pathname === '/fs/mkdir') {
                if (!body.path || typeof body.path !== 'string') { sendJson(res, 400, { ok: false, error: 'path is required' }); return; }
                sendJson(res, 200, await doFsMkdir(projectDir, body.path));
                return;
            }
            if (pathname === '/fs/write') {
                if (!body.path || typeof body.path !== 'string') { sendJson(res, 400, { ok: false, error: 'path is required' }); return; }
                sendJson(res, 200, await doFsWrite(projectDir, body.path, body.content, body.expectedMtimeMs));
                return;
            }
            if (pathname === '/fs/write-binary') {
                if (!body.path || typeof body.path !== 'string') { sendJson(res, 400, { ok: false, error: 'path is required' }); return; }
                if (typeof body.contentBase64 !== 'string') { sendJson(res, 400, { ok: false, error: 'contentBase64 is required' }); return; }
                sendJson(res, 200, await doFsWriteBinary(projectDir, body.path, body.contentBase64, { skipCheckpoint: !!body.skipCheckpoint }));
                return;
            }
            if (pathname === '/fs/move') {
                if (!body.from || !body.to || typeof body.from !== 'string' || typeof body.to !== 'string') {
                    sendJson(res, 400, { ok: false, error: 'from 和 to 都是必填字符串' });
                    return;
                }
                sendJson(res, 200, await doFsMove(projectDir, body.from, body.to));
                return;
            }
            if (pathname === '/fs/copy') {
                if (!body.from || !body.to || typeof body.from !== 'string' || typeof body.to !== 'string') {
                    sendJson(res, 400, { ok: false, error: 'from 和 to 都是必填字符串' });
                    return;
                }
                sendJson(res, 200, await doFsCopy(projectDir, body.from, body.to));
                return;
            }
            if (pathname === '/fs/delete') {
                if (!body.path || typeof body.path !== 'string') { sendJson(res, 400, { ok: false, error: 'path is required' }); return; }
                sendJson(res, 200, await doFsDelete(projectDir, body.path));
                return;
            }
            if (pathname === '/fs/restore') {
                if (!body.checkpoint || typeof body.checkpoint !== 'string') { sendJson(res, 400, { ok: false, error: 'checkpoint is required' }); return; }
                sendJson(res, 200, await doFsRestore(projectDir, body.checkpoint, { dryRun: !!body.dryRun, force: !!body.force }));
                return;
            }
        }

        // v2 Pass P66：只读反查目录的 origin，供前端反向同步 UI 上的 Overleaf 项目 ID。
        // 跟 /overleaf/pull、/overleaf/push 共用同一套「拒绝外部网页调用」的 CORS 前置检查，
        // 但本身不写任何东西、不需要 token。
        if (req.method === 'POST' && pathname === '/overleaf/origin') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, action: 'forbidden-origin',
                    error: '拒绝来自外部网页的同步请求。这个接口只接受 AI-Translator 页面本身的调用。' });
                return;
            }
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            if (!projectDir || typeof projectDir !== 'string') { sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' }); return; }
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            const result = await doOverleafOrigin(projectDir);
            sendJson(res, 200, result);
            return;
        }

        // v2 Pass P67：顶栏项目名双击改名——真的把磁盘上的项目文件夹重命名。跟 /overleaf/origin
        // 一样走 ovlOriginAllowed 前置检查、不在 TOKEN_EXEMPT_PATHS 里（远程模式下必须过令牌闸门——
        // 这是一个会真实修改磁盘的写操作，跟只读的 /overleaf/origin 不是一回事）。
        if (req.method === 'POST' && pathname === '/overleaf/rename-project') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, action: 'forbidden-origin',
                    error: '拒绝来自外部网页的同步请求。这个接口只接受 AI-Translator 页面本身的调用。' });
                return;
            }
            const bodyText = await readBody(req);
            let body;
            try { body = JSON.parse(bodyText || '{}'); } catch (e) {
                sendJson(res, 400, { ok: false, error: 'invalid JSON body' });
                return;
            }
            const projectDir = body.projectDir;
            const newName = body.newName;
            if (!projectDir || typeof projectDir !== 'string') { sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' }); return; }
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            if (!newName || typeof newName !== 'string') { sendJson(res, 400, { ok: false, error: 'newName is required' }); return; }
            // newName 必须是纯 basename——含任何路径分隔符或 ".." 都是在试图把这个端点当成
            // "移动到任意目录"的后门，请求体本身不合法，400 而不是业务性的 ok:false。
            const trimmedForPathCheck = newName.trim();
            if (path.basename(trimmedForPathCheck) !== trimmedForPathCheck || trimmedForPathCheck.indexOf('..') !== -1) {
                sendJson(res, 400, { ok: false, error: 'newName 必须是纯文件夹名，不能包含路径分隔符或 ".."' });
                return;
            }
            const result = await doOverleafRenameProject(projectDir, newName);
            sendJson(res, 200, result);
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
            // v2 Pass P27：可选，缺省 'abort'（向后兼容旧前端/旧行为）。白名单校验放在
            // doOverleafPull 内部（跟其它业务性 ok:false 一样走 200 + {ok:false}，不是 400——
            // 这条路由对所有业务结果统一用 200，只有请求体本身不合法才用 400，见下面三行）。
            const strategy = body.strategy;
            if (!projectDir || typeof projectDir !== 'string') { sendJson(res, 400, { ok: false, error: 'projectDir is required (绝对路径)' }); return; }
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            if (!gitUrl || typeof gitUrl !== 'string') { sendJson(res, 400, { ok: false, error: 'gitUrl is required' }); return; }
            if (!token || typeof token !== 'string') { sendJson(res, 400, { ok: false, error: 'token is required' }); return; }
            const result = await doOverleafPull(projectDir, gitUrl, token, strategy);
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
            // v2 Pass P154：根目录白名单，未设置环境变量时恒放行。
            if (rejectIfProjectDirNotAllowed(res, projectDir)) return;
            if (!gitUrl || typeof gitUrl !== 'string') { sendJson(res, 400, { ok: false, error: 'gitUrl is required' }); return; }
            if (!token || typeof token !== 'string') { sendJson(res, 400, { ok: false, error: 'token is required' }); return; }
            const result = await doOverleafPush(projectDir, gitUrl, token, body.message);
            sendJson(res, 200, result);
            return;
        }

        // v2 Pass P24（追加）：Overleaf git 集成——首次把一个 Overleaf 项目整体 clone 下来。
        // v2 Pass P53：新增可选的 parentDir/folderName——用户在前端"存放位置"弹窗里选的目标
        // 位置，不传时（旧调用方/既有测试）完全退回原来"服务端按 projectId 自己算"的默认值，
        // 见 doOverleafClone/computeOverleafCloneTargetDir 头部注释。
        if (req.method === 'POST' && pathname === '/overleaf/clone') {
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
            const projectId = body.projectId;
            const token = body.token;
            if (!projectId || typeof projectId !== 'string' || !/^[0-9a-f]{24}$/i.test(projectId)) {
                sendJson(res, 400, { ok: false, error: '项目 ID 格式不对，应为 24 位十六进制字符' });
                return;
            }
            if (!token || typeof token !== 'string') { sendJson(res, 400, { ok: false, error: '缺少 Overleaf token' }); return; }
            const parentDir = (typeof body.parentDir === 'string' && body.parentDir) ? body.parentDir : null;
            const folderName = (typeof body.folderName === 'string' && body.folderName) ? body.folderName : null;
            // v2 Pass P182：parentDir 是调用方显式指定的绝对路径（"存放位置"），在真正 mkdir+git
            // clone 落盘之前必须先过跟 projectDir 完全同一套 LATEX_BRIDGE_ALLOWED_ROOTS 白名单
            // 校验——修复前这里完全没有这道闸，parentDir 能把写入引到白名单之外的任意路径。不传
            // parentDir（走服务端自己算的默认位置）不受影响，那不是调用方可控的路径。非绝对路径
            // 也不在这里拦：那种情况 computeOverleafCloneTargetDir 自己会在任何文件系统访问之前
            // 先用 isAbsolute 拒绝，不会碰到白名单判断，两层校验不重叠也没有缺口。空白名单（未
            // 设置 LATEX_BRIDGE_ALLOWED_ROOTS）时 checkProjectDirAllowed 恒放行——跟 projectDir
            // 用的是同一个函数、同一条既定策略（P154 定的硬要求），不是本 Pass 新引的例外：
            // test_p53_clone_location.js / test_p133_bridge_serve.js 都有既有、当前通过的用例在
            // 未设置白名单时依赖自定义 parentDir 正常工作，见 test_p182_bridge_path_guard.js 头注。
            if (parentDir && path.isAbsolute(parentDir) && rejectIfProjectDirNotAllowed(res, parentDir)) return;
            const result = await doOverleafClone(projectId, token, parentDir, folderName);
            sendJson(res, 200, result);
            return;
        }

        // v2 Pass P53：克隆前置的"存放位置"弹窗用来校验父目录存不存在/能不能写、目标子目录
        // 是否已被占用——见 doOverleafCheckTarget 头部注释（故意比 /fs/list 窄得多，只读探测，
        // 绝不列举目录内容）。
        if (req.method === 'POST' && pathname === '/overleaf/check-target') {
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
            // v2 Pass P182：跟 /overleaf/clone 同一道闸——parentDir 是调用方指定的绝对路径，这个
            // 端点虽然全程只读探测、不落盘，但同样会真碰文件系统（fs.statSync/accessSync/
            // readdirSync），泄露"这个路径存不存在/能不能写/里面是否已经有东西"这类信息，修复前
            // 完全没有白名单校验，等于把白名单之外的任意路径变成一个可探测的信息泄露点。非绝对
            // 路径不在这里拦——doOverleafCheckTarget 自己的 isAbsolute 检查会在任何 fs 访问之前
            // 先返回 parentStatus:'not-absolute'，两层校验不重叠。
            if (typeof body.parentDir === 'string' && body.parentDir && path.isAbsolute(body.parentDir)
                && rejectIfProjectDirNotAllowed(res, body.parentDir)) return;
            const result = await doOverleafCheckTarget(body.parentDir, body.folderName);
            sendJson(res, 200, result);
            return;
        }

        // v2 Pass P222：配置同步。三条都过上面统一的令牌闸门（不在 TOKEN_EXEMPT_PATHS）；再过
        // ovlOriginAllowed（本地模式令牌恒放行，GET 也挡一下跨站读取）。
        if (pathname === '/sync/snapshot' || pathname === '/sync/changes' || pathname === '/sync/put') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, error: '拒绝来自外部网页的同步请求。' });
                return;
            }
            if (req.method === 'GET' && pathname === '/sync/snapshot') {
                const keys = {};
                for (const k of Object.keys(syncStore.keys)) keys[k] = syncPick(syncStore.keys[k]);
                sendJson(res, 200, { ok: true, version: syncStore.version, keys });
                return;
            }
            if (req.method === 'GET' && pathname === '/sync/changes') {
                const since = Number(u.searchParams.get('since'));
                if (!Number.isFinite(since) || since < 0) { sendJson(res, 400, { ok: false, error: 'since 必须是非负整数' }); return; }
                const keys = {};
                for (const k of Object.keys(syncStore.keys)) { if (syncStore.keys[k].v > since) keys[k] = syncPick(syncStore.keys[k]); }
                sendJson(res, 200, { ok: true, version: syncStore.version, keys });
                return;
            }
            if (req.method === 'POST' && pathname === '/sync/put') {
                let raw;
                try { raw = await readBody(req); } catch (e) { sendJson(res, 413, { ok: false, error: '请求体过大' }); return; }
                let body;
                try { body = JSON.parse(raw); } catch (e) { sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return; }
                if (!body || typeof body !== 'object' || !Array.isArray(body.changes)) { sendJson(res, 400, { ok: false, error: '缺少 changes 数组' }); return; }
                const clientId = (typeof body.clientId === 'string' ? body.clientId : '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
                // 先整体校验再落任何一条：白名单违规 400，超限 413，都不产生部分写入。
                for (const c of body.changes) {
                    if (!c || typeof c !== 'object' || !syncKeyAllowed(c.key)) { sendJson(res, 400, { ok: false, error: '不允许同步的键：' + (c && typeof c.key === 'string' ? c.key.slice(0, 80) : '(无效)') }); return; }
                    if (!Number.isInteger(c.baseV) || c.baseV < 0) { sendJson(res, 400, { ok: false, error: 'baseV 必须是非负整数：' + c.key }); return; }
                    if (c.value !== null && typeof c.value !== 'string') { sendJson(res, 400, { ok: false, error: 'value 必须是字符串或 null：' + c.key }); return; }
                    if (typeof c.value === 'string' && Buffer.byteLength(c.value, 'utf8') > SYNC_KEY_MAX_BYTES) { sendJson(res, 413, { ok: false, error: '单个键超过 1MB：' + c.key }); return; }
                }
                // 在副本上演算，超出总上限就整体 413 且不改动真实仓。
                const trial = { version: syncStore.version, keys: Object.assign({}, syncStore.keys) };
                const results = [];
                const accepted = [];
                const now = Date.now();
                for (const c of body.changes) {
                    const cur = trial.keys[c.key];
                    const curV = cur ? cur.v : 0;
                    const curVal = cur ? cur.value : null;
                    if (cur && curVal === c.value) { results.push({ key: c.key, status: 'ok', v: curV }); continue; } // 内容相同：不涨版本
                    if (c.baseV === curV) {
                        if (!cur && c.value === null) { results.push({ key: c.key, status: 'ok', v: 0 }); continue; }
                        trial.version += 1;
                        trial.keys[c.key] = { v: trial.version, updatedAt: now, by: clientId, value: c.value };
                        results.push({ key: c.key, status: 'ok', v: trial.version });
                        accepted.push(c.key);
                    } else {
                        results.push({ key: c.key, status: 'conflict', v: curV, value: curVal });
                    }
                }
                if (accepted.length) {
                    if (syncStoreBytes(trial) > SYNC_STORE_MAX_BYTES) { sendJson(res, 413, { ok: false, error: '同步仓总量超过 8MB' }); return; }
                    const prevStore = syncStore;
                    syncStore = trial;
                    try { syncPersist(); }
                    catch (e) { syncStore = prevStore; sendJson(res, 500, { ok: false, error: '同步仓写盘失败：' + (e && e.message) }); return; }
                    syncBroadcast({ type: 'sync-changed', version: syncStore.version, keys: accepted, by: clientId });
                }
                sendJson(res, 200, { ok: true, version: syncStore.version, results });
                return;
            }
        }

        // v2 Pass P50：WebSocket 一次性短时票据——磁盘变更推送这条 WS 连接，浏览器原生 WebSocket
        // API 加不了自定义请求头，没法带令牌，REMOTE_MODE 下之前是完全没鉴权的（tailnet 上任何人
        // 连上去都能实时看到项目里哪些文件在变、路径是什么）。这个端点本身走上面统一的令牌闸门
        // （不在 TOKEN_EXEMPT_PATHS 里），换票据必须先有效令牌；票据本身只在 WS 连接 URL 里出现，
        // 一次性、60 秒过期，绝不是长期令牌的替代品——长期令牌永远只走请求头，不出现在任何 URL。
        if (req.method === 'POST' && pathname === '/ws-ticket') {
            sendJson(res, 200, { ok: true, ticket: createWsTicket(), expiresInMs: WS_TICKET_TTL_MS });
            return;
        }

        // v2 Pass P119：桥自重启——无人值守场景改完 server.js 后没有"人"去走
        // overnight_constraints.md 那套手动重启流程，这个端点让桥自己主动退出，交给外部计划
        // 任务的自愈配置重新拉起新进程（详见 README「桥自重启」一节）。不进
        // TOKEN_EXEMPT_PATHS——跟其余非豁免端点一样过上面统一的 tokenAuthorized() 闸门：
        // 远程模式必须带对的令牌，本地模式（REMOTE_MODE=false）tokenAuthorized 恒真，不为这
        // 一个端点单独加令牌要求。
        // v2 Pass P119 核验返修（问题 2）：本地模式下 tokenAuthorized 恒真，仅靠令牌闸门挡不住
        // 跨站——任意网页只要能诱导用户打开就能对 127.0.0.1:PORT 发一条不触发预检的简单
        // POST（无自定义头、Content-Type: text/plain），把用户正在用的桥直接打死。跟
        // /fs/*、/overleaf/* 这些会产生副作用的端点一样，补上 ovlOriginAllowed() 前置闸门：
        // 只放行"没有 Origin 头的非浏览器调用"（curl/无人值守脚本）、"file:// 页面"、"桥自己
        // 服务的同源页面"、"localhost/127.0.0.1"，跨站页面一律 403。前端全文 grep 不到任何
        // UI 调用这个端点（`admin/restart`），加这道闸门不影响现有用法。
        if (req.method === 'POST' && pathname === '/admin/restart') {
            if (!ovlOriginAllowed(req)) {
                sendJson(res, 403, { ok: false, error: '拒绝来自外部网页的重启请求。这个接口只接受本机/受信来源的调用。' });
                return;
            }
            if (restartScheduled) {
                // 已经排上了：幂等返回，不重复计时、不重复 kill——避免同一秒内连点两下反而
                // 制造第二次 killTree/第二次 process.exit 竞态。
                sendJson(res, 200, { ok: true, alreadyScheduled: true });
                return;
            }
            restartScheduled = true;
            sendJson(res, 200, { ok: true, message: '桥将在1秒后退出,由计划任务自动拉起' });
            setTimeout(() => {
                // 收尾：用现有 killTree 机制把当前还在跑的编译子进程树（如果有）杀干净。带上
                // jobIdHint（即 currentChildId）触发二次扫荡——见 killTree 头部注释：
                // taskkill /T /F 在 latexmk 经过一层 sh.exe 包装派生 pdflatex 时，实测杀不干净
                // 这层 sh.exe 自己派生出的孙进程；/admin/restart 的定位是"干净收尾"，不能只做
                // /stop 那种单纯 taskkill，必须带上二次扫荡这一环。
                const jobIdHint = currentChildId;
                let sweep = Promise.resolve();
                try { sweep = killTree(currentChild && currentChild.pid, jobIdHint) || sweep; } catch (e) {}
                currentChild = null;
                currentChildId = null;
                // 非零退出码——外部计划任务据此判定"任务失败"才会触发它的 RestartCount 自愈，
                // 退出码 0 不会。这不是错误，是故意的信号。
                // v2 Pass P214：二次扫荡现在是异步的，先等它收尾（killTree 内部自带 8 秒上限）再退出。
                sweep.then(() => process.exit(1), () => process.exit(1));
            }, 1000);
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
    syncWss = wss; // v2 Pass P222：sync-changed 广播复用这条 WS 服务器
    wss.on('connection', function (ws, req) {
        // v2 Pass P50：REMOTE_MODE 下握手时校验一次性票据（见上面 wsTickets 那段注释）——票据从
        // 连接 URL 的查询串里取，绝不是长期令牌本身。本地模式（REMOTE_MODE=false）完全不检查，
        // 跟这套机制加入之前行为逐字节一致。校验不过直接关闭连接，不建立 watch，不回任何消息
        // （避免把"票据是否存在/是否过期"这类细节回显给未认证的连接方）。
        if (REMOTE_MODE) {
            let ticket = '';
            try {
                const wsUrl = new URL(req.url, 'http://' + HOST + ':' + PORT);
                ticket = wsUrl.searchParams.get('ticket') || '';
            } catch (e) { ticket = ''; }
            if (!consumeWsTicket(ticket)) {
                try { ws.close(4401, 'invalid or expired ticket'); } catch (e) {}
                return;
            }
        }
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

loadAppHtmlCache(); // v2 Pass P110b：异步发起，不阻塞下面的 listen()

server.listen(PORT, HOST, () => {
    console.log('[latex-bridge] listening on http://' + HOST + ':' + PORT);
    console.log('[latex-bridge] latexmk: ' + LATEXMK + (fs.existsSync(LATEXMK) ? ' (found)' : ' (MISSING!)'));
    console.log('[latex-bridge] work root: ' + WORK_ROOT);
    if (HOST === '0.0.0.0') {
        console.warn('[latex-bridge] ⚠️ 警告：正在监听 0.0.0.0（所有网卡），这会把桥暴露给同一网络下的任何');
        console.warn('[latex-bridge]    设备，强烈建议改绑到具体的 Tailscale IP（例如 100.x.x.x），而不是 0.0.0.0。');
    }
    if (REMOTE_MODE) {
        // v2 Pass P110b（IX1）：如实播报豁免范围——TOKEN_EXEMPT_PATHS 现在是 5 条，不是 1 条。
        // GET / 与 GET /AI-Translator.html 会把整份应用页面（无秘密，但完整）发给任何能连上
        // 这个地址的人，不需要令牌；除这 5 条以外的一切端点（含文件读写、编译、Overleaf 同步）
        // 才要求令牌。这句话是用户在 jump 上启动桥时唯一会读到的鉴权说明，必须跟代码一致。
        const exemptList = Array.from(TOKEN_EXEMPT_PATHS).join('、');
        console.log('[latex-bridge] 远程模式已启用：以下 ' + TOKEN_EXEMPT_PATHS.size + ' 个路径无需令牌即可访问：' + exemptList + '（其中 GET / 与 GET /AI-Translator.html 会把整个应用页面发给任何能连上这个地址的人，页面本身没有秘密，但是公开的）；除这些路径外的其余所有端点都要求访问令牌（请求头 ' + TOKEN_HEADER + '）。');
        // v2 Pass P110f：这里过去会把 BRIDGE_TOKEN 整串打印出来。stdout 会进终端会话历史，
        // 而 start-bridge.ps1 还会把 node 的 stdout/stderr `*>>` 追加重定向到
        // logs/bridge-stdout-<日期>.log —— 等于令牌明文落进一个没有 0600 权限保护的日志文件。
        // 现在只播报**令牌的来源**（文件的绝对路径，或"来自环境变量"），令牌值本身绝不出现在
        // 任何 stdout/stderr/日志里。回归断言见 tools/e2e/test_p110_remote_serving.js 组 J。
        console.log('[latex-bridge] 访问令牌来源：' + (TOKEN_FROM_ENV
            ? '环境变量 LATEX_BRIDGE_TOKEN（本次令牌由环境变量提供）'
            : TOKEN_FILE));
        console.log('[latex-bridge] 令牌见上面这个来源，请勿在日志中打印其内容；要抄进前端设置的"访问令牌"一栏时请直接从该来源取值（注意保密，不要发给别人）。');
        console.log('[latex-bridge] 前端设置里的"服务地址"填：http://' + HOST + ':' + PORT);
        console.log('[latex-bridge] 现在也可以直接在同网任意设备的浏览器里打开 http://' + HOST + ':' + PORT + '/ 使用整个应用，服务地址栏留空即默认走同源。');
    }
});

process.on('SIGINT', () => {
    let p = null;
    try { p = killTree(currentChild && currentChild.pid); } catch (e) {}
    Promise.resolve(p).then(() => process.exit(0), () => process.exit(0)); // v2 Pass P214：killTree 现在是异步的
});
