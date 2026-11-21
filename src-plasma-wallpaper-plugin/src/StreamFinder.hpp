#pragma once

#include <QObject>
#include <QString>
#include <QtQml/qqmlregistration.h>

#include <map>
#include <memory>
#include <mutex>

struct pw_thread_loop;
struct pw_context;
struct pw_core;
struct pw_registry;
struct spa_hook;
struct BoundNode;

// 在默认 PipeWire 上找 Kabegame 的壁纸节点（带 kabegame.wallpaper.protocol 的 Video/Source），按屏选一路：
// kabegame.wallpaper.screen 等于 screenName 的优先，其次 screen 为空的；多个候选（dev 与已安装版都在插件模式）取
// object.serial 最大的。节点消失时 serial 归 0，重新出现时自动接上。
class KabegameStreamFinder : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QString screenName READ screenName WRITE setScreenName NOTIFY screenNameChanged)
    // 选中节点的 object.serial（交给 PipeWireSourceItem.nodeId）；没有时 0
    Q_PROPERTY(uint serial READ serial NOTIFY selectionChanged)
    Q_PROPERTY(QString nodeName READ nodeName NOTIFY selectionChanged)
    // 选中节点的 kabegame.wallpaper.input / kabegame.wallpaper.slot（鼠标转发用）
    Q_PROPERTY(QString inputPath READ inputPath NOTIFY selectionChanged)
    Q_PROPERTY(int slot READ slot NOTIFY selectionChanged)
    // 连不上 PipeWire 时的原因，正常时为 "connected"（只进日志）
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)

public:
    explicit KabegameStreamFinder(QObject* parent = nullptr);
    ~KabegameStreamFinder() override;

    QString screenName() const { return m_screenName; }
    void setScreenName(const QString& name);
    uint serial() const { return m_serial; }
    QString nodeName() const { return m_nodeName; }
    QString inputPath() const { return m_inputPath; }
    int slot() const { return m_slot; }
    QString status() const { return m_status; }

    struct Node {
        uint32_t serial = 0;
        QString name;
        QString screen;
        QString input;
        int slot = -1;
    };

    // PipeWire 线程上的回调
    void onVideoSource(uint32_t id);
    void onNodeInfo(uint32_t id, const Node& node);
    void onGlobalRemove(uint32_t id);

signals:
    void screenNameChanged();
    void selectionChanged();
    void statusChanged();

private:
    void reselect();
    void setStatus(const QString& s);

    QString m_screenName;
    uint m_serial = 0;
    QString m_nodeName;
    QString m_inputPath;
    int m_slot = -1;
    QString m_status;

    std::mutex m_mutex;
    std::map<uint32_t, Node> m_nodes;

    pw_thread_loop* m_loop = nullptr;
    pw_context* m_context = nullptr;
    pw_core* m_core = nullptr;
    pw_registry* m_registry = nullptr;
    spa_hook* m_registryListener = nullptr;
    // registry 的 global 只带白名单属性（没有 kabegame.*），要 bind 节点读 info 才有全部属性；只在 PipeWire 线程上动
    std::map<uint32_t, std::unique_ptr<BoundNode>> m_bound;
};
