cmake_minimum_required(VERSION 3.16)
# Apple 平台需要 Objective-C++（NSVisualEffectView 毛玻璃）；直接放进 project()
# 可避免部分 CMake 版本在 configure 阶段报缺少 CMAKE_OBJCXX_COMPILE_OBJECT。
if(APPLE)
  project(mes-deployer VERSION 0.2.1 LANGUAGES C CXX OBJC OBJCXX)
else()
  project(mes-deployer VERSION 0.2.1 LANGUAGES C CXX)
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_C_STANDARD 11)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(MSVC)
  # 单文件、无 VC++ 运行库依赖：所有目标（含依赖库）统一静态 CRT。
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

option(MES_DEPLOYER_TESTING "Build deployer unit tests" ON)
set(MES_DEPLOYER_DEPS_DIR "" CACHE PATH
  "Optional pre-downloaded dependency source root (glfw/, imgui/, miniz/). Empty = fetch from GitHub.")

file(READ "${CMAKE_CURRENT_SOURCE_DIR}/../../server/version.mjs" MES_RELEASE_SOURCE)
string(REGEX MATCH "APP_VERSION = \"([^\"]+)\"" _version_match "${MES_RELEASE_SOURCE}")
set(MES_VERSION_STRING "${CMAKE_MATCH_1}")
string(REGEX MATCH "BUILD_NUMBER = \"([^\"]+)\"" _build_match "${MES_RELEASE_SOURCE}")
set(MES_BUILD_STRING "${CMAKE_MATCH_1}")
if(NOT MES_VERSION_STRING OR NOT MES_BUILD_STRING)
  message(FATAL_ERROR "Cannot read release identity from server/version.mjs")
endif()

# ---------------------------------------------------------------- dependencies
include(FetchContent)

function(mes_dependency name)
  # Local offline mode: <deps>/<name> exists.
  if(MES_DEPLOYER_DEPS_DIR AND EXISTS "${MES_DEPLOYER_DEPS_DIR}/${name}")
    set(${name}_SOURCE "${MES_DEPLOYER_DEPS_DIR}/${name}" PARENT_SCOPE)
    return()
  endif()
  set(${name}_SOURCE "" PARENT_SCOPE)
endfunction()

mes_dependency(glfw)
mes_dependency(imgui)
mes_dependency(miniz)

set(GLFW_BUILD_DOCS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_WAYLAND OFF CACHE BOOL "" FORCE)
set(GLFW_BUILD_X11 ON CACHE BOOL "" FORCE)
set(GLFW_INSTALL OFF CACHE BOOL "" FORCE)

