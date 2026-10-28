@echo off
rem Select TUN or TCP; TUN asks for the host virtual IP.
call "%~dp0launcher\Start-Online.cmd" --join %*
