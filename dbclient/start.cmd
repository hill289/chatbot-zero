@echo off
REM GoNavi · PostgreSQL 客户端启动脚本
cd /d "%~dp0"
echo [GoNavi] 正在启动后端...  默认连接 127.0.0.1:5432
echo [GoNavi] 启动后浏览器打开:  http://127.0.0.1:8791/
node server.js
pause
