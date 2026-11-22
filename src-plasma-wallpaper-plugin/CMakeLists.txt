cmake_minimum_required(VERSION 3.16)
project(kabegame-plasma-wallpaper LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)

# 插件修订号（仓库根的 REVISION，构建脚本传进来）。QML 模块 URI 与 .so 名随它变：plasmashell 里已注册的 URI 不能再注册，
# 已加载的 .so 卸不掉，升级时靠新名字共存（见 README.md「升级」）。
set(KB_PLUGIN_REVISION "" CACHE STRING "Plugin revision (see REVISION)")
if(NOT KB_PLUGIN_REVISION MATCHES "^[0-9]+$")
    message(FATAL_ERROR "KB_PLUGIN_REVISION must be a positive integer, got '${KB_PLUGIN_REVISION}'")
endif()
set(KB_QML_URI "KabegameWallpaperR${KB_PLUGIN_REVISION}")
# 与 Kabegame 的约定版本（仓库根的 PROTOCOL）：输入消息的 version；节点属性与 metadata.json 用同一个数
set(KB_STREAM_PROTOCOL "" CACHE STRING "Stream / input protocol version (see PROTOCOL)")
if(NOT KB_STREAM_PROTOCOL MATCHES "^[0-9]+$")
    message(FATAL_ERROR "KB_STREAM_PROTOCOL must be a positive integer, got '${KB_STREAM_PROTOCOL}'")
endif()

find_package(Qt6 6.6 REQUIRED COMPONENTS Gui Quick Qml)
find_package(PkgConfig REQUIRED)
pkg_check_modules(PIPEWIRE REQUIRED IMPORTED_TARGET libpipewire-0.3)
# dmabuf 导入（StreamItem）：EGLImage 与 fence。头文件来自 libegl-dev
pkg_check_modules(EGL REQUIRED IMPORTED_TARGET egl)

set(KB_TARGET "kabegamewallpaper_r${KB_PLUGIN_REVISION}")
qt_add_qml_module(${KB_TARGET}
    URI ${KB_QML_URI}
    VERSION 1.0
    PLUGIN_TARGET ${KB_TARGET}
    OUTPUT_DIRECTORY ${CMAKE_CURRENT_BINARY_DIR}/${KB_QML_URI}
    SOURCES
        src/StreamFinder.hpp
        src/StreamFinder.cpp
        src/PointerForwarder.hpp
        src/PointerForwarder.cpp
        src/StreamItem.hpp
        src/StreamItem.cpp
)

# qmltyperegistrations 生成的文件按名字 include 头文件
target_include_directories(${KB_TARGET} PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_link_libraries(${KB_TARGET} PRIVATE Qt6::Gui Qt6::Quick Qt6::Qml PkgConfig::PIPEWIRE PkgConfig::EGL)
target_compile_definitions(${KB_TARGET} PRIVATE KB_STREAM_PROTOCOL=${KB_STREAM_PROTOCOL})
# 只依赖 Qt Core / Gui / Qml / Quick、libpipewire-0.3 与 libEGL（Plasma 6 必有），用不到的库不进 NEEDED
target_link_options(${KB_TARGET} PRIVATE -Wl,--as-needed)
