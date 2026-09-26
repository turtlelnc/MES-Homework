cmake_minimum_required(VERSION 3.16)
project(campus-deploy CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

add_executable(campus-deploy
  src/main.cpp
  src/util.cpp
  src/json.cpp
  src/cloudflare.cpp
  src/deploy.cpp
  src/webconsole.cpp
)

# Windows 平台依赖：Winsock、IP 助手、Shell、注册表（注册表在 advapi32 中）
target_link_libraries(campus-deploy PRIVATE ws2_32 iphlpapi shell32 advapi32 ole32)

if(MSVC)
  target_compile_options(campus-deploy PRIVATE /utf-8 /W3)
  target_compile_definitions(campus-deploy PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  target_compile_options(campus-deploy PRIVATE -Wall -Wextra -Wno-unused-parameter -static -static-libgcc -static-libstdc++)
  target_link_options(campus-deploy PRIVATE -static -static-libgcc -static-libstdc++)
endif()

# 输出到项目根的 dist-deployer/，方便直接分发
set_target_properties(campus-deploy PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_SOURCE_DIR}/../../dist-deployer"
)
