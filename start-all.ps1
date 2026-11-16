<#
.SYNOPSIS
    WeaveNote 项目一键启动 / 停止脚本

.DESCRIPTION
    自动完成以下工作：
      1. 自行切换到脚本所在目录（项目根目录）
      2. 启动 PostgreSQL（WSL2 Ubuntu 内，端口 5432）
      3. 按需启动 WebSocket 服务（仅当项目仍带 server/index.ts 与 npm run ws:dev；
         当前 WeaveNote 版本聊天室已移除，自动跳过，不再视为失败）
      4. 启动 Next.js 前端 + 后端（npm run dev，端口 3000）
      5. 启动前自动检测端口冲突：若被本项目残留进程占用则清理，被外部进程占用则提示
      6. 各步骤相互独立执行：单个失败不会阻断后续步骤，最后统一汇总
      7. 全部就绪后自动打开默认浏览器
      8. 所有子进程均在隐藏窗口运行，日志写入 .start-all\logs\ 目录

.PARAMETER Status
    查看所有服务的运行状态（端口监听 + 进程信息）

.PARAMETER Stop
    停止所有服务（Web / WebSocket / 数据库）

.PARAMETER KeepDb
    配合 -Stop 使用：停止 Web 与 WebSocket，但保留数据库运行

.PARAMETER NoBrowser
    启动时不自动打开浏览器

.PARAMETER Hidden
    隐藏模式（供 start-all.bat 双击调用）：屏幕不输出，失败时弹窗提示

.EXAMPLE
    双击 start-all.bat
        静默启动全部服务并自动打开浏览器

.EXAMPLE
    .\start-all.ps1
        前台启动全部服务（终端可看到日志）

.EXAMPLE
    .\start-all.ps1 -Status
        查看当前各服务状态

.EXAMPLE
    .\start-all.ps1 -Stop
        停止全部服务

.EXAMPLE
    .\start-all.ps1 -Stop -KeepDb
        只停前后端，保留数据库
#>
param(
    [switch]$Status,
    [switch]$Stop,
    [switch]$KeepDb,
    [switch]$NoBrowser,
    [switch]$Hidden
)

$ErrorActionPreference = "Continue"

# ============================================================
# 基础配置
# ============================================================
# 脚本所在目录即项目根目录（自行 CD 到此）
$Root = if ($PSScriptRoot) { $PSScriptRoot } else { "d:\summer-checkin" }
Set-Location $Root

$StateDir = Join-Path $Root ".start-all"
$PidDir   = Join-Path $StateDir "pids"
$LogDir   = Join-Path $StateDir "logs"

New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

# 服务端口（按需修改）
$WebPort = 3000      # Next.js 前端 + 后端
$WsPort  = 3001      # WebSocket 服务（可选，仅在项目带 sidecar 时启用）
$DbPort  = 5432      # PostgreSQL（WSL2 Ubuntu）

# WSL 发行版名称（按需修改为你的发行版，可用 `wsl -l -q` 查看）
$WslDistro = "Ubuntu"

# 就绪探测超时（秒）
$WebTimeout = 90
$WsTimeout  = 60
$DbTimeout  = 90

# 浏览器地址
$WebUrl = "http://localhost:$WebPort"

# ============================================================
# 工具函数
# ============================================================

# 写日志：同时输出到屏幕（除非隐藏模式）与日志文件
function Write-Log {
    param([string]$Message, [string]$Color = "White")
    if (-not $Hidden) {
        Write-Host $Message -ForegroundColor $Color
    }
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logFile = Join-Path $LogDir "start-all.log"
    try {
        Add-Content -Path $logFile -Value "[$ts] $Message" -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch { }
}

# 隐藏模式下的错误弹窗
function Show-ErrorBox {
    param([string]$Message)
    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
        [System.Windows.MessageBox]::Show($Message, "WeaveNote 启动失败", "OK", "Error") | Out-Null
    } catch {
        # 退路：写入日志文件
        Write-Log "错误：$Message" "Red"
    }
}

# TCP 端口连通性探测
function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs = 2000)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $result = $client.BeginConnect($HostName, $Port, $null, $null)
        if ($result.AsyncWaitHandle.WaitOne($TimeoutMs)) {
            $client.EndConnect($result)
            return $true
        }
        return $false
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

# HTTP 200 探测（用于 Next.js 就绪判断）
function Test-HttpReady {
    param([string]$Url, [int]$TimeoutMs = 3000)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Timeout = $TimeoutMs
        $req.Method = "GET"
        $req.AllowAutoRedirect = $true
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        return ($code -eq 200)
    } catch {
        return $false
    }
}

