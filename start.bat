@echo off
chcp 65001 >nul
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo ========================================
echo   DWR 项目工作台
echo ========================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 Node.js
  echo.
  echo 请先安装 Node.js（自带 npm）：
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where npm >nul 2>&1
if errorlevel 1 (
  echo [错误] 未检测到 npm
  echo.
  echo 请确认 Node.js 已正确安装并加入 PATH。
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

where claude >nul 2>&1
if errorlevel 1 (
  echo [提示] 未检测到 claude 命令，将自动安装 Claude Code CLI。
  echo.
  set "PROXY_ADDR="
  set /p PROXY_ADDR=请输入代理地址（不需要代理直接回车，例如 http://127.0.0.1:7890）: 
  echo.
  echo [安装] 正在下载并安装，请稍候...
  echo.
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-claude.ps1" -ProxyAddress "!PROXY_ADDR!"
  if errorlevel 1 (
    echo.
    echo [错误] Claude Code CLI 安装失败，请检查网络或代理后重试。
    echo        也可手动安装：https://docs.anthropic.com/en/docs/claude-code
    echo.
    pause
    exit /b 1
  )
  echo.
  echo [提示] 刷新 PATH 环境变量...
  for /f "delims=" %%P in ('powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"') do set "PATH=%%P"
  where claude >nul 2>&1
  if errorlevel 1 (
    echo.
    echo [错误] 安装脚本已执行，但当前窗口仍未找到 claude 命令。
    echo        请关闭本窗口，重新双击 start.bat 再试。
    echo.
    pause
    exit /b 1
  )
  echo [完成] Claude Code CLI 已就绪。
  echo.
)

if not exist "node_modules\" (
  echo [提示] 首次运行，正在安装依赖（npm install）...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo [错误] 依赖安装失败，请检查网络或 npm 配置。
    echo.
    pause
    exit /b 1
  )
  echo.
  echo [完成] 依赖安装成功。
  echo.
) else (
  echo [提示] 依赖已存在，跳过 npm install。
  echo.
)

echo [启动] 正在启动开发服务...
echo        浏览器将自动打开 http://127.0.0.1:4721
echo        按 Ctrl+C 可停止服务
echo.

call npm run dev

echo.
echo [结束] 服务已停止。
pause
