# 校园作业分析 · 桌面版一键部署器 —— Windows 构建脚本
#
#   powershell -ExecutionPolicy Bypass -File tools/deployer/build.ps1
#
# 产物：dist-deployer/mes-deployer.exe（单文件、无外部运行时依赖）
# 依赖：CMake 3.16+、Ninja 或 Visual Studio、MinGW-w64 g++（任选其一）；
#       GLFW/ImGui/miniz 由 CMake FetchContent 自动下载（离线可用 -DepsDir 指定本地源码）。
[CmdletBinding()]
param(
  [string]$Configuration = "Release",
  [switch]$Clean,
  [switch]$SkipTests,
  [string]$DepsDir = ""
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)
$buildDir = Join-Path $here "build"
$outDir = Join-Path $root "dist-deployer"

Write-Host "校园作业分析 · 桌面部署器 构建" -ForegroundColor Cyan
Write-Host "源码目录: $here"
Write-Host "版本: v0.2.2-rc1 (build26110101)"

if ($Clean -and (Test-Path $buildDir)) {
  Remove-Item -Recurse -Force $buildDir
  Write-Host "已清理构建目录" -ForegroundColor DarkGray
}

$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if (-not $cmake) { throw "未找到 CMake，请先安装 CMake 3.16+。" }
$ninja = Get-Command ninja -ErrorAction SilentlyContinue
$gcc = Get-Command gcc -ErrorAction SilentlyContinue
$gpp = Get-Command g++ -ErrorAction SilentlyContinue

$configureArgs = @(
  "-S", $here,
  "-B", $buildDir,
  "-DCMAKE_BUILD_TYPE=$Configuration",
  "-DMES_DEPLOYER_TESTING=ON"
)
if ($DepsDir) { $configureArgs += "-DMES_DEPLOYER_DEPS_DIR=$DepsDir" }

if ($gpp) {
  $generator = if ($ninja) { "Ninja" } else { "MinGW Makefiles" }
  $cCompiler = if ($gcc) { $gcc.Source } else { $gpp.Source }
  $configureArgs += @("-G", $generator, "-DCMAKE_C_COMPILER=$cCompiler", "-DCMAKE_CXX_COMPILER=$($gpp.Source)")
}

Write-Host "使用 CMake 配置…" -ForegroundColor Gray
& $cmake.Source @configureArgs
if ($LASTEXITCODE -ne 0) { throw "CMake 配置失败" }

Write-Host "编译中…" -ForegroundColor Gray
& $cmake.Source --build $buildDir --config $Configuration --parallel
if ($LASTEXITCODE -ne 0) { throw "编译失败" }

$exe = Get-ChildItem -Path $buildDir -Recurse -Filter "mes-deployer.exe" -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch "mes-deployer-test" } |
  Select-Object -First 1
if (-not $exe) { throw "未找到 mes-deployer.exe" }

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$target = Join-Path $outDir "mes-deployer.exe"
Copy-Item $exe.FullName $target -Force

Write-Host ("构建完成：{0}（{1:N0} KB）" -f $target, ((Get-Item $target).Length / 1KB)) -ForegroundColor Green

if (-not $SkipTests) {
  Write-Host "运行核心自检…" -ForegroundColor Gray
  & $target --self-test
  if ($LASTEXITCODE -ne 0) { throw "核心自检失败" }
  $test = Get-ChildItem -Path $buildDir -Recurse -Filter "mes-deployer-test.exe" -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($test) {
    & $test.FullName
    if ($LASTEXITCODE -ne 0) { throw "单元测试失败" }
  }
  Write-Host "自检与单元测试通过" -ForegroundColor Green
}

Write-Host ""
Write-Host "运行：" -ForegroundColor Cyan
Write-Host "  `"$target`"                 # 桌面 GUI（首次启动选择本地版 / 服务器版）"
Write-Host "  `"$target`" --demo        # 演示模式（不联网、不写入真实目录）"
Write-Host "  `"$target`" --self-test   # 核心自检"
