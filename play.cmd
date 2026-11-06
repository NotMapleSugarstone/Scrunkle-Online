@echo off
rem 在本机运行游戏并在浏览器中打开。对代码、文案和
rem 资源的修改会自动出现在已打开的页面中。
rem   play            运行游戏
rem   play online     运行游戏和本地房间服务器，以便在两个浏览器标签页中测试在线对战
setlocal
cd /d "%~dp0"

where npm >nul 2>nul || (
  echo npm was not found. Install it, then run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing the game's dependencies...
  call npm install || goto failed
)

if not exist public\assets\costumes (
  echo The game's images and sounds are missing from public\assets. Run "npm run assets" first.
  pause
  exit /b 1
)

if /i "%~1"=="online" (
  if not exist server\node_modules (
    echo Installing the room server's dependencies...
    call npm --prefix server install || goto failed
  )
  start "Room server" cmd /k npm run worker:dev
)

if not "%~1"=="" if /i not "%~1"=="online" (
  echo Unknown option "%~1". Use: play, or play online.
  pause
  exit /b 1
)

call npm run dev -- --open || goto failed
goto end

:failed
echo.
echo Something went wrong. The messages above say what.
pause
exit /b 1

:end
endlocal
