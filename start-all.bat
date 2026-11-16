@echo off
rem ============================================================
rem  Summer Checkin 一键启动入口（双击运行）
rem ------------------------------------------------------------
rem  无参数      ：静默启动全部服务（隐藏窗口，不弹终端），
rem                全部就绪后自动打开默认浏览器。
rem  带 -Status  ：查看服务状态（可见窗口）
rem  带 -Stop    ：停止全部服务（可见窗口）
rem  带 -Stop -KeepDb ：停止前后端，保留数据库（可见窗口）
rem
rem  等价于在 PowerShell 中运行：
rem    powershell -ExecutionPolicy Bypass -File start-all.ps1 [参数]
rem
rem  日志目录：.start-all\logs\    PID 文件：.start-all\pids\
rem ============================================================
setlocal
set "args=%*"

if "%args%"=="" (
    rem 无参数：隐藏窗口静默启动（失败会弹窗提示）
    start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-all.ps1" -Hidden
) else (
    rem 带参数：可见窗口运行，便于查看状态 / 停止信息
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
)

endlocal
