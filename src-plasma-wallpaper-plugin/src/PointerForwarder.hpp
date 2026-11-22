#pragma once

#include <QObject>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QString>
#include <QtQml/qqmlregistration.h>

class QMouseEvent;

// 把落在壁纸 item 上的鼠标转发给 Kabegame（只收不回的 Unix 数据报 socket；协议见
// src-tauri/kabegame/src/wallpaper/manager/pointer_socket.rs）。在 item 所在窗口（plasmashell 的桌面窗口）上装事件过滤器，
// 只看不吞：桌面图标、右键菜单照常。发不出去就丢，不重试、不读回复。
// 主窗口在哪由 Kabegame 自己问 KWin，这里不用任务管理器模型（TaskManager.TasksModel）取窗口几何（试验时建了它之后
// plasmashell 卡死过，后来查明是 KPipeWire 接流引起的 GL 上下文丢失，与它无关，见 README「显示」）。
class KabegamePointerForwarder : public QObject {
    Q_OBJECT
    QML_ELEMENT
    Q_PROPERTY(QQuickItem* target READ target WRITE setTarget NOTIFY targetChanged)
    Q_PROPERTY(QString inputPath READ inputPath WRITE setInputPath NOTIFY inputPathChanged)
    Q_PROPERTY(int slot READ slot WRITE setSlot NOTIFY slotChanged)

public:
    explicit KabegamePointerForwarder(QObject* parent = nullptr);
    ~KabegamePointerForwarder() override;

    QQuickItem* target() const { return m_target; }
    void setTarget(QQuickItem* target);
    QString inputPath() const { return m_inputPath; }
    void setInputPath(const QString& path);
    int slot() const { return m_slot; }
    void setSlot(int slot);

signals:
    void targetChanged();
    void inputPathChanged();
    void slotChanged();

protected:
    bool eventFilter(QObject* watched, QEvent* event) override;

private:
    enum Kind : quint16 { Move = 1, Button = 2, Leave = 3 };

    void attachWindow(QQuickWindow* window);
    void onMouse(QMouseEvent* event);
    void sendLeave();
    void send(Kind kind, double x, double y, quint32 button, Qt::MouseButtons buttons, double dx = 0, double dy = 0);

    QPointer<QQuickItem> m_target;
    QPointer<QQuickWindow> m_window;
    QString m_inputPath;
    int m_slot = -1;
    int m_fd = -1;
    // 上一条发出的是不是在壁纸范围里（离开只发一次）
    bool m_inside = false;
};