# 获取占用指定端口的进程
function Get-PortProcess {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) {
        return Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
    }
    return $null
}

# 读取已记录的 PID 对应进程（不存在则返回 null）
function Get-RecordedProcess {
    param([string]$Name)
    $pidFile = Join-Path $PidDir "$Name.pid"
    if (Test-Path $pidFile) {
        $savedId = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($savedId -match '^\d+$') {
            $p = Get-Process -Id ([int]$savedId) -ErrorAction SilentlyContinue
            if ($p) { return $p }
        }
    }
    return $null
}

# 保存 PID 到文件
function Save-Pid {
    param([string]$Name, [int]$ProcessId)
    New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
    Set-Content -Path (Join-Path $PidDir "$Name.pid") -Value $ProcessId -ErrorAction SilentlyContinue
}

# 清理本项目残留进程（占用端口且命令行匹配关键字）
function Clear-StaleProcess {
    param([int]$Port, [string[]]$Keywords)
    $proc = Get-PortProcess -Port $Port
    if ($proc) {
        $cmdline = ""
        try {
            $cmdline = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)" -ErrorAction SilentlyContinue).CommandLine
        } catch { }
        $isOurs = $false
        if ($cmdline -match 'summer-checkin' -or $cmdline -match 'weavenote') { $isOurs = $true }
        foreach ($k in $Keywords) {
            if ($cmdline -match $k) { $isOurs = $true; break }
        }
        if ($isOurs) {
            Write-Log "端口 $Port 被本项目残留进程占用 (PID $($proc.Id))，正在清理..." "Yellow"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1
            return $true
        } else {
            Write-Log "端口 $Port 被外部进程占用：$($proc.ProcessName) (PID $($proc.Id))，请手动处理" "Red"
            return $false
        }
    }
    return $true
}

# 把参数数组拼成命令行：含空格的参数必须显式加引号
# （Start-Process 的 ArgumentList 只是用空格拼接，不会自动加引号，
#   否则 sh -c "service postgresql start; exec sleep infinity" 会被拆成多个 argv）
function ConvertTo-ArgLine {
    param([string[]]$Arguments)
    $parts = @()
    foreach ($a in $Arguments) {
        if ($null -eq $a -or $a -eq "") {
            $parts += '""'
        } elseif ($a -match '[\s"]') {
            $parts += '"' + ($a -replace '"', '\"') + '"'
        } else {
            $parts += $a
        }
    }
    return ($parts -join ' ')
}

# 隐藏启动子进程（重定向日志）
function Start-HiddenProcess {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$OutLog,
        [string]$ErrLog
    )
    $params = @{
        FilePath         = $FilePath
        ArgumentList     = (ConvertTo-ArgLine -Arguments $ArgumentList)
        WorkingDirectory = $Root
        WindowStyle      = "Hidden"
        PassThru         = $true
    }
    if ($OutLog) { $params.RedirectStandardOutput = $OutLog }
    if ($ErrLog) { $params.RedirectStandardError = $ErrLog }
    try {
        return Start-Process @params
    } catch {
        # 某些代理软件会同时注入 HTTPS_PROXY / https_proxy，Windows 下二者等价，
        # Start-Process 内部建哈希表时会抛「字典中的关键字已添加」，改用 .NET 直启兜底
        Write-Log "Start-Process 失败（$($_.Exception.Message)），改用进程直启..." "Yellow"
        return Start-HiddenProcessDirect `
            -FilePath $FilePath `
            -Arguments (ConvertTo-ArgLine -Arguments $ArgumentList) `
            -OutLog $OutLog `
            -ErrLog $ErrLog
    }
}

# 兜底启动：System.Diagnostics.Process 直接继承父进程环境，不经 PowerShell 的哈希表
# 日志重定向交给 cmd.exe 自己处理（路径不含空格，无需再加引号）
function Start-HiddenProcessDirect {
    param([string]$FilePath, [string]$Arguments, [string]$OutLog, [string]$ErrLog)
    try {
        $isCmd = ([System.IO.Path]::GetFileName($FilePath) -match '^(cmd|npm)')
        if ($isCmd -and $OutLog) {
            $Arguments = $Arguments + ' > "' + $OutLog + '" 2> "' + $ErrLog + '"'
        }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $FilePath
        $psi.Arguments = $Arguments
        $psi.WorkingDirectory = $Root
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $proc = New-Object System.Diagnostics.Process
        $proc.StartInfo = $psi
        [void]$proc.Start()
        return $proc
    } catch {
        Write-Log "启动进程失败：$FilePath ($($_.Exception.Message))" "Red"
        return $null
    }
}

