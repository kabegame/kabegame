#pragma once

#include <QQuickItem>
#include <QString>
#include <QtQml/qqmlregistration.h>

#include <memory>

struct KabegameStreamCore;

// 把 Kabegame 的壁纸节点铺满本 item：自己的 PipeWire 消费端，不用 KPipeWire 的 PipeWireSourceItem。
//
// KPipeWire 6.6 每收到一帧都在渲染线程上销毁上一张 EGLImage、给新帧的 dmabuf 新建一张再绑到同一个纹理上，而且
// 建之前就把缓冲还给了生产端；在 NVIDIA 上持续接 4K 帧约 43 s 后 plasmashell 的 GL 上下文会丢失，Qt 只重建出事的窗口，
// 面板等别的窗口从此不再更新（2026-11-22 实测，见 README「显示」）。这里：
// - 每个 PipeWire 缓冲只导入一次（dmabuf 的 fd 自己 dup 一份），EGLImage 与纹理跟着缓冲走，缓冲移除时才销毁；
// - 正在显示的缓冲不还给生产端，换下来以后插一个 EGL fence，等 GPU 读完再还；
// - 没有 EGL（X11 下 plasmashell 用 GLX，或者 RHI 不是 OpenGL）时只要共享内存，每帧拷进纹理。
// 不可见时把流设为不活动（生产端随之停帧），与 PipeWireSourceItem 相同。
class KabegameStreamItem : public QQuickItem {
    Q_OBJECT
    QML_ELEMENT
    // 节点的 object.serial（StreamFinder 选出的）；0 表示不连
    Q_PROPERTY(uint serial READ serial WRITE setSerial NOTIFY serialChanged)
    // 给日志看的状态：waiting / dmabuf <宽>x<高> … / shm <宽>x<高> / error: …
    Q_PROPERTY(QString status READ status NOTIFY statusChanged)

public:
    explicit KabegameStreamItem(QQuickItem* parent = nullptr);
    ~KabegameStreamItem() override;

    uint serial() const { return m_serial; }
    void setSerial(uint serial);
    QString status() const { return m_status; }

    // PipeWire 线程经队列调用
    Q_INVOKABLE void applyStatus(const QString& status);
    Q_INVOKABLE void reconnect();

public slots:
    // 场景图失效时由 Qt 在渲染线程上调用（约定的槽名）
    void invalidateSceneGraph();

signals:
    void serialChanged();
    void statusChanged();

protected:
    QSGNode* updatePaintNode(QSGNode* oldNode, UpdatePaintNodeData* data) override;
    void releaseResources() override;
    void itemChange(ItemChange change, const ItemChangeData& value) override;

private:
    uint m_serial = 0;
    QString m_status;
    std::shared_ptr<KabegameStreamCore> m_core;
};
