import QtQuick
import org.kde.plasma.plasmoid

// 永不改的壳：plasmashell 按 URL 缓存 QML 组件，同一路径的新内容不重启不会生效。真正的内容在带修订号的文件里
// （配置项 Entry，Kabegame 升级插件后改它换文件）。Entry 指的文件不在了（升级时 plasmashell 没在跑、Entry 没来得及改）
// 就退回 content.qml：这时 plasmashell 是新起的，没有旧缓存。
WallpaperItem {
    id: root

    Rectangle {
        anchors.fill: parent
        color: "black"
    }

    Loader {
        id: content
        anchors.fill: parent
        source: root.configuration.Entry || "content.qml"
        onStatusChanged: {
            if (status === Loader.Error && source.toString().indexOf("content.qml") < 0) {
                console.warn("[kabegame-wallpaper] 加载 " + source + " 失败，退回 content.qml");
                source = "content.qml";
            }
        }
    }
}