# 取日志尾部若干行，拼进失败提示里，省得再去找文件
function Get-LogTail {
    param([string]$Path, [int]$Lines = 6)
    if ($Path -and (Test-Path $Path)) {
        $tail = Get-Content -Path $Path -Tail $Lines -ErrorAction SilentlyContinue
        if ($tail) { return (($tail | Where-Object { $_.Trim() -ne "" }) -join "`n") }
    }
    return ""
}

# 项目当前是否还带 WebSocket sidecar
# （WeaveNote 版本已移除聊天室：server/index.ts 不存在、package.json 无 ws:dev，
#   此时脚本应跳过该步骤而不是等 60 秒超时失败）
function Test-WsEnabled {
    $pkgFile = Join-Path $Root "package.json"
    if (-not (Test-Path $pkgFile)) { return $false }
    try {
        $pkg = Get-Content -Path $pkgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        return $false
    }
    $hasScript = $false
    if ($pkg.scripts) {
        $hasScript = (@($pkg.scripts.PSObject.Properties.Name) -contains "ws:dev")
    }
    $hasEntry = Test-Path (Join-Path $Root "server\index.ts")
    return ($hasScript -and $hasEntry)
}

# ============================================================
# 状态查看
# ============================================================
function Show-Status {
    Write-Host ""
    Write-Host "===== WeaveNote 服务状态 =====" -ForegroundColor Cyan

    # 数据库
    $dbOk = Test-TcpPort "127.0.0.1" $DbPort
    if ($dbOk) {
        Write-Host ("  PostgreSQL      运行中  端口 {0} 已监听" -f $DbPort) -ForegroundColor Green
    } else {
        Write-Host ("  PostgreSQL      已停止  (端口 {0})" -f $DbPort) -ForegroundColor Red
    }

    # WebSocket（可选服务）
    $wsOk = Test-TcpPort "127.0.0.1" $WsPort
    $wsProc = Get-PortProcess -Port $WsPort
    if ($wsOk) {
        $wsInfo = if ($wsProc) { "PID $($wsProc.Id)" } else { "未知进程" }
        Write-Host ("  WebSocket       运行中  端口 {0} 已监听 ({1})" -f $WsPort, $wsInfo) -ForegroundColor Green
    } elseif (Test-WsEnabled) {
        Write-Host ("  WebSocket       已停止  (端口 {0})" -f $WsPort) -ForegroundColor Red
    } else {
        Write-Host "  WebSocket       未启用  当前版本无 sidecar（聊天室已移除）" -ForegroundColor DarkGray
    }

    # Web (Next.js)
    $webOk = Test-HttpReady $WebUrl
    $webProc = Get-PortProcess -Port $WebPort
    if ($webOk) {
        $webInfo = if ($webProc) { "PID $($webProc.Id)" } else { "未知进程" }
        Write-Host ("  Web (Next.js)   运行中  {0} ({1})" -f $WebUrl, $webInfo) -ForegroundColor Green
    } elseif ($webProc) {
        Write-Host ("  Web (Next.js)   启动中  端口 {0} 已监听但未就绪" -f $WebPort) -ForegroundColor Yellow
    } else {
        Write-Host ("  Web (Next.js)   已停止  (端口 {0})" -f $WebPort) -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "PID 文件目录：$PidDir" -ForegroundColor DarkGray
    Write-Host "日志目录：$LogDir" -ForegroundColor DarkGray
    Write-Host "====================================" -ForegroundColor Cyan
    Write-Host ""
}

# ============================================================
# 停止服务
# ============================================================
function Stop-Services {
    Write-Log "正在停止服务..." "Yellow"

    # 1. Web (Next.js)
    $webProc = Get-PortProcess -Port $WebPort
    if ($webProc) {
        Write-Log "停止 Web (PID $($webProc.Id))..." "Yellow"
        Stop-Process -Id $webProc.Id -Force -ErrorAction SilentlyContinue
    }

    # 2. WebSocket（存在才停）
    $wsProc = Get-PortProcess -Port $WsPort
    if ($wsProc) {
        Write-Log "停止 WebSocket (PID $($wsProc.Id))..." "Yellow"
        Stop-Process -Id $wsProc.Id -Force -ErrorAction SilentlyContinue
    }

    # 3. 数据库（除非 -KeepDb）
    if (-not $KeepDb) {
        Write-Log "停止 PostgreSQL..." "Yellow"
        # 先停止常驻进程（触发 VM 空闲关闭）
        $dbKeeper = Get-RecordedProcess "db"
        if ($dbKeeper) {
            Stop-Process -Id $dbKeeper.Id -Force -ErrorAction SilentlyContinue
        }
        # 优雅停止 postgres 服务
        try {
            if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
                $stopLine = ConvertTo-ArgLine -Arguments @("-d", $WslDistro, "-u", "root", "--", "service", "postgresql", "stop")
                Start-Process -FilePath "wsl.exe" -ArgumentList $stopLine -WindowStyle Hidden -Wait -ErrorAction SilentlyContinue
            }
        } catch { }
    } else {
        Write-Log "保留数据库（-KeepDb）" "Gray"
    }

    # 清理 PID 文件
    Remove-Item (Join-Path $PidDir "web.pid") -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $PidDir "ws.pid") -ErrorAction SilentlyContinue
    if (-not $KeepDb) {
        Remove-Item (Join-Path $PidDir "db.pid") -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 1
    Write-Log "服务已停止。" "Green"
}

