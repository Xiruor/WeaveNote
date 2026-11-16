<#
.SYNOPSIS
    Summer Checkin 项目一键启动 / 停止脚本

.DESCRIPTION
    自动完成以下工作：
      1. 自行切换到脚本所在目录（项目根目录 d:\summer-checkin）
      2. 启动 PostgreSQL（WSL2 Ubuntu 内，端口 5432）
      3. 启动 WebSocket 服务（npm run ws:dev，端口 3001）
      4. 启动 Next.js 前端 + 后端（npm run dev，端口 3000）
      5. 启动前自动检测端口冲突：若被本项目残留进程占用则清理，被外部进程占用则提示
      6. 等待全部服务就绪后自动打开默认浏览器
      7. 所有子进程均在隐藏窗口运行，日志写入 .start-all\logs\ 目录

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

.EXAMPLE
    .\start-all.ps1 -NoBrowser
        启动全部服务但不打开浏览器
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

# 服务端口（按需修改）
$WebPort = 3000      # Next.js 前端 + 后端
$WsPort  = 3001      # WebSocket 服务（对应 server/config.ts 的 WS_PORT 默认值）
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
        Add-Content -Path $logFile -Value "[$ts] $Message" -ErrorAction SilentlyContinue
    } catch { }
}

# 隐藏模式下的错误弹窗
function Show-ErrorBox {
    param([string]$Message)
    try {
        Add-Type -AssemblyName PresentationFramework -ErrorAction SilentlyContinue
        [System.Windows.MessageBox]::Show($Message, "Summer Checkin 启动失败", "OK", "Error") | Out-Null
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
        $id = Get-Content $pidFile -ErrorAction SilentlyContinue
        if ($id -match '^\d+$') {
            $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
            if ($p) { return $p }
        }
    }
    return $null
}

# 保存 PID 到文件
function Save-Pid {
    param([string]$Name, [int]$Id)
    New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
    Set-Content -Path (Join-Path $PidDir "$Name.pid") -Value $Id -ErrorAction SilentlyContinue
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
        if ($cmdline -match 'summer-checkin') { $isOurs = $true }
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

# 隐藏启动子进程（重定向日志）
function Start-HiddenProcess {
    param(
        [string]$FilePath,
        [string[]]$ArgumentList,
        [string]$OutLog,
        [string]$ErrLog
    )
    $params = @{
        FilePath     = $FilePath
        ArgumentList = $ArgumentList
        WorkingDirectory = $Root
        WindowStyle  = "Hidden"
        PassThru     = $true
    }
    if ($OutLog) { $params.RedirectStandardOutput = $OutLog }
    if ($ErrLog) { $params.RedirectStandardError = $ErrLog }
    return Start-Process @params
}

# ============================================================
# 状态查看
# ============================================================
function Show-Status {
    Write-Host ""
    Write-Host "===== Summer Checkin 服务状态 =====" -ForegroundColor Cyan

    # 数据库
    $dbOk = Test-TcpPort "127.0.0.1" $DbPort
    $dbProc = Get-RecordedProcess "db"
    if ($dbOk) {
        Write-Host ("  PostgreSQL      运行中  端口 {0} 已监听" -f $DbPort) -ForegroundColor Green
    } else {
        Write-Host ("  PostgreSQL      已停止  (端口 {0})" -f $DbPort) -ForegroundColor Red
    }

    # WebSocket
    $wsOk = Test-TcpPort "127.0.0.1" $WsPort
    $wsProc = Get-PortProcess -Port $WsPort
    if ($wsOk) {
        $wsInfo = if ($wsProc) { "PID $($wsProc.Id)" } else { "未知进程" }
        Write-Host ("  WebSocket       运行中  端口 {0} 已监听 ({1})" -f $WsPort, $wsInfo) -ForegroundColor Green
    } else {
        Write-Host ("  WebSocket       已停止  (端口 {0})" -f $WsPort) -ForegroundColor Red
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

    # 2. WebSocket
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
            wsl.exe -d $WslDistro -- sh -c "service postgresql stop" 2>$null | Out-Null
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
function Start-Database {
    Write-Log "检查数据库 (PostgreSQL @ $DbPort)..." "Cyan"

    $dbOk = Test-TcpPort "127.0.0.1" $DbPort
    $dbKeeper = Get-RecordedProcess "db"

    if ($dbOk -and $dbKeeper) {
        Write-Log "数据库已在运行（PID $($dbKeeper.Id)），跳过启动" "Green"
        return $true
    }

    if ($dbOk -and -not $dbKeeper) {
        Write-Log "数据库端口已通但无常驻进程，补启动 WSL 常驻以保持 VM 存活..." "Yellow"
    } else {
        Write-Log "启动 WSL 数据库..." "Yellow"
    }

    $dbOut = Join-Path $LogDir "db.log"
    $dbErr = Join-Path $LogDir "db.err.log"

    # 启动常驻进程：启动 postgres 并保持 VM 存活
    $keeper = Start-HiddenProcess `
        -FilePath "wsl.exe" `
        -ArgumentList @("-d", $WslDistro, "--", "sh", "-c", "service postgresql start; exec sleep infinity") `
        -OutLog $dbOut `
        -ErrLog $dbErr

    if (-not $keeper) {
        $msg = "无法启动 WSL 数据库进程，请确认已安装 WSL2 及发行版 '$WslDistro'。"
        Write-Log $msg "Red"
        Show-ErrorBox $msg
        return $false
    }
    Save-Pid "db" $keeper.Id
    Write-Log "数据库常驻进程已启动 (PID $($keeper.Id))" "Gray"

    # 等待就绪
    Write-Log "等待数据库就绪..." "Cyan"
    $deadline = (Get-Date).AddSeconds($DbTimeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-TcpPort "127.0.0.1" $DbPort) {
            Write-Log "数据库就绪。" "Green"
            return $true
        }
        Start-Sleep -Seconds 1
    }
    $msg = "数据库启动超时（$DbTimeout 秒），请查看日志：$dbErr"
    Write-Log $msg "Red"
    Show-ErrorBox $msg
    return $false
}

# ============================================================
# 启动 WebSocket
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
        Start-Sleep -Seconds 1
    }
    $msg = "WebSocket 启动超时（$WsTimeout 秒），请查看日志：$wsErr"
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
        Start-Sleep -Seconds 1
    }
    $msg = "Next.js 启动超时（$WebTimeout 秒），请查看日志：$webErr"
    Write-Log $msg "Red"
    Show-ErrorBox $msg
    return $false
}

# ============================================================
# 主流程
# ============================================================
New-Item -ItemType Directory -Force -Path $PidDir | Out-Null
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

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
Write-Log "========== 开始启动 Summer Checkin ==========" "Cyan"
Write-Log "项目目录：$Root" "Gray"

$ok = $true
$ok = $ok -and (Start-Database)
$ok = $ok -and (Start-WebSocket)
$ok = $ok -and (Start-Web)

if ($ok) {
    Write-Log "========== 全部服务就绪 ==========" "Green"
    if (-not $NoBrowser) {
        Write-Log "正在打开浏览器：$WebUrl" "Cyan"
        Start-Process $WebUrl
    }
} else {
    Write-Log "========== 启动失败，请查看日志 ==========" "Red"
    if ($Hidden) {
        Show-ErrorBox "部分服务启动失败，请查看日志目录：$LogDir"
    }
}
