@echo off
chcp 65001 >nul
setlocal EnableExtensions

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
  echo [错误] 未检测到 claude 命令
  echo.
  echo 请先安装 Claude Code CLI，安装后重新打开本脚本。
  echo   https://docs.anthropic.com/en/docs/claude-code
  echo.
  pause
  exit /b 1
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