# ============================================================
# 启动数据库
# ============================================================

# 启动 WSL 常驻进程：先把 postgres 拉起来，再用 sleep infinity 让 VM 别闲着退出
function Start-DbKeeper {
    param([bool]$AsRoot)
    $out = Join-Path $LogDir "db.log"
    $err = Join-Path $LogDir "db.err.log"
    $inner = 'service postgresql start >/dev/null 2>&1 || service postgresql restart >/dev/null 2>&1; echo "[start-all] postgres keepalive"; exec sleep infinity'
    $wslArgs = @()
    if ($AsRoot) {
        $wslArgs += @("-d", $WslDistro, "-u", "root")
    } else {
        $wslArgs += @("-d", $WslDistro)
    }
    $wslArgs += @("--", "sh", "-c", $inner)
    return Start-HiddenProcess -FilePath "wsl.exe" -ArgumentList $wslArgs -OutLog $out -ErrLog $err
}

function Start-Database {
    Write-Log "检查数据库 (PostgreSQL @ $DbPort)..." "Cyan"

    $dbOk = Test-TcpPort "127.0.0.1" $DbPort
    $dbKeeper = Get-RecordedProcess "db"

    if ($dbOk -and $dbKeeper) {
        Write-Log "数据库已在运行（PID $($dbKeeper.Id)），跳过启动" "Green"
        return $true
    }

    if ($dbOk) {
        Write-Log "数据库端口已通但无常驻进程，补启动 WSL 常驻以保持 VM 存活..." "Yellow"
    } else {
        Write-Log "启动 WSL 数据库..." "Yellow"
    }

    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
        $msg = "未找到 wsl.exe，请确认已安装 WSL2 及发行版 '$WslDistro'。"
        Write-Log $msg "Red"
        Show-ErrorBox $msg
        return $false
    }

    # 优先以 root 启动（WSL 的 -u root 免密）；若失败再退回默认用户
    $keeper = Start-DbKeeper -AsRoot $true
    if ($keeper) {
        Save-Pid "db" $keeper.Id
        Write-Log "数据库常驻进程已启动 (PID $($keeper.Id))" "Gray"
    }

    Write-Log "等待数据库就绪..." "Cyan"
    $deadline = (Get-Date).AddSeconds($DbTimeout)
    $retried = $false
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort "127.0.0.1" $DbPort) {
            Write-Log "数据库就绪。" "Green"
            return $true
        }
        if ((-not $retried) -and ((-not $keeper) -or $keeper.HasExited)) {
            $retried = $true
            Write-Log "以 root 启动 WSL 失败，改用当前默认用户重试..." "Yellow"
            $keeper = Start-DbKeeper -AsRoot $false
            if ($keeper) { Save-Pid "db" $keeper.Id }
        }
        Start-Sleep -Seconds 1
    }

    $tail = Get-LogTail (Join-Path $LogDir "db.err.log")
    $msg = "数据库启动超时（$DbTimeout 秒）。日志：$(Join-Path $LogDir 'db.err.log')"
    if ($tail) { $msg = $msg + "`n" + $tail }
    Write-Log $msg "Red"
    Show-ErrorBox $msg
    return $false
}

