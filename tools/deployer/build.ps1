# 构建一键部署器（Windows / MinGW-w64 或 MSVC）
#
#   powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1
#
# 产物：dist-deployer/campus-deploy.exe
[CmdletBinding()]
param(
  [string]$Configuration = "Release",
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$buildDir = Join-Path $here "build"
$outDir = Join-Path $root "dist-deployer"

Write-Host "校园作业分析 · 一键部署器 构建" -ForegroundColor Cyan
Write-Host "源码目录: $here"

if ($Clean -and (Test-Path $buildDir)) {
  Remove-Item -Recurse -Force $buildDir
  Write-Host "已清理构建目录" -ForegroundColor DarkGray
}

# 优先使用 CMake；找不到时直接用 g++ 编译
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
$ninja = Get-Command ninja -ErrorAction SilentlyContinue
$gpp = Get-Command g++ -ErrorAction SilentlyContinue

if ($cmake) {
  $generator = if ($ninja) { "Ninja" } else { "MinGW Makefiles" }
  Write-Host "使用 CMake（$generator）构建…" -ForegroundColor Gray
  & $cmake.Source -S $here -B $buildDir -G $generator -DCMAKE_BUILD_TYPE=$Configuration
  if ($LASTEXITCODE -ne 0) { throw "CMake 配置失败" }
  & $cmake.Source --build $buildDir --config $Configuration
  if ($LASTEXITCODE -ne 0) { throw "编译失败" }
} elseif ($gpp) {
  Write-Host "未找到 CMake，直接用 g++ 编译…" -ForegroundColor Gray
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $sources = Get-ChildItem (Join-Path $here "src") -Filter *.cpp | ForEach-Object { $_.FullName }
  & $gpp.Source -std=c++17 -O2 -Wall -Wextra -Wno-unused-parameter `
    -static -static-libgcc -static-libstdc++ `
    -o (Join-Path $outDir "campus-deploy.exe") `
    @sources `
    -lws2_32 -liphlpapi -lshell32 -ladvapi32 -lole32
  if ($LASTEXITCODE -ne 0) { throw "编译失败" }
} else {
  throw "未找到 cmake 或 g++。请安装 MinGW-w64（含 g++）或 Visual Studio 生成工具。"
}

$exe = Join-Path $outDir "campus-deploy.exe"
if (-not (Test-Path $exe)) { throw "未生成可执行文件：$exe" }

Write-Host ""
Write-Host "构建完成：$exe" -ForegroundColor Green
Write-Host ("大小：{0:N0} KB" -f ((Get-Item $exe).Length / 1KB))
Write-Host ""
Write-Host "直接运行试试：" -ForegroundColor Cyan
Write-Host "  `"$exe`"            # 交互式菜单"
Write-Host "  `"$exe`" --web      # 浏览器可视化控制台"