if(NOT glfw_SOURCE)
  FetchContent_Declare(glfw
    URL https://github.com/glfw/glfw/archive/refs/tags/3.4.tar.gz
    URL_HASH SHA256=c038d34200234d071fae9345bc455e4a8f2f544ab60150765d7704e08f3dac01
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
endif()
if(NOT imgui_SOURCE)
  FetchContent_Declare(imgui
    URL https://github.com/ocornut/imgui/archive/refs/tags/v1.91.9b.tar.gz
    URL_HASH SHA256=8e1bbc76c71d74fef2fb85db7e7ca8eba13d6a86623c54992b60162db554ffdb
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
endif()
if(NOT miniz_SOURCE)
  FetchContent_Declare(miniz
    URL https://github.com/richgel999/miniz/archive/refs/tags/3.0.2.tar.gz
    URL_HASH SHA256=c4b4c25a4eb81883448ff8924e6dba95c800094a198dc9ce66a292ac2ef8e018
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE)
endif()

if(glfw_SOURCE)
  add_subdirectory("${glfw_SOURCE}" glfw-build EXCLUDE_FROM_ALL)
else()
  FetchContent_MakeAvailable(glfw)
endif()
if(NOT imgui_SOURCE)
  FetchContent_Populate(imgui)
  set(imgui_SOURCE "${imgui_SOURCE_DIR}")
endif()
if(NOT miniz_SOURCE)
  FetchContent_Populate(miniz)
  set(miniz_SOURCE "${miniz_SOURCE_DIR}")
endif()

add_library(mes-imgui STATIC
  "${imgui_SOURCE}/imgui.cpp"
  "${imgui_SOURCE}/imgui_draw.cpp"
  "${imgui_SOURCE}/imgui_tables.cpp"
  "${imgui_SOURCE}/imgui_widgets.cpp"
  "${imgui_SOURCE}/backends/imgui_impl_glfw.cpp"
  "${imgui_SOURCE}/backends/imgui_impl_opengl3.cpp")
target_include_directories(mes-imgui PUBLIC "${imgui_SOURCE}" "${imgui_SOURCE}/backends")
target_link_libraries(mes-imgui PUBLIC glfw)

# miniz 3.x 的公开头文件包含由 generate_export_header 生成的 miniz_export.h；
# 我们静态链接，只需一个空导出宏。
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/miniz_export.h"
  "#ifndef MINIZ_EXPORT\n#define MINIZ_EXPORT\n#endif\n")

add_library(mes-miniz STATIC
  "${miniz_SOURCE}/miniz.c"
  "${miniz_SOURCE}/miniz_tdef.c"
  "${miniz_SOURCE}/miniz_tinfl.c"
  "${miniz_SOURCE}/miniz_zip.c")
target_include_directories(mes-miniz PUBLIC "${miniz_SOURCE}" "${CMAKE_CURRENT_BINARY_DIR}")

# --------------------------------------------------------------------- sources
set(MES_DEPLOYER_SOURCES
  src/main.cpp
  src/app.cpp
  src/ui/theme.cpp
  src/ui/widgets.cpp
  src/ui/screens.cpp
  src/core/json.cpp
  src/core/sha256.cpp
  src/core/zip.cpp
  src/core/manifest.cpp
  src/core/config.cpp
  src/core/state.cpp
  src/core/service.cpp
  src/core/engine.cpp
  src/core/self_test.cpp
  src/platform/platform.cpp
)
if(WIN32)
  list(APPEND MES_DEPLOYER_SOURCES
    src/platform/platform_win.cpp src/platform/http_win.cpp src/platform/window_win.cpp)
elseif(APPLE)
  set(CMAKE_OBJCXX_STANDARD 17)
  set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
  list(APPEND MES_DEPLOYER_SOURCES
    src/platform/platform_posix.cpp src/platform/platform_mac.mm
    src/platform/http_posix.cpp src/platform/window_posix.cpp)
else()
  list(APPEND MES_DEPLOYER_SOURCES
    src/platform/platform_posix.cpp src/platform/platform_linux.cpp
    src/platform/http_posix.cpp src/platform/window_posix.cpp)
endif()

add_executable(mes-deployer ${MES_DEPLOYER_SOURCES})
target_include_directories(mes-deployer PRIVATE src)
target_compile_definitions(mes-deployer PRIVATE
  MES_VERSION_STRING="${MES_VERSION_STRING}"
  MES_BUILD_STRING="${MES_BUILD_STRING}"
  GLFW_INCLUDE_NONE)
target_link_libraries(mes-deployer PRIVATE mes-imgui mes-miniz glfw)

if(WIN32)
  # MinGW 与 MSVC 都需要系统 HTTP/DWM/Shell 库；GLFW 的 GL 函数需 opengl32。
  target_link_libraries(mes-deployer PRIVATE opengl32 winhttp dwmapi shlwapi)
elseif(UNIX AND NOT APPLE)
  # main.cpp 直接调用 glViewport/glClear；Linux 需链接系统 libGL。
  find_package(OpenGL REQUIRED)
  target_link_libraries(mes-deployer PRIVATE OpenGL::GL)
endif()

if(WIN32)
  # 桌面应用：不弹控制台窗口；CLI 模式（--version/--self-test/提权子命令）
  # 由 main.cpp 的 AttachConsole 兼容。tests 仍是控制台程序。
  set_target_properties(mes-deployer PROPERTIES WIN32_EXECUTABLE TRUE)
endif()

if(MSVC)
  target_compile_options(mes-deployer PRIVATE /utf-8 /W3 /permissive-)
  target_compile_definitions(mes-deployer PRIVATE _CRT_SECURE_NO_WARNINGS NOMINMAX WIN32_LEAN_AND_MEAN)
  set_property(TARGET mes-deployer PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  target_link_options(mes-deployer PRIVATE /ENTRY:mainCRTStartup)
  target_link_libraries(mes-deployer PRIVATE winhttp dwmapi shell32 ole32 user32 gdi32 advapi32 shlwapi)
elseif(APPLE)
  target_compile_options(mes-deployer PRIVATE -Wall -Wextra -Wno-unused-parameter)
  target_link_libraries(mes-deployer PRIVATE
    "-framework Cocoa" "-framework IOKit" "-framework CoreVideo"
    "-framework OpenGL" "-framework Security" "-framework Foundation")
else()
  target_compile_options(mes-deployer PRIVATE -Wall -Wextra -Wno-unused-parameter)
  target_compile_options(mes-deployer PRIVATE -static-libgcc -static-libstdc++)
  target_link_options(mes-deployer PRIVATE -static-libgcc -static-libstdc++)
  target_link_libraries(mes-deployer PRIVATE dl pthread)
endif()

# ----------------------------------------------------------------------- tests
if(MES_DEPLOYER_TESTING)
  enable_testing()
  add_executable(mes-deployer-test
    tests/core_test.cpp
    src/platform/platform.cpp
    src/core/json.cpp
    src/core/sha256.cpp
    src/core/zip.cpp
    src/core/manifest.cpp
    src/core/config.cpp
    src/core/state.cpp
    src/core/service.cpp
    src/core/self_test.cpp
    src/core/engine.cpp)
  if(WIN32)
    target_sources(mes-deployer-test PRIVATE
      src/platform/platform_win.cpp src/platform/http_win.cpp)
    target_link_libraries(mes-deployer-test PRIVATE winhttp)
  else()
    target_sources(mes-deployer-test PRIVATE
      src/platform/platform_posix.cpp src/platform/http_posix.cpp)
  endif()
  target_include_directories(mes-deployer-test PRIVATE src)
  target_link_libraries(mes-deployer-test PRIVATE mes-miniz)
  target_compile_definitions(mes-deployer-test PRIVATE
    MES_VERSION_STRING="${MES_VERSION_STRING}"
    MES_BUILD_STRING="${MES_BUILD_STRING}")
  if(UNIX)
    target_link_libraries(mes-deployer-test PRIVATE pthread dl)
  endif()
  if(MSVC)
    target_compile_options(mes-deployer-test PRIVATE /utf-8 /W3 /UNDEBUG)
    set_property(TARGET mes-deployer-test PROPERTY MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
  else()
    target_compile_options(mes-deployer-test PRIVATE -Wall -Wextra -Wno-unused-parameter -UNDEBUG)
    if(UNIX AND NOT APPLE)
      target_link_options(mes-deployer-test PRIVATE -static-libgcc -static-libstdc++)
    endif()
  endif()
  add_test(NAME deployer-core COMMAND mes-deployer-test)
  set_tests_properties(deployer-core PROPERTIES TIMEOUT 120)
endif()
