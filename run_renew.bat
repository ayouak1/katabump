@echo off
title KataBump Python Auto-Renew Test
echo Setting up local Socks5 proxy...
set HTTP_PROXY=socks5://127.0.0.1:20809
set HTTPS_PROXY=socks5://127.0.0.1:20809
echo Running renew_katabump.py...
python renew_katabump.py
pause