# ============================================================
# 启动 WebSocket（可选）
# ============================================================
function Start-WebSocket {
    Write-Log "检查 WebSocket (端口 $WsPort)..." "Cyan"

    if (-not (Clear-StaleProcess -Port $WsPort -Keywords @("tsx", "server/index"))) {
        return $false
    }

    $wsOut = Join-Path $LogDir "ws.out.log"
    $wsErr = Join-Path $LogDir "ws.err.log"

    $proc = Start-HiddenProcess `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", "npm run ws:dev") `
        -OutLog $wsOut `
        -ErrLog $wsErr

    if (-not $proc) {
        $msg = "无法启动 WebSocket 服务。"
        Write-Log $msg "Red"
        Show-ErrorBox $msg
        return $false
    }
    Save-Pid "ws" $proc.Id
    Write-Log "WebSocket 启动中 (PID $($proc.Id))..." "Cyan"

    $deadline = (Get-Date).AddSeconds($WsTimeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort "127.0.0.1" $WsPort) {
            Write-Log "WebSocket 就绪。" "Green"
            return $true
        }
        if ($proc.HasExited) { break }
        Start-Sleep -Seconds 1
    }

    $tail = Get-LogTail $wsErr
    $msg = "WebSocket 启动失败，日志：$wsErr"
    if ($tail) { $msg = $msg + "`n" + $tail }
    Write-Log $msg "Red"
    Show-ErrorBox $msg
    return $false
}

# ============================================================
# 启动 Web (Next.js)
# ============================================================
function Start-Web {
    Write-Log "检查 Web / Next.js (端口 $WebPort)..." "Cyan"

    if (-not (Clear-StaleProcess -Port $WebPort -Keywords @("next"))) {
        return $false
    }

    $webOut = Join-Path $LogDir "web.out.log"
    $webErr = Join-Path $LogDir "web.err.log"

    $proc = Start-HiddenProcess `
        -FilePath "cmd.exe" `
        -ArgumentList @("/c", "npm run dev") `
        -OutLog $webOut `
        -ErrLog $webErr

    if (-not $proc) {
        $msg = "无法启动 Next.js 服务。"
        Write-Log $msg "Red"
        Show-ErrorBox $msg
        return $false
    }
    Save-Pid "web" $proc.Id
    Write-Log "Next.js 启动中 (PID $($proc.Id))..." "Cyan"

    $deadline = (Get-Date).AddSeconds($WebTimeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-HttpReady $WebUrl) {
            Write-Log "Next.js 就绪：$WebUrl" "Green"
            return $true
        }
        if ($proc.HasExited) { break }
        Start-Sleep -Seconds 1
    }

    $tail = Get-LogTail $webErr
    $msg = "Next.js 启动失败，日志：$webErr"
    if ($tail) { $msg = $msg + "`n" + $tail }
    Write-Log $msg "Red"
    Show-ErrorBox $msg
    return $false
}

# ============================================================
# 主流程
# ============================================================
if ($Status) {
    Show-Status
    exit 0
}

if ($Stop) {
    Stop-Services
    if (-not $Hidden) { Show-Status }
    exit 0
}

# ---- 启动流程 ----
Write-Log "========== 开始启动 WeaveNote ==========" "Cyan"
Write-Log "项目目录：$Root" "Gray"

$wsEnabled = Test-WsEnabled
if ($wsEnabled) {
    Write-Log "检测到 WebSocket sidecar（server/index.ts + ws:dev），将一并启动" "Gray"
} else {
    Write-Log "未检测到 WebSocket sidecar（server/index.ts 或 ws:dev 缺失），跳过该步骤" "DarkGray"
}

# 各步骤独立执行：任一步失败只记入失败清单，不阻断后续步骤
$failures = @()

if (-not (Start-Database))    { $failures += "PostgreSQL" }
if ($wsEnabled) {
    if (-not (Start-WebSocket)) { $failures += "WebSocket" }
}

$webReady = Start-Web
if (-not $webReady) { $failures += "Next.js" }

# 只要前端起来了就先打开浏览器，不因为数据库 / WS 的问题让用户干等
if ($webReady -and -not $NoBrowser) {
    Write-Log "正在打开浏览器：$WebUrl" "Cyan"
    Start-Process $WebUrl
}

if ($failures.Count -eq 0) {
    Write-Log "========== 全部服务就绪 ==========" "Green"
} else {
    Write-Log ("========== 启动未全部成功，失败项：{0} ==========" -f ($failures -join "、")) "Red"
    Write-Log "日志目录：$LogDir" "Gray"
    if ($Hidden) {
        Show-ErrorBox ("以下服务启动失败：" + ($failures -join "、") + "`n日志目录：$LogDir")
    }
}
